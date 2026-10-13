import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { normalisePageId, pageExists, writePage, SPECIAL_FILES, type WikiPaths } from '../wiki/layout.js';
import { firstHeading, parseFrontmatter, todayIso, withFrontmatter, type Frontmatter } from '../wiki/markdown.js';

export type PageOp = 'create' | 'replace' | 'append';

export interface PageChange {
  op: PageOp;
  path: string;
  content: string;
  reason?: string;
}

export interface AppliedChange {
  id: string;
  op: PageOp;
  reason?: string | undefined;
}

/** Guarantees frontmatter with title/type/updated (and created on new pages) without clobbering what the model wrote. */
export function ensureFrontmatter(content: string, defaults: { id: string; sources?: string[]; existing?: string }): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const prev = defaults.existing ? parseFrontmatter(defaults.existing).frontmatter : {};
  const fm: Frontmatter = { ...prev, ...frontmatter };
  const today = todayIso();
  if (typeof fm.title !== 'string' || fm.title.trim() === '') fm.title = firstHeading(body) ?? path.posix.basename(defaults.id).replace(/-/g, ' ');
  if (typeof fm.type !== 'string') {
    const top = defaults.id.split('/')[0];
    const byDir: Record<string, string> = { entities: 'entity', concepts: 'concept', sources: 'source', syntheses: 'synthesis', lint: 'lint' };
    fm.type = defaults.id === 'overview' ? 'overview' : (byDir[top ?? ''] ?? 'other');
  }
  if (typeof fm.created !== 'string') fm.created = typeof prev.created === 'string' ? prev.created : today;
  fm.updated = today;
  if (defaults.sources && defaults.sources.length > 0) {
    const current = Array.isArray(fm.sources) ? fm.sources : typeof fm.sources === 'string' ? [fm.sources] : [];
    fm.sources = Array.from(new Set([...current, ...defaults.sources]));
  }
  return withFrontmatter(fm, body.replace(/^\n+/, ''));
}

function validateId(raw: string): string {
  const id = normalisePageId(raw);
  if (id === '' || SPECIAL_FILES.has(`${path.posix.basename(id)}.md`) && !id.includes('/')) throw new WikiLayoutError(`Refusing to write reserved page "${raw}".`);
  if (!/^[a-z0-9][a-z0-9/._-]*$/i.test(id)) throw new WikiLayoutError(`Page id "${raw}" contains characters outside [a-z0-9/._-].`);
  return id;
}

/** Applies model-proposed page changes; returns what was written. */
export function applyPageChanges(paths: WikiPaths, changes: PageChange[], sourceRel?: string): AppliedChange[] {
  const applied: AppliedChange[] = [];
  const sources = sourceRel ? [sourceRel] : [];
  for (const change of changes) {
    const id = validateId(change.path);
    const abs = paths.pageAbs(id);
    const exists = pageExists(paths, id);
    const existing = exists ? fs.readFileSync(abs, 'utf8') : undefined;
    let next: string;
    if (change.op === 'append') {
      if (!exists) {
        next = ensureFrontmatter(change.content, { id, sources });
      } else {
        const { frontmatter, body } = parseFrontmatter(existing!);
        const addition = parseFrontmatter(change.content).body.trim();
        next = ensureFrontmatter(withFrontmatter(frontmatter, `${body.trimEnd()}\n\n${addition}\n`), { id, sources, ...(existing !== undefined ? { existing } : {}) });
      }
    } else {
      next = ensureFrontmatter(change.content, { id, sources, ...(existing !== undefined ? { existing } : {}) });
    }
    writePage(paths, id, next);
    applied.push({ id, op: change.op === 'create' && exists ? 'replace' : change.op, reason: change.reason });
  }
  return applied;
}
