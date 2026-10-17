import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import type { ResolvedWiki } from '../config/settings.js';
import { type SearchMode } from '../search/search.js';
import { SearchStore } from '../search/store.js';
import { writeIndex } from '../wiki/index.js';
import { listPages, readPage, WikiPaths } from '../wiki/layout.js';
import { appendLog, readLog } from '../wiki/log.js';
import { formatLintReport, lintStructure } from '../wiki/lint.js';
import { WikiRegistry } from '../wiki/registry.js';
import { searchWikis, wikiStatus } from '../ops/wikis.js';
import { applyPageChanges, linkHtmlPages } from '../ops/pages.js';
import { renderIndex } from '../wiki/index.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const wikiParam = z
  .string()
  .min(1)
  .optional()
  .describe('Registered wiki name (see wiki_list_wikis). Omit to use the server default wiki.');

/**
 * Exposes the registered wikis to an MCP client (Claude Code, Codex, ...) over stdio.
 * Every tool takes an optional `wiki` argument; the registry file is re-read on each call so wikis
 * registered while the server runs are visible immediately.
 */
export async function serveMcp(config: Config, registryPath: string, fallbackWiki: ResolvedWiki | undefined): Promise<void> {
  const server = new McpServer({ name: 'llm-wiki', version: '0.4.0' });
  const registry = () => new WikiRegistry(registryPath);

  /** Resolves the wiki for one call. An unknown name or no choice at all raises an error the client sees. */
  const target = (wiki: string | undefined): { name: string; paths: WikiPaths } => {
    if (wiki) {
      const e = registry().get(wiki);
      const paths = new WikiPaths(e.root);
      paths.assertInitialised();
      return { name: e.name, paths };
    }
    if (!fallbackWiki) {
      const names = registry().list().map((w) => w.name);
      throw new Error(`No default wiki for this server: pass "wiki" (one of: ${names.join(', ') || 'none registered'}).`);
    }
    return { name: fallbackWiki.name ?? '(unregistered)', paths: new WikiPaths(fallbackWiki.root) };
  };

  server.registerTool(
    'wiki_list_wikis',
    { description: 'List the registered wikis with their description, page count and last activity, and which one is the server default. Use it to decide which wiki to update or query.', inputSchema: {} },
    async () => {
      const reg = registry();
      const rows = reg.list().map((e) => wikiStatus(e));
      if (rows.length === 0) return text('No wikis registered.');
      const def = fallbackWiki?.name;
      return text(
        rows
          .map((r) => `${r.name}${r.name === def ? ' (default)' : ''}\t${r.root}\n  ${r.description ?? '(no description)'}\n  ${r.healthy ? `${r.format}, ${r.pages} pages, ${r.pending} pending sources${r.lastActivity ? `; last: ${r.lastActivity}` : ''}` : `UNAVAILABLE: ${r.problem}`}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'wiki_search',
    {
      description: 'Search wiki pages (and optionally raw sources) with BM25, vector, or hybrid ranking. Searches one wiki (`wiki`, or the default), several (`wikis`), or every registered wiki (`wikis: ["*"]`). Returns chunk hits with wiki, file, heading, score and snippet.',
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(['bm25', 'vector', 'hybrid']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        layer: z.enum(['wiki', 'raw', 'all']).optional(),
        wiki: wikiParam,
        wikis: z.array(z.string().min(1)).min(1).optional().describe('Several registered wikis to search together; ["*"] means all.'),
      },
    },
    async ({ query, mode, limit, layer, wiki, wikis }) => {
      if (wiki && wikis) throw new Error('Pass either "wiki" or "wikis", not both.');
      let targets: Array<{ name: string; paths: WikiPaths }>;
      if (wikis) {
        const names = wikis.includes('*') ? registry().list().map((w) => w.name) : [...new Set(wikis)];
        targets = names.map((n) => target(n));
      } else targets = [target(wiki)];
      const hits = await searchWikis(config, targets, query, { mode: (mode ?? 'bm25') as SearchMode, limit: limit ?? 10, layer: layer ?? 'wiki' });
      if (hits.length === 0) return text('No hits.');
      return text(hits.map((h, i) => `${i + 1}. [${h.wiki}] ${h.chunk.file}${h.chunk.heading ? ` › ${h.chunk.heading}` : ''} (score ${h.score.toFixed(3)})\n   ${h.snippet}`).join('\n'));
    },
  );

  server.registerTool(
    'wiki_read_page',
    {
      description: 'Read a wiki page by id (e.g. entities/ada-lovelace) or the special files index / log. Pages come back as frontmatter + body — the body is markdown, or an HTML fragment in HTML wikis — the same form wiki_write_page takes. The index comes back as markdown with [[id|Title]] links in both formats.',
      inputSchema: { page: z.string().min(1), wiki: wikiParam },
    },
    async ({ page, wiki }) => {
      const { paths } = target(wiki);
      const special = page.replace(/\.(md|html?)$/i, '');
      if (special === 'index') return text(paths.format.name === 'html' ? renderIndex(listPages(paths)) : fs.readFileSync(paths.index, 'utf8'));
      if (special === 'log') return text(paths.format.name === 'html' ? readLog(paths).map((e) => `## [${e.date}] ${e.kind} | ${e.title}${e.body ? `\n\n${e.body}` : ''}`).join('\n\n') : fs.readFileSync(paths.log, 'utf8'));
      const abs = paths.pageAbs(page);
      if (!fs.existsSync(abs)) return text(`Page not found: ${page}`);
      return text(readPage(paths, abs).source);
    },
  );

  server.registerTool(
    'wiki_list_pages',
    { description: 'List wiki pages with id, type, title and summary. Optionally filter by type.', inputSchema: { type: z.enum(['overview', 'entity', 'concept', 'source', 'synthesis', 'lint', 'other']).optional(), wiki: wikiParam } },
    async ({ type, wiki }) => {
      const { paths } = target(wiki);
      const pages = listPages(paths).filter((p) => !type || p.type === type);
      return text(pages.length === 0 ? 'No pages.' : pages.map((p) => `${p.id}\t${p.type}\t${p.title}${typeof p.frontmatter.summary === 'string' ? ` — ${p.frontmatter.summary}` : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'wiki_write_page',
    {
      description: 'Create, replace, or append to a wiki page. `content` is YAML frontmatter followed by the body: markdown, or in HTML wikis an HTML fragment (or markdown) — the tool builds the HTML page, and turns [[wikilinks]] into relative links. `append` content is only the body to add. Regenerates the index and the search index afterwards. Never touches raw/.',
      inputSchema: { path: z.string().min(1), op: z.enum(['create', 'replace', 'append']), content: z.string(), reason: z.string().optional(), sources: z.array(z.string()).optional(), wiki: wikiParam },
    },
    async ({ path: id, op, content, reason, sources, wiki }) => {
      const { paths, name } = target(wiki);
      const applied = applyPageChanges(paths, [{ op, path: id, content, ...(reason ? { reason } : {}) }], sources?.[0]);
      writeIndex(paths);
      new SearchStore(paths).reindex({ includeRaw: false });
      return text(`[${name}] ${applied[0]!.op} ${paths.pageRel(applied[0]!.id)}; index and search index updated.`);
    },
  );

  server.registerTool(
    'wiki_append_log',
    { description: 'Append an entry to the wiki log (log.md, or log.html in HTML wikis) as `[date] kind | title` plus an optional markdown body.', inputSchema: { kind: z.enum(['ingest', 'query', 'lint', 'edit', 'note']), title: z.string().min(1), body: z.string().optional(), wiki: wikiParam } },
    async ({ kind, title, body, wiki }) => {
      const { paths } = target(wiki);
      const e = appendLog(paths, kind, title, body ?? '');
      return text(`Logged: ## [${e.date}] ${e.kind} | ${e.title}`);
    },
  );

  server.registerTool('wiki_recent_log', { description: 'Return the most recent log entries.', inputSchema: { last: z.number().int().min(1).max(100).optional(), wiki: wikiParam } }, async ({ last, wiki }) => {
    const { paths } = target(wiki);
    const entries = readLog(paths).slice(-(last ?? 5));
    return text(entries.length === 0 ? 'Log is empty.' : entries.map((e) => `## [${e.date}] ${e.kind} | ${e.title}\n${e.body}`).join('\n\n'));
  });

  server.registerTool('wiki_lint', { description: 'Run the structural health check (dangling links, orphans, stale index, un-ingested sources).', inputSchema: { wiki: wikiParam } }, async ({ wiki }) => text(formatLintReport(lintStructure(target(wiki).paths))));

  server.registerTool('wiki_reindex', { description: 'Regenerate the index and rebuild the search index (incremental). In HTML wikis it also turns leftover [[wikilinks]] in hand-edited pages into relative links.', inputSchema: { includeRaw: z.boolean().optional(), wiki: wikiParam } }, async ({ includeRaw, wiki }) => {
    const { paths } = target(wiki);
    const linked = linkHtmlPages(paths);
    const changed = writeIndex(paths);
    const r = new SearchStore(paths).reindex({ includeRaw: includeRaw ?? false });
    return text(`${linked.length ? `links converted in ${linked.length} page(s); ` : ''}${paths.relToRoot(paths.index)} ${changed ? 'updated' : 'unchanged'}; search index: ${r.chunks} chunks (${r.added} added, ${r.updated} updated, ${r.removed} removed).`);
  });

  await server.connect(new StdioServerTransport());
}
