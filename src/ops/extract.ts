import path from 'node:path';
import mammoth from 'mammoth';
import type { DocumentMime } from '../llm/types.js';
import { LlmWikiError } from '../errors.js';

export const DOCUMENT_MIME: Record<string, DocumentMime> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** True for originals that need the parser LLM (PDF, DOCX). */
export function isParsableDocument(file: string): boolean {
  return path.extname(file).toLowerCase() in DOCUMENT_MIME;
}

export function documentMime(file: string): DocumentMime {
  const mime = DOCUMENT_MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new LlmWikiError(`${file} is not a supported document type (supported: .pdf, .docx).`);
  return mime;
}

export interface Extractors {
  pdf: (bytes: Buffer) => Promise<string>;
  docx: (bytes: Buffer) => Promise<string>;
}

/** Text of every page, separated by page markers, via pdf.js (no rendering, no native deps). */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    pages.push(`<!-- page ${i} -->\n${text.trim()}`);
  }
  await task.destroy();
  return pages.join('\n\n');
}

/** HTML from mammoth: keeps headings, lists and tables so the parser LLM can produce faithful markdown. */
export async function extractDocxHtml(bytes: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: bytes });
  return result.value;
}

export const defaultExtractors: Extractors = { pdf: extractPdfText, docx: extractDocxHtml };
