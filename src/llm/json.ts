import { LlmError } from '../errors.js';

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
    try {
      const parsed: unknown = JSON.parse(c);
      if (validate(parsed)) return parsed;
      lastError = new Error('JSON did not match the expected shape');
    } catch (e) {
      lastError = e;
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
