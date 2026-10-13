import fs from 'node:fs';
import { todayIso } from './markdown.js';
import type { WikiPaths } from './layout.js';

export type LogKind = 'init' | 'ingest' | 'query' | 'lint' | 'edit' | 'note';

export interface LogEntry {
  date: string;
  kind: string;
  title: string;
  body: string;
}

const HEADER_RE = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z-]+) \| (.*)$/;

export function formatLogEntry(entry: LogEntry): string {
  const body = entry.body.trim();
  return `## [${entry.date}] ${entry.kind} | ${entry.title}\n${body === '' ? '' : `\n${body}\n`}`;
}

/** Appends one entry to `wiki/log.md` (append-only, `## [date] kind | title` prefix). */
export function appendLog(paths: WikiPaths, kind: LogKind, title: string, body = '', date = todayIso()): LogEntry {
  const entry: LogEntry = { date, kind, title: title.replace(/\r?\n/g, ' ').trim(), body };
  const existing = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8') : '';
  const prefix = existing === '' ? '# Log\n\nAppend-only record of ingests, queries, lint passes and edits. Newest at the bottom.\n\n' : existing.endsWith('\n') ? existing + '\n' : existing + '\n\n';
  fs.writeFileSync(paths.log, prefix + formatLogEntry(entry));
  return entry;
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
  return parseLog(fs.readFileSync(paths.log, 'utf8'));
}
