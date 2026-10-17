import fs from 'node:fs';
import path from 'node:path';
import { LlmWikiError } from '../errors.js';
import { IMAGE_MIMES, type DocumentParser, type ImageInput } from '../llm/types.js';
import { sha256 } from '../search/store.js';
import type { WikiPaths } from '../wiki/layout.js';
import { firstHeading, todayIso, withFrontmatter } from '../wiki/markdown.js';
import { defaultExtractors, documentKind, documentMime, type Extractors } from './extract.js';
import { FetchLedger, ParseLedger } from './ledger.js';
import { parseInstruction, parseSystemPrompt } from './prompts.js';
import { stageSource } from './stage.js';

export interface ParseOptions {
  force: boolean;
  maxTokens: number;
  /** Refuse originals above this many bytes rather than sending a truncated file. */
  maxBytes: number;
  /** PPTX: at most this many distinct slide pictures are sent to the parser model (the rest are listed as not sent). */
  maxImages?: number | undefined;
  /** Replaces some or all of the local extractors (tests). */
  extractors?: Partial<Extractors> | undefined;
  onEvent?: ((msg: string) => void) | undefined;
}

/** Pictures below this size are icons and bullets; they are not sent to the model. */
const MIN_SLIDE_IMAGE_BYTES = 4 * 1024;
/** Larger pictures are not sent (5 MB is the smallest per-image limit among the supported providers). */
const MAX_SLIDE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Image originals above this size are refused (the common per-request inline limit). */
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;

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
 * Converts an original in raw/ (PDF, DOCX, PPTX, XLSX or an image) into a sibling markdown file.
 * PDF, DOCX, PPTX and images go through the dedicated parser LLM; XLSX is converted locally so every
 * number stays exact. The original is never modified; the markdown carries provenance frontmatter.
 * `parser` may be a factory, so converting an XLSX needs no parser settings.
 */
