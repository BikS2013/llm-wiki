import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.js';
import { LlmError, LlmWikiError } from '../errors.js';
import { extractJson, isRecord, isStringArray } from '../llm/json.js';
import type { ChatClient } from '../llm/types.js';
import { SearchStore, isTextSource } from '../search/store.js';
import { writeIndex } from '../wiki/index.js';
import { listRawFiles, type WikiPaths } from '../wiki/layout.js';
import { appendLog } from '../wiki/log.js';
import { todayIso } from '../wiki/markdown.js';
import { readIndexMd, relatedPages, renderPagesForPrompt } from './context.js';
import { IngestLedger, ParseLedger } from './ledger.js';
import { applyPageChanges, type AppliedChange, type PageChange } from './pages.js';
import { ingestSystemPrompt } from './prompts.js';
import { stageSource } from './stage.js';
import { isParsableDocument } from './extract.js';
import { markdownPathFor, parseDocument, type ParseOptions } from './parse.js';
import type { DocumentParser } from '../llm/types.js';
import { parseFrontmatter, withFrontmatter } from '../wiki/markdown.js';

export interface IngestOptions {
  force: boolean;
  /** Supplies the parser LLM lazily; only called when the source is a PDF/DOCX original. */
  parser?: (() => DocumentParser) | undefined;
  parse?: Pick<ParseOptions, 'force' | 'maxTokens' | 'maxBytes' | 'extractors'> | undefined;
  dryRun: boolean;
  maxTokens: number;
  relatedLimit: number;
  maxSourceChars: number;
  contextChars: number;
  onEvent?: (msg: string) => void;
}

export interface IngestPlan {
  title: string;
  takeaways: string[];
  summaryPage: PageChange;
  pages: PageChange[];
  logEntry: string;
}

export interface IngestResult {
  sourceRel: string;
  /** Set when the source was converted from a PDF/DOCX original. */
  originalRel?: string | undefined;
  skipped: boolean;
  plan?: IngestPlan;
  applied: AppliedChange[];
}

function isPageChange(v: unknown): v is PageChange {
  return isRecord(v) && typeof v.path === 'string' && typeof v.content === 'string' && (v.op === 'create' || v.op === 'replace' || v.op === 'append');
}

function isPlanJson(v: unknown): v is { title: string; takeaways: string[]; summary_page: { path: string; content: string }; pages: PageChange[]; log_entry: string } {
  return (
    isRecord(v) &&
    typeof v.title === 'string' &&
    isStringArray(v.takeaways) &&
    isRecord(v.summary_page) &&
    typeof v.summary_page.path === 'string' &&
    typeof v.summary_page.content === 'string' &&
    Array.isArray(v.pages) &&
    v.pages.every(isPageChange) &&
    typeof v.log_entry === 'string'
  );
}

