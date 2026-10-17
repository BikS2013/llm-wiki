import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { AGENTS_FILE, WikiPaths } from '../wiki/layout.js';
import { ensureStylesheet, writeIndex } from '../wiki/index.js';
import type { WikiFormat } from '../wiki/format.js';
import { appendLog } from '../wiki/log.js';
import { schemaTemplate } from './prompts.js';

export interface InitResult {
  root: string;
  format: WikiFormat;
  created: string[];
}

/**
 * Creates the three-layer layout, the schema files, the index and the log. `format` is required for
 * a new wiki; for an existing one (`force`) it may be omitted and must otherwise match the recorded format.
 */
export function initWiki(dir: string, opts: { force?: boolean; format?: WikiFormat | undefined } = {}): InitResult {
  const paths = new WikiPaths(dir);
  const created: string[] = [];
  if (fs.existsSync(paths.schema) && !opts.force) {
    throw new WikiLayoutError(`${paths.schema} already exists; this looks like an initialised wiki. Use --force to rewrite the schema files.`);
  }
  const existingWiki = isExistingWiki(paths);
  let format: WikiFormat;
  if (existingWiki) {
    format = paths.format.name;
    if (opts.format && opts.format !== format) throw new WikiLayoutError(`${paths.root} is a ${format} wiki; init cannot change its format (to convert markdown to HTML use "llm-wiki convert --to html").`);
  } else {
    if (!opts.format) throw new WikiLayoutError('Choose the page format of the new wiki: markdown or html.');
    format = opts.format;
  }
  const dirs = [
    paths.raw,
    path.join(paths.raw, 'assets'),
    paths.wiki,
    ...['sources', 'entities', 'concepts', 'syntheses', 'lint'].map((d) => path.join(paths.wiki, d)),
    paths.state,
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      created.push(d);
    }
  }
  if (!fs.existsSync(paths.settingsFile)) {
    paths.writeSettings(format);
    created.push(paths.settingsFile);
  }
  const schema = schemaTemplate(format);
  for (const file of [paths.schema, path.join(paths.root, AGENTS_FILE)]) {
    if (!fs.existsSync(file) || opts.force) {
      fs.writeFileSync(file, schema);
      created.push(file);
    }
  }
  const stateIgnore = path.join(paths.state, '.gitignore');
  if (!fs.existsSync(stateIgnore)) {
    fs.writeFileSync(stateIgnore, 'search-index.json\nembeddings.json\n');
    created.push(stateIgnore);
  }
  const css = ensureStylesheet(paths);
  if (css) created.push(css);
  if (writeIndex(paths)) created.push(paths.index);
  if (!fs.existsSync(paths.log)) {
    appendLog(paths, 'init', 'Wiki initialised', `Layout created by llm-wiki at ${paths.root}.`);
    created.push(paths.log);
  }
  return { root: paths.root, format, created };
}

/** True when the directory already holds a wiki whose page format is recorded or detectable. */
export function isExistingWiki(paths: WikiPaths): boolean {
  return fs.existsSync(paths.settingsFile) || fs.existsSync(path.join(paths.wiki, 'index.md')) || fs.existsSync(path.join(paths.wiki, 'index.html'));
}
