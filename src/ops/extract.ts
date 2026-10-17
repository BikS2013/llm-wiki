import path from 'node:path';
import mammoth from 'mammoth';
import type { DocumentMime } from '../llm/types.js';
import { LlmWikiError } from '../errors.js';
import { extractPptx, extractXlsx, type PptxExtract, type XlsxExtract } from './office.js';

export const DOCUMENT_MIME: Record<string, DocumentMime> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Short label of a document kind, used in provenance: PDF, DOCX, PPTX, XLSX, PNG, JPEG, ... */
export function documentKind(mime: DocumentMime): string {
  const labels: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  };
  return labels[mime] ?? mime.replace('image/', '').toUpperCase();
}

/** Formats refused with a hint, instead of being ignored. */
const UNSUPPORTED: Record<string, string> = {
  '.doc': 'save it as .docx (or PDF)',
  '.ppt': 'save it as .pptx (or PDF)',
  '.xls': 'save it as .xlsx (or CSV)',
  '.xlsm': 'save it as .xlsx (macros are not read)',
  '.key': 'export it to .pptx or PDF',
  '.numbers': 'export it to .xlsx or CSV',
  '.pages': 'export it to .docx or PDF',
  '.heic': 'convert it to JPEG or PNG',
  '.heif': 'convert it to JPEG or PNG',
  '.tif': 'convert it to PNG',
  '.tiff': 'convert it to PNG',
  '.bmp': 'convert it to PNG',
  '.svg': 'export it to PNG',
};

/** A hint when the file is a known but unsupported format, else undefined. */
export function unsupportedHint(file: string): string | undefined {
  return UNSUPPORTED[path.extname(file).toLowerCase()];
}

/** True for originals converted to `raw/<file>.md` before ingest: PDF, DOCX, PPTX, XLSX and images. */
export function isParsableDocument(file: string): boolean {
  return path.extname(file).toLowerCase() in DOCUMENT_MIME;
}

/** True when the conversion needs the parser LLM (everything except XLSX, which is converted locally). */
export function needsParserLlm(file: string): boolean {
  return isParsableDocument(file) && path.extname(file).toLowerCase() !== '.xlsx';
}

export function documentMime(file: string): DocumentMime {
  const mime = DOCUMENT_MIME[path.extname(file).toLowerCase()];
  if (!mime) {
    const hint = unsupportedHint(file);
    throw new LlmWikiError(`${file} is not a supported document type${hint ? ` — ${hint}` : ''} (supported: .pdf .docx .pptx .xlsx .png .jpg .jpeg .gif .webp).`);
  }
  return mime;
}

export interface Extractors {
  pdf: (bytes: Buffer) => Promise<string>;
  docx: (bytes: Buffer) => Promise<string>;
  pptx: (bytes: Buffer) => Promise<PptxExtract>;
  xlsx: (bytes: Buffer) => Promise<XlsxExtract>;
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

export const defaultExtractors: Extractors = { pdf: extractPdfText, docx: extractDocxHtml, pptx: (b) => extractPptx(b), xlsx: (b) => extractXlsx(b) };
