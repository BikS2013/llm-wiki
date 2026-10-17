import fs from 'node:fs';
import { search, type SearchHit, type SearchMode } from '../search/search.js';
import { EmbeddingStore, SearchStore } from '../search/store.js';
import { listPages, readPage, type Page, type WikiPaths } from '../wiki/layout.js';
import { renderIndex } from '../wiki/index.js';
import type { Config } from '../config/env.js';
import { embeddingSettings, embeddingsConfigured } from '../config/settings.js';
import { createEmbeddingClient } from '../llm/factory.js';

export interface RelatedContext {
  hits: SearchHit[];
  pages: Page[];
  omitted: string[];
}

export function searchEmbedder(config: Config, paths: WikiPaths): { client: ReturnType<typeof createEmbeddingClient>; store: EmbeddingStore } | undefined {
  if (!embeddingsConfigured(config)) return undefined;
  const { provider, model } = embeddingSettings(config);
  return { client: createEmbeddingClient(config), store: new EmbeddingStore(paths, provider, model) };
}

/** Search for the query, then load the distinct pages behind the top hits within a character budget. */
export async function relatedPages(
  config: Config,
  paths: WikiPaths,
  query: string,
  opts: { limit: number; maxPages: number; charBudget: number; mode?: SearchMode },
): Promise<RelatedContext> {
  const store = new SearchStore(paths);
  store.reindex({ includeRaw: false });
  const embedder = searchEmbedder(config, paths);
  const mode: SearchMode = opts.mode ?? (embedder && embedder.store.size > 0 ? 'hybrid' : 'bm25');
  const hits = store.chunks.length === 0 ? [] : await search(store, query, { mode, limit: opts.limit, layer: 'wiki', embedder });
  const pages: Page[] = [];
  const omitted: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const hit of hits) {
    if (seen.has(hit.chunk.file)) continue;
    seen.add(hit.chunk.file);
    if (pages.length >= opts.maxPages) {
      omitted.push(hit.chunk.file);
      continue;
    }
    const page = readPage(paths, `${paths.root}/${hit.chunk.file}`);
    if (used + page.source.length > opts.charBudget) {
      omitted.push(page.relPath);
      continue;
    }
    used += page.source.length;
    pages.push(page);
  }
  return { hits, pages, omitted };
}

/** The index as the LLM sees it: markdown with `[[id|Title]]` links, in either format (HTML wikis render it from the pages). */
export function readIndexMd(paths: WikiPaths): string {
  if (paths.format.name === 'html') return renderIndex(listPages(paths));
  return fs.existsSync(paths.index) ? fs.readFileSync(paths.index, 'utf8') : '(index.md not generated yet)';
}

export function renderPagesForPrompt(pages: Page[]): string {
  return pages.map((p) => `<page id="${p.id}" path="${p.relPath}">\n${p.source.trim()}\n</page>`).join('\n\n');
}

export function allPagesWithinBudget(paths: WikiPaths, charBudget: number): { pages: Page[]; omitted: Page[] } {
  const pages: Page[] = [];
  const omitted: Page[] = [];
  let used = 0;
  for (const p of listPages(paths)) {
    if (used + p.source.length > charBudget) omitted.push(p);
    else {
      used += p.source.length;
      pages.push(p);
    }
  }
  return { pages, omitted };
}
