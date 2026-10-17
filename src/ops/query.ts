import fs from 'node:fs';
import type { Config } from '../config/env.js';
import type { ChatClient } from '../llm/types.js';
import type { SearchMode } from '../search/search.js';
import { SearchStore } from '../search/store.js';
import { writeIndex } from '../wiki/index.js';
import { readPage, type Page, type WikiPaths } from '../wiki/layout.js';
import { appendLog } from '../wiki/log.js';
import { slugify, todayIso } from '../wiki/markdown.js';
import { readIndexMd, relatedPages, renderPagesForPrompt, searchEmbedder } from './context.js';
import { searchWikis } from './wikis.js';
import { freePageId } from './write.js';
import { writePageParts } from './pages.js';
import { crossQuerySystemPrompt, querySystemPrompt } from './prompts.js';

export interface QueryOptions {
  limit: number;
  maxPages: number;
  contextChars: number;
  maxTokens: number;
  mode?: SearchMode | undefined;
  file: boolean;
  onEvent?: (msg: string) => void;
}

export interface QueryResult {
  answer: string;
  pagesUsed: string[];
  filedAs?: string;
}

export async function queryWiki(config: Config, paths: WikiPaths, llm: ChatClient, question: string, opts: QueryOptions): Promise<QueryResult> {
  const log = opts.onEvent ?? (() => undefined);
  const related = await relatedPages(config, paths, question, {
    limit: opts.limit,
    maxPages: opts.maxPages,
    charBudget: opts.contextChars,
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  log(`${related.hits.length} hit(s), ${related.pages.length} page(s) in context${related.omitted.length ? `, ${related.omitted.length} omitted for budget` : ''}`);
  const schema = fs.existsSync(paths.schema) ? fs.readFileSync(paths.schema, 'utf8') : '';
  const hits = related.hits.map((h) => `- ${h.chunk.file}${h.chunk.heading ? ` › ${h.chunk.heading}` : ''}: ${h.snippet}`).join('\n');
  const user = [
    `<index>\n${readIndexMd(paths)}\n</index>`,
    `<search_hits>\n${hits || '(no hits)'}\n</search_hits>`,
    `<pages>\n${renderPagesForPrompt(related.pages)}\n</pages>`,
    `<question>\n${question}\n</question>`,
  ].join('\n\n');
  log(`asking ${llm.provider}/${llm.model}`);
  const answer = (await llm.chat({ system: querySystemPrompt(schema), user, maxTokens: opts.maxTokens })).trim();
  const result: QueryResult = { answer, pagesUsed: related.pages.map((p) => p.id) };

  if (opts.file) {
    const title = question.trim().replace(/\s+/g, ' ').slice(0, 120);
    const id = freePageId(paths, 'syntheses', slugify(title));
    const firstPara = answer.split(/\n{2,}/).map((p) => p.trim()).find((p) => p !== '' && !p.startsWith('#')) ?? '';
    const summary = firstPara.replace(/\s+/g, ' ').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t).slice(0, 200);
    const body = `# ${title}\n\n> Filed answer to the question: *${question.trim()}*\n\n${answer}\n`;
    writePageParts(paths, id, { title, type: 'synthesis', summary, created: todayIso(), updated: todayIso(), question: question.trim(), sources: result.pagesUsed }, body);
    writeIndex(paths);
    new SearchStore(paths).reindex({ includeRaw: false });
    appendLog(paths, 'query', title, `Filed as [[${id}]]. Pages consulted: ${result.pagesUsed.map((p) => `[[${p}]]`).join(', ') || 'none'}.`);
    result.filedAs = id;
  } else {
    appendLog(paths, 'query', question.trim().slice(0, 120), `Answered from: ${result.pagesUsed.map((p) => `[[${p}]]`).join(', ') || 'no pages (empty wiki)'}. Not filed.`);
  }
  return result;
}

export interface WikiTarget {
  name: string;
  paths: WikiPaths;
  description?: string | undefined;
}

export interface CrossQueryResult {
  answer: string;
  wikis: string[];
  /** Pages given to the model, as `<wiki>:<root-relative path>`. */
  pagesUsed: string[];
}

/**
 * Answers one question from several wikis. Each wiki is searched on its own index and the rankings are
 * fused (as `search --wikis` does); the top pages from all wikis share one character budget, and the
 * answer cites pages as `[[<wiki>:<page-id>]]`. Every wiki consulted gets a `query` log entry; the answer
 * is never filed (filing needs one target wiki).
 */
export async function queryWikis(config: Config, targets: WikiTarget[], llm: ChatClient, question: string, opts: Omit<QueryOptions, 'file'>): Promise<CrossQueryResult> {
  const log = opts.onEvent ?? (() => undefined);
  const mode: SearchMode =
    opts.mode ?? (targets.every((t) => {
      const e = searchEmbedder(config, t.paths);
      return e !== undefined && e.store.size > 0;
    })
      ? 'hybrid'
      : 'bm25');
  const hits = await searchWikis(config, targets, question, { mode, limit: opts.limit, layer: 'wiki' });
  const byName = new Map(targets.map((t) => [t.name, t]));
  const pages: Array<{ wiki: string; page: Page }> = [];
  const seen = new Set<string>();
  let used = 0;
  let omitted = 0;
  for (const h of hits) {
    const key = `${h.wiki}:${h.chunk.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = byName.get(h.wiki)!;
    const page = readPage(t.paths, `${t.paths.root}/${h.chunk.file}`);
    if (pages.length >= opts.maxPages || used + page.source.length > opts.contextChars) {
      omitted++;
      continue;
    }
    used += page.source.length;
    pages.push({ wiki: h.wiki, page });
  }
  log(`${hits.length} hit(s) across ${targets.length} wiki(s), ${pages.length} page(s) in context${omitted ? `, ${omitted} omitted for budget` : ''}`);
  const user = [
    `<wikis>\n${targets.map((t) => `- ${t.name}: ${t.description ?? '(no description)'}`).join('\n')}\n</wikis>`,
    `<search_hits>\n${hits.map((h) => `- ${h.wiki}:${h.chunk.file}${h.chunk.heading ? ` › ${h.chunk.heading}` : ''}: ${h.snippet}`).join('\n') || '(no hits)'}\n</search_hits>`,
    `<pages>\n${pages.map(({ wiki, page }) => `<page wiki="${wiki}" id="${page.id}" path="${page.relPath}">\n${page.source.trim()}\n</page>`).join('\n\n')}\n</pages>`,
    `<question>\n${question}\n</question>`,
  ].join('\n\n');
  log(`asking ${llm.provider}/${llm.model}`);
  const answer = (await llm.chat({ system: crossQuerySystemPrompt(), user, maxTokens: opts.maxTokens })).trim();
  const result: CrossQueryResult = { answer, wikis: targets.map((t) => t.name), pagesUsed: pages.map(({ wiki, page }) => `${wiki}:${page.relPath}`) };
  for (const t of targets) {
    const mine = pages.filter((p) => p.wiki === t.name).map((p) => `[[${p.page.id}]]`);
    const others = targets.filter((o) => o.name !== t.name).map((o) => o.name);
    appendLog(t.paths, 'query', question.trim().slice(0, 120), `Cross-wiki query together with ${others.join(', ')}. Pages consulted here: ${mine.join(', ') || 'none'}. Not filed.`);
  }
  return result;
}
