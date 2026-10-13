import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chunkSections, parseFrontmatter, splitSections } from '../wiki/markdown.js';
import { listPages, listRawFiles, type WikiPaths } from '../wiki/layout.js';

export type Layer = 'wiki' | 'raw';

export interface Chunk {
  id: string;
  /** Path relative to the wiki root, e.g. `wiki/entities/foo.md` or `raw/article.md`. */
  file: string;
  layer: Layer;
  title: string;
  heading: string;
  text: string;
  /** sha256 of `title + heading + text`; embeddings are cached by this hash. */
  hash: string;
}

interface IndexFile {
  version: 1;
  files: Record<string, { hash: string; chunkIds: string[] }>;
  chunks: Chunk[];
}

interface EmbeddingFile {
  version: 1;
  provider: string;
  model: string;
  vectors: Record<string, number[]>;
}

const INDEX_NAME = 'search-index.json';
const EMBED_NAME = 'embeddings.json';
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.csv', '.json', '.html', '.htm', '.rst', '.org']);

export function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function isTextSource(file: string): boolean {
  return TEXT_EXT.has(path.extname(file).toLowerCase());
}

function chunkFile(rel: string, layer: Layer, title: string, body: string): Chunk[] {
  const sections = chunkSections(splitSections(body));
  return sections.map((s, i) => {
    const hash = sha256(`${title}\n${s.heading}\n${s.text}`);
    return { id: `${rel}#${i}`, file: rel, layer, title, heading: s.heading, text: s.text, hash };
  });
}

export interface ReindexResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  chunks: number;
}

/** Persisted chunk index under `.llm-wiki/`, rebuilt incrementally by file hash. */
export class SearchStore {
  private data: IndexFile;
  private readonly file: string;

  constructor(private readonly paths: WikiPaths) {
    this.file = path.join(paths.state, INDEX_NAME);
    this.data = fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as IndexFile)
      : { version: 1, files: {}, chunks: [] };
  }

  get chunks(): Chunk[] {
    return this.data.chunks;
  }

  chunk(id: string): Chunk | undefined {
    return this.data.chunks.find((c) => c.id === id);
  }

  /** Re-chunks changed files, drops deleted ones, keeps the rest. */
  reindex(opts: { includeRaw: boolean }): ReindexResult {
    const seen = new Set<string>();
    const result: ReindexResult = { added: 0, updated: 0, removed: 0, unchanged: 0, chunks: 0 };
    const nextFiles: IndexFile['files'] = {};
    let nextChunks: Chunk[] = [];

    const consider = (rel: string, layer: Layer, read: () => { title: string; body: string }, contentHash: string) => {
      seen.add(rel);
      const prev = this.data.files[rel];
      if (prev && prev.hash === contentHash) {
        nextFiles[rel] = prev;
        nextChunks = nextChunks.concat(this.data.chunks.filter((c) => c.file === rel));
        result.unchanged++;
        return;
      }
      const { title, body } = read();
      const chunks = chunkFile(rel, layer, title, body);
      nextFiles[rel] = { hash: contentHash, chunkIds: chunks.map((c) => c.id) };
      nextChunks = nextChunks.concat(chunks);
      if (prev) result.updated++;
      else result.added++;
    };

    for (const page of listPages(this.paths)) {
      consider(page.relPath, 'wiki', () => ({ title: page.title, body: page.body }), sha256(page.raw));
    }
    if (opts.includeRaw) {
      for (const abs of listRawFiles(this.paths)) {
        if (!isTextSource(abs)) continue;
        const rel = this.paths.relToRoot(abs);
        const raw = fs.readFileSync(abs, 'utf8');
        consider(
          rel,
          'raw',
          () => {
            const { frontmatter, body } = parseFrontmatter(raw);
            const title = typeof frontmatter.title === 'string' ? frontmatter.title : path.basename(abs, path.extname(abs));
            return { title, body };
          },
          sha256(raw),
        );
      }
    }
    for (const rel of Object.keys(this.data.files)) if (!seen.has(rel)) result.removed++;
    this.data = { version: 1, files: nextFiles, chunks: nextChunks };
    result.chunks = nextChunks.length;
    this.save();
    return result;
  }

  save(): void {
    fs.mkdirSync(this.paths.state, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

/** Embedding cache keyed by chunk hash, invalidated when provider or model changes. */
export class EmbeddingStore {
  private data: EmbeddingFile;
  private readonly file: string;

  constructor(private readonly paths: WikiPaths, provider: string, model: string) {
    this.file = path.join(paths.state, EMBED_NAME);
    const existing = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as EmbeddingFile) : undefined;
    this.data =
      existing && existing.provider === provider && existing.model === model
        ? existing
        : { version: 1, provider, model, vectors: {} };
  }

  get(hash: string): number[] | undefined {
    return this.data.vectors[hash];
  }

  missing(chunks: Chunk[]): Chunk[] {
    return chunks.filter((c) => this.data.vectors[c.hash] === undefined);
  }

  set(hash: string, vector: number[]): void {
    this.data.vectors[hash] = vector;
  }

  /** Drops vectors no longer referenced by any chunk. */
  prune(chunks: Chunk[]): number {
    const keep = new Set(chunks.map((c) => c.hash));
    let dropped = 0;
    for (const hash of Object.keys(this.data.vectors)) {
      if (!keep.has(hash)) {
        delete this.data.vectors[hash];
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return Object.keys(this.data.vectors).length;
  }

  save(): void {
    fs.mkdirSync(this.paths.state, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}