export async function ingestSource(config: Config, paths: WikiPaths, llm: ChatClient, file: string, opts: IngestOptions): Promise<IngestResult> {
  const log = opts.onEvent ?? (() => undefined);
  let sourceRel = stageSource(paths, file);
  let originalRel: string | undefined;
  if (isParsableDocument(sourceRel)) {
    if (!opts.parser) throw new LlmWikiError(`${sourceRel} is a PDF/DOCX original and needs the parser LLM (LLM_WIKI_PARSER_PROVIDER / LLM_WIKI_PARSER_MODEL).`);
    const parsed = await parseDocument(paths, opts.parser(), sourceRel, { force: opts.parse?.force ?? false, maxTokens: opts.parse?.maxTokens ?? 64000, maxBytes: opts.parse?.maxBytes ?? 30_000_000, extractors: opts.parse?.extractors, onEvent: log });
    originalRel = parsed.originalRel;
    sourceRel = parsed.markdownRel;
  }
  const abs = path.join(paths.root, sourceRel);
  if (!isTextSource(abs)) throw new LlmWikiError(`${sourceRel} is not a text source (supported: .md .txt .csv .json .html .rst .org, plus .pdf/.docx via the parser LLM).`);
  if (originalRel === undefined) {
    const fm = parseFrontmatter(fs.readFileSync(abs, 'utf8')).frontmatter;
    if (typeof fm.original === 'string') originalRel = fm.original;
  }
  const buffer = fs.readFileSync(abs);
  const ledger = new IngestLedger(paths);
  if (!opts.force && ledger.isIngested(sourceRel, buffer)) {
    log(`skip ${sourceRel}: already ingested with identical content (use --force to redo)`);
    return { sourceRel, originalRel, skipped: true, applied: [] };
  }
  const text = buffer.toString('utf8');
  if (text.length > opts.maxSourceChars) {
    throw new LlmWikiError(`${sourceRel} is ${text.length} characters, above the --max-source-chars limit of ${opts.maxSourceChars}. Split the source or raise the limit; the tool never truncates sources silently.`);
  }

  log(`reading related pages for ${sourceRel}`);
  const related = await relatedPages(config, paths, `${path.basename(sourceRel)}\n${text.slice(0, 4000)}`, {
    limit: opts.relatedLimit * 2,
    maxPages: opts.relatedLimit,
    charBudget: opts.contextChars,
  });
  const schema = fs.existsSync(paths.schema) ? fs.readFileSync(paths.schema, 'utf8') : '';
  const user = [
    `<index>\n${readIndexMd(paths)}\n</index>`,
    related.pages.length > 0 ? `<related_pages>\n${renderPagesForPrompt(related.pages)}\n</related_pages>` : '<related_pages>(none yet)</related_pages>',
    `<source path="${sourceRel}"${originalRel ? ` original="${originalRel}"` : ''}>\n${text}\n</source>`,
    originalRel ? `This source is a markdown conversion of the original document ${originalRel}, which is kept unmodified in raw/. In the summary page, state that it was converted from [[${originalRel}]] and link that original.` : '',
    `Today is ${todayIso()}. Compile this source into the wiki and respond with the JSON object only.`,
  ].join('\n\n');

  log(`asking ${llm.provider}/${llm.model} to compile ${sourceRel} (${related.pages.length} related page(s) in context)`);
  const reply = await llm.chat({ system: ingestSystemPrompt(schema), user, maxTokens: opts.maxTokens });
  const json = extractJson(reply, isPlanJson);
  const plan: IngestPlan = {
    title: json.title,
    takeaways: json.takeaways,
    summaryPage: { op: 'replace', path: json.summary_page.path, content: json.summary_page.content },
    pages: json.pages,
    logEntry: json.log_entry,
  };
  if (!plan.summaryPage.path.replace(/^wiki\//, '').startsWith('sources/')) throw new LlmError(`The model put the summary page at "${plan.summaryPage.path}" instead of under sources/.`);
  if (opts.dryRun) return { sourceRel, originalRel, skipped: false, plan, applied: [] };

  const applied = applyPageChanges(paths, [plan.summaryPage, ...plan.pages], sourceRel);
  if (originalRel) stampOriginal(paths, applied[0]!.id, originalRel);
  writeIndex(paths);
  new SearchStore(paths).reindex({ includeRaw: false });
  ledger.record(sourceRel, buffer, applied[0]!.id, applied.map((a) => a.id));
  appendLog(
    paths,
    'ingest',
    plan.title,
    [`Source: ${sourceRel}${originalRel ? ` (converted from original ${originalRel})` : ''}`, plan.logEntry, '', 'Pages touched:', ...applied.map((a) => `- ${a.op} [[${a.id}]]${a.reason ? ` — ${a.reason}` : ''}`), '', 'Takeaways:', ...plan.takeaways.map((t) => `- ${t}`)].join('\n'),
  );
  return { sourceRel, originalRel, skipped: false, plan, applied };
}

/** Guarantees the summary page's frontmatter records the original document, whatever the model wrote. */
function stampOriginal(paths: WikiPaths, pageId: string, originalRel: string): void {
  const abs = paths.pageAbs(pageId);
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  const mention = body.includes(originalRel) ? '' : `\n\n**Original document:** [[${originalRel}]] (kept unmodified in raw/).\n`;
  fs.writeFileSync(abs, withFrontmatter({ ...frontmatter, original: originalRel }, `${body.trimEnd()}${mention}\n`));
}

/** Raw sources that are new or changed since their last ingest, plus PDF/DOCX originals not yet converted. */
export function pendingSources(paths: WikiPaths): string[] {
  const ledger = new IngestLedger(paths);
  const parsed = new ParseLedger(paths);
  const pending: string[] = [];
  for (const abs of listRawFiles(paths)) {
    const rel = paths.relToRoot(abs);
    if (rel.startsWith('raw/assets/')) continue;
    if (isParsableDocument(abs)) {
      const bytes = fs.readFileSync(abs);
      if (!parsed.isCurrent(rel, bytes) || !fs.existsSync(path.join(paths.root, markdownPathFor(rel)))) pending.push(rel);
      continue;
    }
    if (isTextSource(abs) && !ledger.isIngested(rel, fs.readFileSync(abs))) pending.push(rel);
  }
  return pending;
}
