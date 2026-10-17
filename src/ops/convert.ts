import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { SearchStore } from '../search/store.js';
import { decodeEntities, htmlFormat } from '../wiki/format.js';
import { ensureStylesheet, writeIndex } from '../wiki/index.js';
import { AGENTS_FILE, LinkResolver, listPages, type WikiPaths } from '../wiki/layout.js';
import { appendLog, readLog, writeLog } from '../wiki/log.js';
import { schemaTemplate } from './prompts.js';

export interface ConvertOptions {
  dryRun: boolean;
  /** Leave CLAUDE.md / AGENTS.md untouched (they then still describe markdown pages). */
  keepSchema: boolean;
  now?: Date;
}

export interface ConvertResult {
  from: 'markdown';
  to: 'html';
  dryRun: boolean;
  /** Root-relative paths of the HTML pages written (or that would be written). */
  pages: string[];
  logEntries: number;
  /** `[[links]]` and `.md` links that point at no page; they become `wikilink-missing` links. */
  unresolvedLinks: Array<{ page: string; target: string }>;
  /**
   * `rewritten`: the schema was the stock template and is replaced by the HTML one; `merged`: it was
   * customised, so only the template's own sections were replaced and the custom ones kept; `kept`: untouched.
   */
  schema: 'rewritten' | 'merged' | 'kept';
  /** Sections of a customised schema replaced by their HTML versions (empty unless `merged`). */
  schemaSectionsReplaced: string[];
  /** Where the markdown files were moved, relative to the wiki root (null on a dry run). */
  backup: string | null;
}

/** Splits a markdown document at `## ` headings: the preamble (key '') and each section with its heading line. */
function sections(doc: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = [{ heading: '', text: '' }];
  let inFence = false;
  for (const line of doc.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) out.push({ heading: line.slice(3).trim(), text: '' });
    out[out.length - 1]!.text += `${line}\n`;
  }
  return out;
}

/**
 * Replaces, in a customised schema, every section whose heading also exists in the HTML template with the
 * template's version, keeping the preamble and all other (custom) sections where they are.
 */
