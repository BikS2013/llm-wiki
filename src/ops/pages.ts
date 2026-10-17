import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { LinkResolver, listPages, normalisePageId, pageExists, writePage, SPECIAL_IDS, type WikiPaths } from '../wiki/layout.js';
import { firstHeading, parseFrontmatter, todayIso, withFrontmatter, type Frontmatter } from '../wiki/markdown.js';
import type { LinkTargetResolver } from '../wiki/format.js';

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

/** Fills title/type/created/updated/sources without clobbering what the author wrote. `text` is the body as plain text. */
export function completeFrontmatter(given: Frontmatter, text: string, defaults: { id: string; sources?: string[]; prev?: Frontmatter }): Frontmatter {
  const prev = defaults.prev ?? {};
  const fm: Frontmatter = { ...prev, ...given };
  const today = todayIso();
  if (typeof fm.title !== 'string' || fm.title.trim() === '') fm.title = firstHeading(text) ?? path.posix.basename(defaults.id).replace(/-/g, ' ');
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
  return fm;
}

/** Markdown form of completeFrontmatter(): guarantees frontmatter on markdown page content. */
export function ensureFrontmatter(content: string, defaults: { id: string; sources?: string[]; existing?: string }): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const prev = defaults.existing ? parseFrontmatter(defaults.existing).frontmatter : {};
  const fm = completeFrontmatter(frontmatter, body, { id: defaults.id, ...(defaults.sources ? { sources: defaults.sources } : {}), prev });
  return withFrontmatter(fm, body.replace(/^\n+/, ''));
}

/** Resolves `[[wikilink]]` targets for the HTML format: existing pages, extra ids being written, and raw/ paths. */
export function linkTargetResolver(paths: WikiPaths, extraIds: string[] = []): LinkTargetResolver {
  if (paths.format.name === 'markdown') return () => undefined;
  const resolver = new LinkResolver<{ id: string; title: string }>([...listPages(paths), ...extraIds.map((id) => ({ id, title: '' }))]);
  return (target) => {
    const t = target.trim().replace(/\\/g, '/');
    if (t.startsWith('raw/')) return t;
    return resolver.resolve(t)?.id;
  };
}

/** Reads a page as frontmatter + stored body, whatever the wiki's format. */
export function readPageParts(paths: WikiPaths, id: string): { frontmatter: Frontmatter; body: string } {
  return paths.format.parse(fs.readFileSync(paths.pageAbs(id), 'utf8'));
}

/** Writes a page from frontmatter and an authored body (markdown, or HTML for HTML wikis); returns the file path. */
export function writePageParts(paths: WikiPaths, id: string, fm: Frontmatter, body: string, resolve: LinkTargetResolver = linkTargetResolver(paths, [id])): string {
  const fmt = paths.format;
  return writePage(paths, id, fmt.render(fm, fmt.prepare(body, id, resolve), id));
}

function validateId(raw: string): string {
  const id = normalisePageId(raw);
  if (id === '' || (SPECIAL_IDS.has(id) && !id.includes('/'))) throw new WikiLayoutError(`Refusing to write reserved page "${raw}".`);
  if (!/^[a-z0-9][a-z0-9/._-]*$/i.test(id)) throw new WikiLayoutError(`Page id "${raw}" contains characters outside [a-z0-9/._-].`);
  return id;
}

/**
 * Applies page changes proposed by the model or an agent; returns what was written. Content is
 * YAML frontmatter followed by the body — markdown, or (in HTML wikis) an HTML fragment or markdown.
 */
export function applyPageChanges(paths: WikiPaths, changes: PageChange[], sourceRel?: string): AppliedChange[] {
  const fmt = paths.format;
  const applied: AppliedChange[] = [];
  const sources = sourceRel ? [sourceRel] : [];
  const ids = changes.map((c) => validateId(c.path));
  const resolve = linkTargetResolver(paths, ids);
  changes.forEach((change, i) => {
    const id = ids[i]!;
    const exists = pageExists(paths, id);
    const existing = exists ? readPageParts(paths, id) : undefined;
    const incoming = parseFrontmatter(change.content);
    const added = fmt.prepare(incoming.body.replace(/^\n+/, ''), id, resolve);
    let given: Frontmatter;
    let body: string;
    if (change.op === 'append' && existing) {
      given = existing.frontmatter;
      body = `${existing.body.trimEnd()}\n\n${added.trim()}\n`;
    } else {
      given = incoming.frontmatter;
      body = added;
    }
    const fm = completeFrontmatter(given, fmt.text(body), { id, sources, ...(existing ? { prev: existing.frontmatter } : {}) });
    writePage(paths, id, fmt.render(fm, body, id));
    applied.push({ id, op: change.op === 'create' && exists ? 'replace' : change.op, reason: change.reason });
  });
  return applied;
}

/**
 * HTML wikis: rewrites pages whose body still holds `[[wikilinks]]` (hand edits) so the links become
 * relative `<a href>` links. Returns the ids rewritten; a no-op for markdown wikis.
 */
export function linkHtmlPages(paths: WikiPaths): string[] {
  if (paths.format.name !== 'html') return [];
  const pending = listPages(paths).filter((p) => /\[\[[^\]]+\]\]/.test(p.body.replace(/<(pre|code)\b[\s\S]*?<\/\1\s*>/gi, '')));
  if (pending.length === 0) return [];
  const resolve = linkTargetResolver(paths);
  for (const p of pending) writePage(paths, p.id, paths.format.render(p.frontmatter, paths.format.prepare(p.body, p.id, resolve), p.id));
  return pending.map((p) => p.id);
}
