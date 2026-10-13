import fs from 'node:fs';
import type { ChatClient } from '../llm/types.js';
import { extractJson, isRecord } from '../llm/json.js';
import { SearchStore } from '../search/store.js';
import { writeIndex } from '../wiki/index.js';
import type { WikiPaths } from '../wiki/layout.js';
import { appendLog } from '../wiki/log.js';
import { todayIso, withFrontmatter } from '../wiki/markdown.js';
import { lintStructure, formatLintReport, type LintReport } from '../wiki/lint.js';
import { allPagesWithinBudget, readIndexMd, renderPagesForPrompt } from './context.js';
import { freePageId, writePageFile } from './write.js';
import { lintSystemPrompt } from './prompts.js';

export interface SemanticLint {
  contradictions: Array<{ pages: string[]; description: string }>;
  stale_claims: Array<{ page: string; claim: string; superseded_by: string }>;
  missing_pages: Array<{ name: string; mentioned_in: string[]; why: string }>;
  missing_links: Array<{ from: string; to: string; why: string }>;
  data_gaps: string[];
  suggested_questions: string[];
  suggested_sources: string[];
}

function arr<T>(v: unknown, pick: (x: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (isRecord(x) ? [pick(x)].filter((y): y is T => y !== undefined) : []));
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function isSemanticJson(v: unknown): v is Record<string, unknown> {
  return isRecord(v);
}

export async function lintSemantic(paths: WikiPaths, llm: ChatClient, opts: { contextChars: number; maxTokens: number; onEvent?: (m: string) => void }): Promise<{ result: SemanticLint; omitted: string[] }> {
  const log = opts.onEvent ?? (() => undefined);
  const { pages, omitted } = allPagesWithinBudget(paths, opts.contextChars);
  log(`sending ${pages.length} page(s) to ${llm.provider}/${llm.model}${omitted.length ? ` (${omitted.length} omitted for budget)` : ''}`);
  const schema = fs.existsSync(paths.schema) ? fs.readFileSync(paths.schema, 'utf8') : '';
  const user = [`<index>\n${readIndexMd(paths)}\n</index>`, `<pages>\n${renderPagesForPrompt(pages)}\n</pages>`, omitted.length ? `Pages omitted for size: ${omitted.map((p) => p.id).join(', ')}.` : '', 'Audit the wiki and respond with the JSON object only.'].join('\n\n');
  const reply = await llm.chat({ system: lintSystemPrompt(schema), user, maxTokens: opts.maxTokens });
  const j = extractJson(reply, isSemanticJson);
  const result: SemanticLint = {
    contradictions: arr(j.contradictions, (x) => (typeof x.description === 'string' ? { pages: strs(x.pages), description: x.description } : undefined)),
    stale_claims: arr(j.stale_claims, (x) => (typeof x.claim === 'string' ? { page: String(x.page ?? ''), claim: x.claim, superseded_by: String(x.superseded_by ?? '') } : undefined)),
    missing_pages: arr(j.missing_pages, (x) => (typeof x.name === 'string' ? { name: x.name, mentioned_in: strs(x.mentioned_in), why: String(x.why ?? '') } : undefined)),
    missing_links: arr(j.missing_links, (x) => (typeof x.from === 'string' && typeof x.to === 'string' ? { from: x.from, to: x.to, why: String(x.why ?? '') } : undefined)),
    data_gaps: strs(j.data_gaps),
    suggested_questions: strs(j.suggested_questions),
    suggested_sources: strs(j.suggested_sources),
  };
  return { result, omitted: omitted.map((p) => p.id) };
}

export function renderSemanticLint(s: SemanticLint): string {
  const section = (title: string, items: string[]) => (items.length ? [`## ${title}`, '', ...items.map((i) => `- ${i}`), ''] : []);
  const lines = [
    ...section('Contradictions', s.contradictions.map((c) => `${c.pages.map((p) => `[[${p}]]`).join(' vs ')}: ${c.description}`)),
    ...section('Stale claims', s.stale_claims.map((c) => `[[${c.page}]]: "${c.claim}" — superseded by ${c.superseded_by}`)),
    ...section('Missing pages', s.missing_pages.map((m) => `**${m.name}** (mentioned in ${m.mentioned_in.map((p) => `[[${p}]]`).join(', ') || 'several pages'}): ${m.why}`)),
    ...section('Missing cross-references', s.missing_links.map((l) => `[[${l.from}]] → [[${l.to}]]: ${l.why}`)),
    ...section('Data gaps', s.data_gaps),
    ...section('Suggested questions', s.suggested_questions),
    ...section('Suggested sources', s.suggested_sources),
  ];
  return lines.length ? lines.join('\n').trimEnd() : '_The model found nothing to report._';
}

/** Writes `wiki/lint/<date>.md` with both structural and semantic findings, updates the index and log. */
export function fileLintReport(paths: WikiPaths, structural: LintReport, semantic: SemanticLint | undefined): string {
  const date = todayIso();
  const id = freePageId(paths, 'lint', date);
  const body = [
    `# Lint report ${date}`,
    '',
    '## Structural findings',
    '',
    '```',
    formatLintReport(structural),
    '```',
    '',
    semantic ? renderSemanticLint(semantic) : '_Semantic lint not run (use `llm-wiki lint --llm`)._',
    '',
  ].join('\n');
  writePageFile(paths, id, withFrontmatter({ title: `Lint report ${date}`, type: 'lint', summary: `${structural.findings.length} structural finding(s)${semantic ? `, ${semantic.contradictions.length} contradiction(s), ${semantic.missing_pages.length} missing page(s)` : ''}.`, created: date, updated: date }, body));
  writeIndex(paths);
  new SearchStore(paths).reindex({ includeRaw: false });
  appendLog(paths, 'lint', `Lint report ${date}`, `Filed as [[${id}]].`);
  return id;
}
