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

/** `.llm-wiki/parsed.json` — which PDF/DOCX originals have been converted to markdown, by content hash. */
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
