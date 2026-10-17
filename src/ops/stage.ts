import fs from 'node:fs';
import path from 'node:path';
import { LlmWikiError } from '../errors.js';
import type { WikiPaths } from '../wiki/layout.js';
import { todayIso } from '../wiki/markdown.js';
import { OriginLedger } from './ledger.js';

/** Copies an external file into raw/ (never overwrites a different file of the same name). Returns the root-relative path. */
export function stageSource(paths: WikiPaths, file: string): string {
  // Accept paths relative to the current directory or to the wiki root (`raw/<file>` as printed by lint/log).
  const candidates = path.isAbsolute(file) ? [file] : [path.resolve(file), path.resolve(paths.root, file)];
  const abs = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!abs) throw new LlmWikiError(`Source file not found: ${file} (looked in ${candidates.join(' and ')})`);
  if (abs.startsWith(paths.raw + path.sep)) return paths.relToRoot(abs);
  const bytes = fs.readFileSync(abs);
  const origins = new OriginLedger(paths);
  let dest = path.join(paths.raw, path.basename(abs));
  if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(bytes)) {
    // raw/ is immutable: a changed version of the same outside file is kept as a new, dated copy.
    const previous = origins.origins().find(([, r]) => r.origin === abs);
    if (!previous) throw new LlmWikiError(`raw/${path.basename(abs)} already exists with different content; rename the file before ingesting.`);
    const ext = path.extname(abs);
    const base = path.basename(abs, ext);
    dest = path.join(paths.raw, `${base}-${todayIso()}${ext}`);
    for (let i = 2; fs.existsSync(dest) && !fs.readFileSync(dest).equals(bytes); i++) dest = path.join(paths.raw, `${base}-${todayIso()}-${i}${ext}`);
  }
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, bytes);
  const rel = paths.relToRoot(dest);
  origins.record(rel, abs, bytes);
  return rel;
}
