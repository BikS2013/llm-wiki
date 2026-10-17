import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../search/store.js';
import type { WikiPaths } from '../wiki/layout.js';

export interface IngestRecord {
  hash: string;
  ingestedAt: string;
  summaryPage: string;
  touched: string[];
}

interface LedgerFile {
  version: 1;
  sources: Record<string, IngestRecord>;
}

/** `.llm-wiki/ingested.json` — which raw sources have been compiled into the wiki, by content hash. */
export class IngestLedger {
  private readonly file: string;
  private data: LedgerFile;

  constructor(private readonly paths: WikiPaths) {
    this.file = path.join(paths.state, 'ingested.json');
    this.data = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as LedgerFile) : { version: 1, sources: {} };
  }

  get(rel: string): IngestRecord | undefined {
    return this.data.sources[rel];
  }

  isIngested(rel: string, content: Buffer | string): boolean {
    const rec = this.data.sources[rel];
    return rec !== undefined && rec.hash === sha256(content);
  }

  record(rel: string, content: Buffer | string, summaryPage: string, touched: string[]): void {
    this.data.sources[rel] = { hash: sha256(content), ingestedAt: new Date().toISOString(), summaryPage, touched };
    fs.mkdirSync(this.paths.state, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  all(): Record<string, IngestRecord> {
    return this.data.sources;
  }
}

export interface ParseRecord {
  hash: string;
  parsedAt: string;
  markdown: string;
  parsedBy: string;
}

interface ParseLedgerFile {
  version: 1;
  originals: Record<string, ParseRecord>;
}

/** `.llm-wiki/parsed.json` — which originals (PDF, DOCX, PPTX, XLSX, images) have been converted to markdown, by content hash. */
export class ParseLedger {
  private readonly file: string;
  private data: ParseLedgerFile;

  constructor(private readonly paths: WikiPaths) {
    this.file = path.join(paths.state, 'parsed.json');
    this.data = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as ParseLedgerFile) : { version: 1, originals: {} };
  }

  get(rel: string): ParseRecord | undefined {
    return this.data.originals[rel];
  }

  isCurrent(rel: string, content: Buffer | string): boolean {
    const rec = this.data.originals[rel];
    return rec !== undefined && rec.hash === sha256(content);
  }

  record(rel: string, content: Buffer | string, markdown: string, parsedBy: string): void {
    this.data.originals[rel] = { hash: sha256(content), parsedAt: new Date().toISOString(), markdown, parsedBy };
    fs.mkdirSync(this.paths.state, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

export interface FetchRecord {
  url: string;
  finalUrl: string;
  contentType: string;
  fetchedAt: string;
  /** sha256 of what the change check compares: a web page's readable text, otherwise the bytes. */
  contentHash?: string | undefined;
  etag?: string | undefined;
  lastModified?: string | undefined;
  /** True when the page needed JavaScript and was printed to PDF with a headless browser. */
  rendered?: boolean | undefined;
}

/** `.llm-wiki/fetched.json` — where originals downloaded with `ingest <url>` / `parse <url>` came from. */
export class FetchLedger {
  private readonly file: string;
  private data: { version: 1; originals: Record<string, FetchRecord> };

  constructor(private readonly paths: WikiPaths) {
    this.file = path.join(paths.state, 'fetched.json');
    this.data = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as typeof this.data) : { version: 1, originals: {} };
  }

  get(rel: string): FetchRecord | undefined {
    return this.data.originals[rel];
  }

  /** The most recent download of a URL: `[rawRel, record]`. */
  latest(url: string): [string, FetchRecord] | undefined {
    return Object.entries(this.data.originals)
      .filter(([, r]) => r.url === url)
      .sort((a, b) => a[1].fetchedAt.localeCompare(b[1].fetchedAt))
      .at(-1);
  }

  /** Every URL with its latest download. */
  urls(): Array<[string, FetchRecord]> {
    const seen = new Set<string>();
    const out: Array<[string, FetchRecord]> = [];
    for (const [rel, r] of Object.entries(this.data.originals).sort((a, b) => b[1].fetchedAt.localeCompare(a[1].fetchedAt))) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push([rel, r]);
    }
    return out;
  }

  record(rel: string, rec: Omit<FetchRecord, 'fetchedAt'>): void {
    this.data.originals[rel] = { ...rec, fetchedAt: new Date().toISOString() };
    fs.mkdirSync(this.paths.state, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

export interface OriginRecord {
  /** Absolute path of the file outside the wiki the raw copy was made from. */
  origin: string;
  hash: string;
  stagedAt: string;
}

/** `.llm-wiki/origins.json` — raw copies of files that live outside the wiki, so their changes can be detected. */
export class OriginLedger {
  private readonly file: string;
  private data: { version: 1; copies: Record<string, OriginRecord> };

  constructor(private readonly paths: WikiPaths) {
    this.file = path.join(paths.state, 'origins.json');
    this.data = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as typeof this.data) : { version: 1, copies: {} };
  }

  get(rel: string): OriginRecord | undefined {
    return this.data.copies[rel];
  }

  /** Every outside file with its latest raw copy. */
  origins(): Array<[string, OriginRecord]> {
    const seen = new Set<string>();
    const out: Array<[string, OriginRecord]> = [];
    for (const [rel, r] of Object.entries(this.data.copies).sort((a, b) => b[1].stagedAt.localeCompare(a[1].stagedAt))) {
      if (seen.has(r.origin)) continue;
      seen.add(r.origin);
      out.push([rel, r]);
    }
    return out;
  }

  record(rel: string, origin: string, content: Buffer): void {
    this.data.copies[rel] = { origin, hash: sha256(content), stagedAt: new Date().toISOString() };
    fs.mkdirSync(this.paths.state, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
