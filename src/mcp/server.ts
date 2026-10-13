import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import { search, type SearchMode } from '../search/search.js';
import { SearchStore } from '../search/store.js';
import { writeIndex } from '../wiki/index.js';
import { listPages, readPage, type WikiPaths } from '../wiki/layout.js';
import { appendLog, readLog } from '../wiki/log.js';
import { formatLintReport, lintStructure } from '../wiki/lint.js';
import { searchEmbedder } from '../ops/context.js';
import { applyPageChanges } from '../ops/pages.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Exposes the wiki to an MCP client (Claude Code, Codex, ...) over stdio. */
export async function serveMcp(config: Config, paths: WikiPaths): Promise<void> {
  const server = new McpServer({ name: 'llm-wiki', version: '0.1.0' });

  server.registerTool(
    'wiki_search',
    {
      description: 'Search the wiki pages (and optionally raw sources) with BM25, vector, or hybrid ranking. Returns chunk hits with file, heading, score and snippet.',
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(['bm25', 'vector', 'hybrid']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        layer: z.enum(['wiki', 'raw', 'all']).optional(),
      },
    },
    async ({ query, mode, limit, layer }) => {
      const store = new SearchStore(paths);
      store.reindex({ includeRaw: layer === 'raw' || layer === 'all' });
      const embedder = mode === 'bm25' || mode === undefined ? undefined : searchEmbedder(config, paths);
      const hits = await search(store, query, { mode: (mode ?? 'bm25') as SearchMode, limit: limit ?? 10, layer: layer ?? 'wiki', embedder });
      if (hits.length === 0) return text('No hits.');
      return text(hits.map((h, i) => `${i + 1}. ${h.chunk.file}${h.chunk.heading ? ` › ${h.chunk.heading}` : ''} (score ${h.score.toFixed(3)})\n   ${h.snippet}`).join('\n'));
    },
  );

  server.registerTool(
    'wiki_read_page',
    { description: 'Read a wiki page by id (e.g. entities/ada-lovelace) or the special files index / log.', inputSchema: { page: z.string().min(1) } },
    async ({ page }) => {
      if (page === 'index' || page === 'index.md') return text(fs.readFileSync(paths.index, 'utf8'));
      if (page === 'log' || page === 'log.md') return text(fs.readFileSync(paths.log, 'utf8'));
      const abs = paths.pageAbs(page);
      if (!fs.existsSync(abs)) return text(`Page not found: ${page}`);
      return text(readPage(paths, abs).raw);
    },
  );

  server.registerTool(
    'wiki_list_pages',
    { description: 'List wiki pages with id, type, title and summary. Optionally filter by type.', inputSchema: { type: z.enum(['overview', 'entity', 'concept', 'source', 'synthesis', 'lint', 'other']).optional() } },
    async ({ type }) => {
      const pages = listPages(paths).filter((p) => !type || p.type === type);
      return text(pages.length === 0 ? 'No pages.' : pages.map((p) => `${p.id}\t${p.type}\t${p.title}${typeof p.frontmatter.summary === 'string' ? ` — ${p.frontmatter.summary}` : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'wiki_write_page',
    {
      description: 'Create, replace, or append to a wiki page (markdown with frontmatter). Regenerates index.md and the search index afterwards. Never touches raw/.',
      inputSchema: { path: z.string().min(1), op: z.enum(['create', 'replace', 'append']), content: z.string(), reason: z.string().optional(), sources: z.array(z.string()).optional() },
    },
    async ({ path: id, op, content, reason, sources }) => {
      const applied = applyPageChanges(paths, [{ op, path: id, content, ...(reason ? { reason } : {}) }], sources?.[0]);
      writeIndex(paths);
      new SearchStore(paths).reindex({ includeRaw: false });
      return text(`${applied[0]!.op} ${applied[0]!.id}; index.md and search index updated.`);
    },
  );

  server.registerTool(
    'wiki_append_log',
    { description: 'Append an entry to wiki/log.md in the `## [date] kind | title` format.', inputSchema: { kind: z.enum(['ingest', 'query', 'lint', 'edit', 'note']), title: z.string().min(1), body: z.string().optional() } },
    async ({ kind, title, body }) => {
      const e = appendLog(paths, kind, title, body ?? '');
      return text(`Logged: ## [${e.date}] ${e.kind} | ${e.title}`);
    },
  );

  server.registerTool('wiki_recent_log', { description: 'Return the most recent log entries.', inputSchema: { last: z.number().int().min(1).max(100).optional() } }, async ({ last }) => {
    const entries = readLog(paths).slice(-(last ?? 5));
    return text(entries.length === 0 ? 'Log is empty.' : entries.map((e) => `## [${e.date}] ${e.kind} | ${e.title}\n${e.body}`).join('\n\n'));
  });

  server.registerTool('wiki_lint', { description: 'Run the structural health check (dangling links, orphans, stale index, un-ingested sources).', inputSchema: {} }, async () => text(formatLintReport(lintStructure(paths))));

  server.registerTool('wiki_reindex', { description: 'Regenerate index.md and rebuild the search index (incremental).', inputSchema: { includeRaw: z.boolean().optional() } }, async ({ includeRaw }) => {
    const changed = writeIndex(paths);
    const r = new SearchStore(paths).reindex({ includeRaw: includeRaw ?? false });
    return text(`index.md ${changed ? 'updated' : 'unchanged'}; search index: ${r.chunks} chunks (${r.added} added, ${r.updated} updated, ${r.removed} removed).`);
  });

  await server.connect(new StdioServerTransport());
}
