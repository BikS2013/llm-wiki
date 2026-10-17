import fs from 'node:fs';
import { todayIso } from './markdown.js';
import { escapeHtml, htmlToText } from './format.js';
import { LinkResolver, listPages, type WikiPaths } from './layout.js';

export type LogKind = 'init' | 'ingest' | 'query' | 'lint' | 'edit' | 'note';

export interface LogEntry {
  date: string;
  kind: string;
  title: string;
  body: string;
}

const HEADER_RE = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z-]+) \| (.*)$/;
const LOG_INTRO = 'Append-only record of ingests, queries, lint passes and edits. Newest at the bottom.';

export function formatLogEntry(entry: LogEntry): string {
  const body = entry.body.trim();
  return `## [${entry.date}] ${entry.kind} | ${entry.title}\n${body === '' ? '' : `\n${body}\n`}`;
}

/** Resolves `[[wikilinks]]` in log bodies against the wiki's current pages. */
function logResolver(paths: WikiPaths): (t: string) => string | undefined {
  const resolver = new LinkResolver(listPages(paths));
  return (t) => (t.startsWith('raw/') ? t : resolver.resolve(t)?.id);
}

/** One log entry as an HTML `<section>`; the body (markdown with `[[wikilinks]]`) becomes HTML. */
function htmlLogEntry(paths: WikiPaths, entry: LogEntry, resolve: (t: string) => string | undefined): string {
  const body = paths.format.prepare(entry.body, 'log', resolve);
  return `<section class="log-entry" data-date="${entry.date}" data-kind="${escapeHtml(entry.kind)}">\n<h2>[${entry.date}] ${escapeHtml(entry.kind)} | ${escapeHtml(entry.title)}</h2>\n${body}\n</section>\n`;
}

/**
 * Appends one entry to the log (append-only, `## [date] kind | title` headers). In HTML wikis the
 * entry becomes a `<section class="log-entry">` inserted at the end of `<main>` in `log.html`.
 */
export function appendLog(paths: WikiPaths, kind: LogKind, title: string, body = '', date = todayIso()): LogEntry {
  const entry: LogEntry = { date, kind, title: title.replace(/\r?\n/g, ' ').trim(), body };
  const existing = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8') : '';
  if (paths.format.name === 'html') {
    const shell = existing !== '' ? existing : htmlLogShell(paths);
    const at = shell.lastIndexOf('</main>');
    if (at < 0) throw new Error(`${paths.log} has no </main>; cannot append the log entry.`);
    fs.writeFileSync(paths.log, `${shell.slice(0, at)}${htmlLogEntry(paths, entry, logResolver(paths))}${shell.slice(at)}`);
    return entry;
  }
  const prefix = existing === '' ? `# Log\n\n${LOG_INTRO}\n\n` : existing.endsWith('\n') ? existing + '\n' : existing + '\n\n';
  fs.writeFileSync(paths.log, prefix + formatLogEntry(entry));
  return entry;
}

function htmlLogShell(paths: WikiPaths): string {
  return paths.format.render({ title: 'Log', type: 'log' }, `<h1>Log</h1>\n<p>${LOG_INTRO}</p>`, 'log');
}

/** Writes the whole log from entries in the wiki's format, replacing the file (used by `convert`). */
export function writeLog(paths: WikiPaths, entries: LogEntry[]): void {
  if (paths.format.name === 'html') {
    const resolve = logResolver(paths);
    const shell = htmlLogShell(paths);
    const at = shell.lastIndexOf('</main>');
    fs.writeFileSync(paths.log, `${shell.slice(0, at)}${entries.map((e) => htmlLogEntry(paths, e, resolve)).join('')}${shell.slice(at)}`);
    return;
  }
  fs.writeFileSync(paths.log, `# Log\n\n${LOG_INTRO}\n\n${entries.map(formatLogEntry).join('\n')}`);
}

export function parseLog(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: LogEntry | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      current.body = buf.join('\n').trim();
      entries.push(current);
    }
    buf = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      current = { date: m[1]!, kind: m[2]!, title: m[3]!, body: '' };
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return entries;
}

export function readLog(paths: WikiPaths): LogEntry[] {
  if (!fs.existsSync(paths.log)) return [];
  const content = fs.readFileSync(paths.log, 'utf8');
  return parseLog(paths.format.name === 'html' ? htmlToText(paths.format.parse(content).body) : content);
}
