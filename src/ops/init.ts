import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { AGENTS_FILE, WikiPaths } from '../wiki/layout.js';
import { writeIndex } from '../wiki/index.js';
import { appendLog } from '../wiki/log.js';
import { schemaTemplate } from './prompts.js';

export interface InitResult {
  root: string;
  created: string[];
}

/** Creates the three-layer layout, the schema files, index.md and log.md. */
export function initWiki(dir: string, opts: { force?: boolean } = {}): InitResult {
  const paths = new WikiPaths(dir);
  const created: string[] = [];
  if (fs.existsSync(paths.schema) && !opts.force) {
    throw new WikiLayoutError(`${paths.schema} already exists; this looks like an initialised wiki. Use --force to rewrite the schema files.`);
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
  const schema = schemaTemplate();
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
  if (writeIndex(paths)) created.push(paths.index);
  if (!fs.existsSync(paths.log)) {
    appendLog(paths, 'init', 'Wiki initialised', `Layout created by llm-wiki at ${paths.root}.`);
    created.push(paths.log);
  }
  return { root: paths.root, created };
}