export async function parseDocument(paths: WikiPaths, parser: DocumentParser | (() => DocumentParser), file: string, opts: ParseOptions): Promise<ParseResult> {
  const log = opts.onEvent ?? (() => undefined);
  const extractors: Extractors = { ...defaultExtractors, ...(opts.extractors ?? {}) };
  const originalRel = stageSource(paths, file);
  const abs = path.join(paths.root, originalRel);
  const mimeType = documentMime(abs);
  const kind = documentKind(mimeType);
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
  const notes: string[] = [];
  let body: string;
  let parsedBy: string;

  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    log(`converting ${originalRel} locally (XLSX → markdown tables, no LLM)`);
    const x = await extractors.xlsx(bytes);
    body = `# ${path.basename(abs, path.extname(abs))}\n\nWorkbook with ${x.sheets.length} sheet(s): ${x.sheets.map((s) => `${s.name}${s.hidden ? ' (hidden)' : ''} — ${s.rows} row(s) × ${s.columns} column(s)`).join('; ')}.\n\n${x.markdown}`;
    parsedBy = 'llm-wiki/xlsx-reader';
  } else {
    const llm = typeof parser === 'function' ? parser() : parser;
    const isImage = IMAGE_MIMES.has(mimeType);
    if (isImage && bytes.length > MAX_IMAGE_SOURCE_BYTES) {
      throw new LlmWikiError(`${originalRel} is ${(bytes.length / 1e6).toFixed(1)} MB; images above ${MAX_IMAGE_SOURCE_BYTES / 1e6} MB are not accepted by the model APIs. Save it smaller (JPEG, or a lower resolution).`);
    }
    const native = llm.nativeMimeTypes().has(mimeType);
    let extractedText: string | undefined;
    let images: ImageInput[] | undefined;
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      log(`extracting slides from ${originalRel} locally`);
      const deck = await extractors.pptx(bytes);
      extractedText = deck.text;
      const usable = deck.images.filter((img) => {
        if (img.bytes.length < MIN_SLIDE_IMAGE_BYTES) return false;
        if (img.bytes.length > MAX_SLIDE_IMAGE_BYTES) {
          notes.push(`${img.name} (slide ${img.slides.join(', ')}) was not sent to the model: larger than 5 MB`);
          return false;
        }
        return true;
      });
      const cap = opts.maxImages ?? usable.length;
      for (const img of usable.slice(cap)) notes.push(`${img.name} (slide ${img.slides.join(', ')}) was not sent to the model: over the --max-images limit of ${cap}`);
      images = usable.slice(0, cap).map((img) => ({ label: `${img.name} (slide${img.slides.length > 1 ? 's' : ''} ${img.slides.join(', ')})${img.alt ? ` — alt text: "${img.alt}"` : ''}`, mimeType: img.mimeType, bytes: img.bytes }));
      for (const name of deck.unsupportedImages) notes.push(`${name} was not sent to the model: unsupported picture format`);
      if (extractedText.trim() === '' && images.length === 0) throw new LlmWikiError(`${originalRel} has no slides with text or pictures.`);
      log(`${deck.slides} slide(s), ${images.length} picture(s) sent${notes.length ? `, ${notes.length} not sent` : ''}`);
    } else if (!native) {
      if (isImage) throw new LlmWikiError(`${llm.provider} cannot read images; use a parser provider whose model has vision.`);
      log(`extracting text from ${originalRel} locally (${llm.provider} cannot read ${mimeType} natively)`);
      extractedText = mimeType === 'application/pdf' ? await extractors.pdf(bytes) : await extractors.docx(bytes);
      if (extractedText.trim() === '') throw new LlmWikiError(`No text could be extracted from ${originalRel}; it may be a scanned image. Use a parser provider with native PDF support (anthropic, gemini, openai, azure-openai, litellm).`);
    }
    const how = isImage ? 'image' : extractedText !== undefined ? `extracted ${kind === 'PPTX' ? 'slides' : 'text'}${images?.length ? ` + ${images.length} picture(s)` : ''}` : 'native document';
    log(`asking ${llm.provider}/${llm.model} to convert ${originalRel} to markdown (${how})`);
    const reply = await llm.parseDocument({
      system: parseSystemPrompt(),
      instruction: parseInstruction(filename, mimeType),
      document: { filename, mimeType, bytes },
      extractedText,
      images,
      maxTokens: opts.maxTokens,
    });
    body = unwrapMarkdownFence(reply);
    if (body === '') throw new LlmWikiError(`${llm.provider}/${llm.model} returned an empty conversion for ${originalRel}.`);
    parsedBy = `${llm.provider}/${llm.model}`;
  }

  const hash = sha256(bytes);
  const today = todayIso();
  const title = firstHeading(body) ?? path.basename(abs, path.extname(abs));
  const what = IMAGE_MIMES.has(mimeType) ? `${kind} image` : `${kind} document`;
  const by = parsedBy === 'llm-wiki/xlsx-reader' ? 'by llm-wiki locally (no LLM; cell values as stored, formulas as their last calculated value, or as the formula when the file holds none)' : `by ${parsedBy}`;
  const provenance = `> **Converted from the original ${what} [[${originalRel}]]** (${(bytes.length / 1024).toFixed(0)} KB, sha256 ${hash.slice(0, 12)}…) ${by} on ${today}. The original is kept unmodified in \`raw/\`; this markdown is the version the wiki reads and cites.${notes.length ? `\n>\n> Not converted: ${notes.join('; ')}.` : ''}`;
  if (notes.length) log(`not converted: ${notes.join('; ')}`);
  const fetched = new FetchLedger(paths).get(originalRel);
  const content = withFrontmatter(
    {
      title,
      ...(fetched ? { url: fetched.finalUrl } : {}),
      original: originalRel,
      original_type: kind,
      original_sha256: hash,
      parsed_by: parsedBy,
      parsed_at: today,
    },
    `${provenance}\n\n${body}\n`,
  );
  fs.writeFileSync(mdAbs, content);
  ledger.record(originalRel, bytes, markdownRel, parsedBy);
  log(`wrote ${markdownRel}`);
  return { originalRel, markdownRel, skipped: false };
}