export function mergeSchema(current: string, template: string): { text: string; replaced: string[] } {
  const fresh = new Map(sections(template).filter((s) => s.heading !== '').map((s) => [s.heading.toLowerCase(), s.text]));
  const replaced: string[] = [];
  const text = sections(current)
    .map((s) => {
      const t = s.heading === '' ? undefined : fresh.get(s.heading.toLowerCase());
      if (t === undefined || t === s.text) return s.text;
      replaced.push(s.heading);
      return s.text.endsWith('\n\n') && !t.endsWith('\n\n') ? `${t}\n` : t;
    })
    .join('');
  return { text: text.replace(/\n+$/, '\n'), replaced };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Converts a markdown wiki into an HTML wiki in place. Every page keeps its id and metadata; bodies are
 * rendered to HTML, `[[wikilinks]]` and relative `.md` links become relative `.html` links, the log is
 * re-rendered entry by entry, and the index and search index are rebuilt. The markdown files (pages,
 * index.md, log.md and replaced schema files) are moved to `.llm-wiki/backup/markdown-<timestamp>/`.
 */
export function convertToHtml(paths: WikiPaths, opts: ConvertOptions): ConvertResult {
  if (paths.format.name !== 'markdown') throw new WikiLayoutError(`${paths.root} is already an HTML wiki.`);
  const pages = listPages(paths);
  const ids = new Set(pages.map((p) => p.id));
  const resolver = new LinkResolver(pages);
  const unresolved: ConvertResult['unresolvedLinks'] = [];

  /** Relative `href="x.md"` links produced by marked from `[text](x.md)` are re-pointed at the HTML page. */
  const fixMdHrefs = (html: string, fromId: string) =>
    html.replace(/href="([^":#?]+)\.md(#[^"]*)?"/gi, (m, target: string, hash: string | undefined) => {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(`wiki/${fromId}`), decodeEntities(target)));
      if (!rel.startsWith('wiki/')) return m;
      const id = rel.slice('wiki/'.length);
      if (!ids.has(id)) {
        unresolved.push({ page: fromId, target: `${target}.md` });
        return m;
      }
      return `href="${target}.html${hash ?? ''}"`;
    });

  const converted = pages.map((p) => {
    const resolve = (t: string) => {
      if (t.startsWith('raw/')) return t;
      const hit = resolver.resolve(t, p.id)?.id;
      if (hit === undefined) unresolved.push({ page: p.id, target: t });
      return hit;
    };
    const body = fixMdHrefs(htmlFormat.prepare(p.body, p.id, resolve), p.id);
    return { page: p, content: htmlFormat.render(p.frontmatter, body, p.id) };
  });
  const entries = readLog(paths);
  const agentsFile = path.join(paths.root, AGENTS_FILE);
  const currentSchema = fs.existsSync(paths.schema) ? fs.readFileSync(paths.schema, 'utf8') : undefined;
  const pristine = currentSchema === undefined || currentSchema === schemaTemplate('markdown');
  const htmlSchema = schemaTemplate('html');
  const merged = !pristine && !opts.keepSchema ? mergeSchema(currentSchema!, htmlSchema) : undefined;
  const schema: ConvertResult['schema'] = opts.keepSchema ? 'kept' : pristine ? 'rewritten' : 'merged';
  const result: ConvertResult = {
    from: 'markdown',
    to: 'html',
    dryRun: opts.dryRun,
    pages: converted.map((c) => `wiki/${c.page.id}.html`),
    logEntries: entries.length,
    unresolvedLinks: unresolved,
    schema,
    schemaSectionsReplaced: merged?.replaced ?? [],
    backup: null,
  };
  if (opts.dryRun) return result;

  // 1. Write the HTML pages next to the markdown ones (no name clashes), then switch the format.
  for (const c of converted) fs.writeFileSync(path.join(paths.wiki, `${c.page.id}.html`), c.content);
  const oldIndex = paths.index;
  const oldLog = paths.log;
  paths.writeSettings('html', { convert: true });

  // 2. Move every markdown file the conversion replaces into the backup folder.
  const backupRel = path.join('.llm-wiki', 'backup', `markdown-${stamp(opts.now ?? new Date())}`);
  const backup = path.join(paths.root, backupRel);
  const moveToBackup = (abs: string) => {
    if (!fs.existsSync(abs)) return;
    const dest = path.join(backup, path.relative(paths.root, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
  };
  for (const c of converted) moveToBackup(c.page.abs);
  moveToBackup(oldIndex);
  moveToBackup(oldLog);
  if (schema !== 'kept') {
    const next = merged ? merged.text : htmlSchema;
    const agentsWasCopy = fs.existsSync(agentsFile) && fs.readFileSync(agentsFile, 'utf8') === currentSchema;
    moveToBackup(paths.schema);
    fs.writeFileSync(paths.schema, next);
    // AGENTS.md follows CLAUDE.md when it was a copy of it; a diverging AGENTS.md is merged on its own.
    if (fs.existsSync(agentsFile)) {
      const own = fs.readFileSync(agentsFile, 'utf8');
      const agentsNext = agentsWasCopy || own === schemaTemplate('markdown') ? next : mergeSchema(own, htmlSchema).text;
      moveToBackup(agentsFile);
      fs.writeFileSync(agentsFile, agentsNext);
    } else fs.writeFileSync(agentsFile, next);
  }

  // 3. Rebuild the generated files in the new format.
  ensureStylesheet(paths);
  writeLog(paths, entries);
  appendLog(paths, 'edit', 'Converted the wiki from markdown to HTML', `${converted.length} page(s) converted; the markdown files are kept in \`${backupRel.split(path.sep).join('/')}/\`.${schema === 'kept' ? ' CLAUDE.md / AGENTS.md were left untouched and still describe markdown pages.' : schema === 'merged' ? ` CLAUDE.md / AGENTS.md: sections replaced for HTML — ${merged!.replaced.join(', ')}; custom sections kept.` : ''}`);
  writeIndex(paths);
  new SearchStore(paths).reindex({ includeRaw: false });
  result.backup = backupRel.split(path.sep).join('/');
  return result;
}
