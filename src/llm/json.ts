import { LlmError } from '../errors.js';
import type { ChatClient, ChatRequest } from './types.js';

/**
 * Escapes raw control characters (newlines, tabs, ...) that appear inside JSON string literals — a
 * common model slip that JSON.parse rejects. Characters outside strings and valid escapes are untouched.
 */
export function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < ' ') {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Pulls the first JSON object out of a model reply that may be wrapped in prose or code fences. */
export function extractJson<T>(text: string, validate: (v: unknown) => v is T): T {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) candidates.push(m[1]!.trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text.trim());
  let lastError: unknown;
  for (const c of candidates) {
    for (const attempt of [c, escapeControlCharsInStrings(c)]) {
      try {
        const parsed: unknown = JSON.parse(attempt);
        if (validate(parsed)) return parsed;
        lastError = new Error('JSON did not match the expected shape');
        break;
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw new LlmError(`The model reply did not contain the expected JSON (${lastError instanceof Error ? lastError.message : String(lastError)}). Reply started with: ${text.slice(0, 300)}`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Asks for a JSON reply (JSON mode where the provider has one) and parses it. When the reply is not
 * valid JSON of the expected shape, asks once more, quoting the parse error, before giving up.
 */
export async function chatJson<T>(llm: ChatClient, req: Omit<ChatRequest, 'json'>, validate: (v: unknown) => v is T, onEvent: (msg: string) => void = () => undefined): Promise<T> {
  const reply = await llm.chat({ ...req, json: true });
  try {
    return extractJson(reply, validate);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    const reason = e.message.replace(/ Reply started with:[\s\S]*$/, '');
    onEvent(`the reply was not valid JSON (${reason}); asking ${llm.provider}/${llm.model} once more`);
    const retry = await llm.chat({
      ...req,
      json: true,
      user: `${req.user}\n\nYour previous reply could not be used: ${reason}. Reply again with the complete JSON object only. Escape every double quote inside string values as \\" (HTML attributes included) and every newline as \\n.`,
    });
    return extractJson(retry, validate);
  }
}
