import { Bm25Index } from './bm25.js';
import { rrf, vectorSearch } from './vector.js';
import { EmbeddingStore, SearchStore, type Chunk, type Layer } from './store.js';
import type { EmbeddingClient } from '../llm/types.js';
import { LlmWikiError } from '../errors.js';

export type SearchMode = 'bm25' | 'vector' | 'hybrid';

export interface SearchOptions {
  mode: SearchMode;
  limit: number;
  layer: Layer | 'all';
  /** Required for `vector` and `hybrid`. */
  embedder?: { client: EmbeddingClient; store: EmbeddingStore } | undefined;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
  snippet: string;
}

function snippetFor(chunk: Chunk, query: string, width = 220): string {
  const text = chunk.text.replace(/\s+/g, ' ');
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(width / 3));
  const s = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${s}${start + width < text.length ? '…' : ''}`;
}

/** Runs BM25, vector, or RRF-fused hybrid search over the persisted chunk index. */
export async function search(store: SearchStore, query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const chunks = store.chunks.filter((c) => opts.layer === 'all' || c.layer === opts.layer);
  if (chunks.length === 0) return [];
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const candidates = Math.max(opts.limit * 4, 20);
  const rankings: string[][] = [];
  const scores = new Map<string, number>();

  if (opts.mode === 'bm25' || opts.mode === 'hybrid') {
    const bm25 = new Bm25Index(chunks.map((c) => ({ id: c.id, text: `${c.title}\n${c.heading}\n${c.text}` })));
    const hits = bm25.search(query, candidates);
    rankings.push(hits.map((h) => h.id));
    for (const h of hits) scores.set(h.id, h.score);
  }
  if (opts.mode === 'vector' || opts.mode === 'hybrid') {
    if (!opts.embedder) throw new LlmWikiError(`Search mode "${opts.mode}" needs an embedding provider (LLM_WIKI_EMBEDDING_PROVIDER / LLM_WIKI_EMBEDDING_MODEL).`);
    const vectors = new Map<string, number[]>();
    let missing = 0;
    for (const c of chunks) {
      const v = opts.embedder.store.get(c.hash);
      if (v) vectors.set(c.id, v);
      else missing++;
    }
    if (vectors.size === 0) throw new LlmWikiError('No embeddings are stored yet. Run `llm-wiki index --embed` first.');
    if (missing > 0) process.stderr.write(`warning: ${missing} chunk(s) have no embedding yet; run \`llm-wiki index --embed\`.\n`);
    const [qv] = await opts.embedder.client.embed([query]);
    if (!qv) throw new LlmWikiError('Embedding provider returned no vector for the query.');
    const hits = vectorSearch(qv, vectors, candidates);
    rankings.push(hits.map((h) => h.id));
    for (const h of hits) scores.set(h.id, Math.max(scores.get(h.id) ?? 0, h.score));
  }

  const ranked = opts.mode === 'hybrid' ? rrf(rankings) : rankings[0]!.map((id) => ({ id, score: scores.get(id) ?? 0 }));
  return ranked.slice(0, opts.limit).flatMap(({ id, score }) => {
    const chunk = byId.get(id);
    return chunk ? [{ chunk, score, snippet: snippetFor(chunk, query) }] : [];
  });
}

/** Computes and stores embeddings for chunks that lack them. Returns how many were embedded. */
export async function embedMissing(
  store: SearchStore,
  embedStore: EmbeddingStore,
  client: EmbeddingClient,
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 32;
  const todo = embedStore.missing(store.chunks);
  const seen = new Set<string>();
  const unique = todo.filter((c) => (seen.has(c.hash) ? false : (seen.add(c.hash), true)));
  let done = 0;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const vectors = await client.embed(batch.map((c) => `${c.title}\n${c.heading}\n${c.text}`));
    if (vectors.length !== batch.length) throw new LlmWikiError(`Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs.`);
    batch.forEach((c, j) => embedStore.set(c.hash, vectors[j]!));
    done += batch.length;
    opts.onProgress?.(done, unique.length);
    embedStore.save();
  }
  embedStore.prune(store.chunks);
  embedStore.save();
  return done;
}
