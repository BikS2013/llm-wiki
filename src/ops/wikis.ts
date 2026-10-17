import fs from 'node:fs';
import type { Config } from '../config/env.js';
import { search, type SearchHit, type SearchMode } from '../search/search.js';
import { SearchStore } from '../search/store.js';
import { rrf } from '../search/vector.js';
import { listPages, WikiPaths } from '../wiki/layout.js';
import { readLog } from '../wiki/log.js';
import type { WikiEntry } from '../wiki/registry.js';
import { searchEmbedder } from './context.js';
import { pendingSources } from './ingest.js';

export interface WikiStatus {
  name: string;
  root: string;
  description?: string;
  /** False when the root no longer exists or is no longer an initialised wiki. */
  healthy: boolean;
  problem?: string;
  /** Page format of the wiki: markdown or html. */
  format?: string;
  pages?: number;
  pending?: number;
  lastActivity?: string;
}

/** Cheap, read-only status of a registered wiki (page count, pending sources, last log entry). */
export function wikiStatus(entry: WikiEntry): WikiStatus {
  const base = { name: entry.name, root: entry.root, ...(entry.description ? { description: entry.description } : {}) };
  const paths = new WikiPaths(entry.root);
  try {
    paths.assertInitialised();
  } catch (err) {
    return { ...base, healthy: false, problem: fs.existsSync(entry.root) ? (err as Error).message : `${entry.root} does not exist` };
  }
  try {
    const last = readLog(paths).at(-1);
    return {
      ...base,
      healthy: true,
      format: paths.format.name,
      pages: listPages(paths).filter((p) => p.type !== 'lint').length,
      pending: pendingSources(paths).length,
      ...(last ? { lastActivity: `${last.date} ${last.kind} | ${last.title}` } : {}),
    };
  } catch (err) {
    return { ...base, healthy: false, problem: (err as Error).message };
  }
}

export interface WikiSearchHit extends SearchHit {
  wiki: string;
}

/**
 * Searches several wikis and merges the results. Each wiki is ranked on its own index; with more
 * than one wiki the rankings are fused with reciprocal-rank fusion, since raw BM25 scores from
 * different corpora are not comparable.
 */
export async function searchWikis(
  config: Config,
  wikis: Array<{ name: string; paths: WikiPaths }>,
  query: string,
  opts: { mode: SearchMode; limit: number; layer: 'wiki' | 'raw' | 'all' },
): Promise<WikiSearchHit[]> {
  const perWiki: WikiSearchHit[][] = [];
  for (const w of wikis) {
    const store = new SearchStore(w.paths);
    store.reindex({ includeRaw: opts.layer !== 'wiki' });
    const embedder = opts.mode === 'bm25' ? undefined : searchEmbedder(config, w.paths);
    const hits = await search(store, query, { mode: opts.mode, limit: opts.limit, layer: opts.layer, embedder });
    perWiki.push(hits.map((h) => ({ ...h, wiki: w.name })));
  }
  if (perWiki.length === 1) return perWiki[0]!;
  const byKey = new Map<string, WikiSearchHit>();
  const rankings = perWiki.map((hits) =>
    hits.map((h) => {
      const key = `${h.wiki}\u0000${h.chunk.id}`;
      byKey.set(key, h);
      return key;
    }),
  );
  return rrf(rankings)
    .slice(0, opts.limit)
    .map(({ id, score }) => ({ ...byKey.get(id)!, score }));
}
