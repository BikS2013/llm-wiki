import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.js';
import { LlmError, LlmWikiError } from '../errors.js';
import { chatJson, isRecord, isStringArray } from '../llm/json.js';
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
import { isParsableDocument, needsParserLlm, unsupportedHint } from './extract.js';
import { fetchToRaw, isUrl, type FetchOptions } from './fetch.js';
import { markdownPathFor, parseDocument, type ParseOptions } from './parse.js';
import type { DocumentParser } from '../llm/types.js';
import { parseFrontmatter } from '../wiki/markdown.js';
import { readPageParts, writePageParts } from './pages.js';

export interface IngestOptions {
  force: boolean;
  /** Supplies the parser LLM lazily; only called when the source is a PDF/DOCX/PPTX original or an image. */
  parser?: (() => DocumentParser) | undefined;
  parse?: Pick<ParseOptions, 'force' | 'maxTokens' | 'maxBytes' | 'maxImages' | 'extractors'> | undefined;
  /** URL sources: renders pages that need JavaScript (LLM_WIKI_BROWSER); `render` forces it for every page. */
  fetch?: Pick<FetchOptions, 'renderer' | 'render'> | undefined;
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
  /** Set when the source was converted from an original (PDF, DOCX, PPTX, XLSX or image). */
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
  // A URL is downloaded into raw/web/ first (a web page also gets its local markdown conversion).
  if (isUrl(file)) file = (await fetchToRaw(paths, file, { maxBytes: opts.parse?.maxBytes ?? 30_000_000, renderer: opts.fetch?.renderer, render: opts.fetch?.render, onEvent: log })).sourceRel;
  let sourceRel = stageSource(paths, file);
  let originalRel: string | undefined;
  if (isParsableDocument(sourceRel)) {
    const factory = opts.parser;
    if (needsParserLlm(sourceRel) && !factory) throw new LlmWikiError(`${sourceRel} is a ${path.extname(sourceRel).slice(1).toUpperCase()} original and needs the parser LLM (LLM_WIKI_PARSER_PROVIDER / LLM_WIKI_PARSER_MODEL).`);
    const parser = () => {
      if (!factory) throw new LlmWikiError(`${sourceRel} needs the parser LLM.`);
      return factory();
    };
    const parsed = await parseDocument(paths, parser, sourceRel, { force: opts.parse?.force ?? false, maxTokens: opts.parse?.maxTokens ?? 64000, maxBytes: opts.parse?.maxBytes ?? 30_000_000, maxImages: opts.parse?.maxImages, extractors: opts.parse?.extractors, onEvent: log });
    originalRel = parsed.originalRel;
    sourceRel = parsed.markdownRel;
  }
  const abs = path.join(paths.root, sourceRel);
  if (!isTextSource(abs)) {
    const hint = unsupportedHint(abs);
    throw new LlmWikiError(`${sourceRel} is not a supported source${hint ? ` — ${hint}` : ''} (text: .md .txt .csv .json .html .rst .org; converted first: .pdf .docx .pptx .xlsx and .png .jpg .jpeg .gif .webp images).`);
  }
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
  const json = await chatJson(llm, { system: ingestSystemPrompt(schema, paths.format.name), user, maxTokens: opts.maxTokens }, isPlanJson, log);
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

/** Guarantees the summary page's metadata records the original document, whatever the model wrote. */
function stampOriginal(paths: WikiPaths, pageId: string, originalRel: string): void {
  const { frontmatter, body } = readPageParts(paths, pageId);
  const fmt = paths.format;
  const linked = body.includes(originalRel) || body.includes(originalRel.split('/').map(encodeURIComponent).join('/'));
  const mentionMd = `**Original document:** [[${originalRel}]] (kept unmodified in raw/).`;
  const mention = linked ? '' : fmt.name === 'html' ? `\n${fmt.prepare(mentionMd, pageId, (t) => t)}\n` : `\n\n${mentionMd}\n`;
  writePageParts(paths, pageId, { ...frontmatter, original: originalRel }, `${body.trimEnd()}${mention}\n`);
}

/** Raw sources that are new or changed since their last ingest, plus originals (PDF, DOCX, PPTX, XLSX, images) not yet converted. */
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
    // A text original that was converted (a downloaded web page) is ingested through its conversion.
    if (parsed.get(rel)) continue;
    if (isTextSource(abs) && !ledger.isIngested(rel, fs.readFileSync(abs))) pending.push(rel);
  }
  return pending;
}
