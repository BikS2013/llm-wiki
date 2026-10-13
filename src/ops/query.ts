import fs from 'node:fs';
import type { Config } from '../config/env.js';
import type { ChatClient } from '../llm/types.js';
import type { SearchMode } from '../search/search.js';
import { SearchStore } from '../search/store.js';
import { writeIndex } from '../wiki/index.js';
import { type WikiPaths } from '../wiki/layout.js';
import { appendLog } from '../wiki/log.js';
import { slugify, todayIso, withFrontmatter } from '../wiki/markdown.js';
import { readIndexMd, relatedPages, renderPagesForPrompt } from './context.js';
import { freePageId, writePageFile } from './write.js';
import { querySystemPrompt } from './prompts.js';

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
    writePageFile(paths, id, withFrontmatter({ title, type: 'synthesis', summary, created: todayIso(), updated: todayIso(), question: question.trim(), sources: result.pagesUsed }, body));
    writeIndex(paths);
    new SearchStore(paths).reindex({ includeRaw: false });
    appendLog(paths, 'query', title, `Filed as [[${id}]]. Pages consulted: ${result.pagesUsed.map((p) => `[[${p}]]`).join(', ') || 'none'}.`);
    result.filedAs = id;
  } else {
    appendLog(paths, 'query', question.trim().slice(0, 120), `Answered from: ${result.pagesUsed.map((p) => `[[${p}]]`).join(', ') || 'no pages (empty wiki)'}. Not filed.`);
  }
  return result;
}
