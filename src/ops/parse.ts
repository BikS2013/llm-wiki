import fs from 'node:fs';
import path from 'node:path';
import { LlmWikiError } from '../errors.js';
import type { DocumentParser } from '../llm/types.js';
import { sha256 } from '../search/store.js';
import type { WikiPaths } from '../wiki/layout.js';
import { firstHeading, todayIso, withFrontmatter } from '../wiki/markdown.js';
import { defaultExtractors, documentMime, type Extractors } from './extract.js';
import { ParseLedger } from './ledger.js';
import { parseInstruction, parseSystemPrompt } from './prompts.js';
import { stageSource } from './stage.js';

export interface ParseOptions {
  force: boolean;
  maxTokens: number;
  /** Refuse originals above this many bytes rather than sending a truncated file. */
  maxBytes: number;
  extractors?: Extractors | undefined;
  onEvent?: ((msg: string) => void) | undefined;
}

export interface ParseResult {
  originalRel: string;
  markdownRel: string;
  skipped: boolean;
}

/** `raw/report.pdf` → `raw/report.pdf.md` (keeps the extension so PDF and DOCX siblings never collide). */
export function markdownPathFor(originalRel: string): string {
  return `${originalRel}.md`;
}

/** Strips a ```markdown fence when the model wrapped the whole reply in one. */
export function unwrapMarkdownFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return (m ? m[1]! : text).trim();
}

/**
 * Converts a PDF/DOCX original in raw/ into a sibling markdown file using the dedicated parser LLM.
 * The original is never modified; the markdown carries provenance frontmatter pointing back to it.
 */
export async function parseDocument(paths: WikiPaths, parser: DocumentParser, file: string, opts: ParseOptions): Promise<ParseResult> {
  const log = opts.onEvent ?? (() => undefined);
  const extractors = opts.extractors ?? defaultExtractors;
  const originalRel = stageSource(paths, file);
  const abs = path.join(paths.root, originalRel);
  const mimeType = documentMime(abs);
  const bytes = fs.readFileSync(abs);
  const markdownRel = markdownPathFor(originalRel);
  const mdAbs = path.join(paths.root, markdownRel);
  const ledger = new ParseLedger(paths);

  if (!opts.force && fs.existsSync(mdAbs) && ledger.isCurrent(originalRel, bytes)) {
    log(`skip parse ${originalRel}: ${markdownRel} is up to date (use --reparse to redo)`);
    return { originalRel, markdownRel, skipped: true };
  }
  if (fs.existsSync(mdAbs) && !ledger.get(originalRel)) {
    throw new LlmWikiError(`${markdownRel} already exists but was not produced by llm-wiki; move it aside before parsing ${originalRel}.`);
  }
  if (bytes.length > opts.maxBytes) {
    throw new LlmWikiError(`${originalRel} is ${(bytes.length / 1e6).toFixed(1)} MB, above the --max-bytes limit of ${(opts.maxBytes / 1e6).toFixed(1)} MB. Split the document; the tool never truncates originals.`);
  }

  const filename = path.basename(abs);
  const native = parser.nativeMimeTypes().has(mimeType);
  let extractedText: string | undefined;
  if (!native) {
    log(`extracting text from ${originalRel} locally (${parser.provider} cannot read ${mimeType} natively)`);
    extractedText = mimeType === 'application/pdf' ? await extractors.pdf(bytes) : await extractors.docx(bytes);
    if (extractedText.trim() === '') throw new LlmWikiError(`No text could be extracted from ${originalRel}; it may be a scanned image. Use a parser provider with native PDF support (anthropic, gemini, openai, azure-openai, litellm).`);
  }
  log(`asking ${parser.provider}/${parser.model} to convert ${originalRel} to markdown (${native ? 'native document' : 'extracted text'})`);
  const reply = await parser.parseDocument({
    system: parseSystemPrompt(),
    instruction: parseInstruction(filename, mimeType),
    document: { filename, mimeType, bytes },
    extractedText,
    maxTokens: opts.maxTokens,
  });
  const body = unwrapMarkdownFence(reply);
  if (body === '') throw new LlmWikiError(`${parser.provider}/${parser.model} returned an empty conversion for ${originalRel}.`);

  const hash = sha256(bytes);
  const kind = mimeType === 'application/pdf' ? 'PDF' : 'DOCX';
  const today = todayIso();
  const title = firstHeading(body) ?? path.basename(abs, path.extname(abs));
  const provenance = `> **Converted from the original ${kind} document [[${originalRel}]]** (${(bytes.length / 1024).toFixed(0)} KB, sha256 ${hash.slice(0, 12)}…) by ${parser.provider}/${parser.model} on ${today}. The original is kept unmodified in \`raw/\`; this markdown is the version the wiki reads and cites.`;
  const content = withFrontmatter(
    {
      title,
      original: originalRel,
      original_type: kind,
      original_sha256: hash,
      parsed_by: `${parser.provider}/${parser.model}`,
      parsed_at: today,
    },
    `${provenance}\n\n${body}\n`,
  );
  fs.writeFileSync(mdAbs, content);
  ledger.record(originalRel, bytes, markdownRel, `${parser.provider}/${parser.model}`);
  log(`wrote ${markdownRel}`);
  return { originalRel, markdownRel, skipped: false };
}
