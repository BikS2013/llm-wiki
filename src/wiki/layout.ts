import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { parseFrontmatter, extractLinks, firstHeading, type Frontmatter, type WikiLink } from './markdown.js';

export const RAW_DIR = 'raw';
export const WIKI_DIR = 'wiki';
export const STATE_DIR = '.llm-wiki';
export const INDEX_FILE = 'index.md';
export const LOG_FILE = 'log.md';
export const SCHEMA_FILE = 'CLAUDE.md';
export const AGENTS_FILE = 'AGENTS.md';
export const SPECIAL_FILES = new Set([INDEX_FILE, LOG_FILE]);

export const PAGE_TYPES = ['overview', 'entity', 'concept', 'source', 'synthesis', 'lint', 'other'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** Absolute paths of the three layers plus the tool's private state directory. */
export class WikiPaths {
  readonly root: string;
  readonly raw: string;
  readonly wiki: string;
  readonly state: string;
  readonly index: string;
  readonly log: string;
  readonly schema: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.raw = path.join(this.root, RAW_DIR);
    this.wiki = path.join(this.root, WIKI_DIR);
    this.state = path.join(this.root, STATE_DIR);
    this.index = path.join(this.wiki, INDEX_FILE);
    this.log = path.join(this.wiki, LOG_FILE);
    this.schema = path.join(this.root, SCHEMA_FILE);
  }

  /** Throws unless the root looks like an initialised wiki. */
  assertInitialised(): void {
    for (const dir of [this.raw, this.wiki, this.state]) {
      if (!fs.existsSync(dir)) {
        throw new WikiLayoutError(`${this.root} is not an initialised wiki (missing ${path.relative(this.root, dir)}/). Run: llm-wiki init ${this.root}`);
      }
    }
  }

  /** Path of a page relative to the wiki root, e.g. `wiki/entities/foo.md`. */
  relToRoot(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /** Absolute path for a page id such as `entities/foo` or `entities/foo.md`. */
  pageAbs(id: string): string {
    const clean = normalisePageId(id);
    const abs = path.resolve(this.wiki, `${clean}.md`);
    if (!abs.startsWith(this.wiki + path.sep)) throw new WikiLayoutError(`Page path escapes the wiki directory: ${id}`);
    return abs;
  }
}

/** `wiki/entities/foo.md`, `entities/foo.md`, `entities/foo`, `/entities/foo` → `entities/foo`. */
export function normalisePageId(id: string): string {
  let s = id.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (s.startsWith(`${WIKI_DIR}/`)) s = s.slice(WIKI_DIR.length + 1);
  if (s.toLowerCase().endsWith('.md')) s = s.slice(0, -3);
  if (s.includes('..')) throw new WikiLayoutError(`Page id must not contain "..": ${id}`);
  return s;
}

export interface Page {
  /** Id relative to `wiki/` without extension, e.g. `entities/foo`. */
  id: string;
  /** Path relative to the wiki root, e.g. `wiki/entities/foo.md`. */
  relPath: string;
  abs: string;
  title: string;
  type: PageType;
  frontmatter: Frontmatter;
  body: string;
  raw: string;
  links: WikiLink[];
  mtimeMs: number;
}

function inferType(id: string, fm: Frontmatter): PageType {
  const declared = typeof fm.type === 'string' ? fm.type.toLowerCase() : undefined;
  if (declared && (PAGE_TYPES as readonly string[]).includes(declared)) return declared as PageType;
  const top = id.split('/')[0] ?? '';
  const byDir: Record<string, PageType> = {
    entities: 'entity',
    concepts: 'concept',
    sources: 'source',
    syntheses: 'synthesis',
    lint: 'lint',
  };
  if (id === 'overview') return 'overview';
  return byDir[top] ?? 'other';
}

export function readPage(paths: WikiPaths, abs: string): Page {
  const raw = fs.readFileSync(abs, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const rel = path.relative(paths.wiki, abs).split(path.sep).join('/');
  const id = rel.replace(/\.md$/i, '');
  const title = (typeof frontmatter.title === 'string' && frontmatter.title.trim()) || firstHeading(body) || path.basename(id);
  return {
    id,
    relPath: `${WIKI_DIR}/${rel}`,
    abs,
    title,
    type: inferType(id, frontmatter),
    frontmatter,
    body,
    raw,
    links: extractLinks(body),
    mtimeMs: fs.statSync(abs).mtimeMs,
  };
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Every wiki page except index.md and log.md, sorted by id. */
export function listPages(paths: WikiPaths): Page[] {
  return walk(paths.wiki)
    .filter((abs) => abs.toLowerCase().endsWith('.md'))
    .filter((abs) => !(path.dirname(abs) === paths.wiki && SPECIAL_FILES.has(path.basename(abs))))
    .map((abs) => readPage(paths, abs))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every file under raw/ (any extension), as absolute paths. */
export function listRawFiles(paths: WikiPaths): string[] {
  return walk(paths.raw).sort();
}

export function writePage(paths: WikiPaths, id: string, content: string): string {
  const abs = paths.pageAbs(id);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`);
  return abs;
}

export function pageExists(paths: WikiPaths, id: string): boolean {
  return fs.existsSync(paths.pageAbs(id));
}

/**
 * Resolves link targets to page ids. Accepts `foo`, `entities/foo`, `wiki/entities/foo`,
 * with or without `.md`, matched by id, unique basename, or title (case-insensitive).
 */
export class LinkResolver {
  private readonly byId = new Map<string, Page>();
  private readonly byBase = new Map<string, Page[]>();
  private readonly byTitle = new Map<string, Page[]>();

  constructor(pages: Page[]) {
    for (const p of pages) {
      this.byId.set(p.id.toLowerCase(), p);
      const base = path.posix.basename(p.id).toLowerCase();
      this.byBase.set(base, [...(this.byBase.get(base) ?? []), p]);
      const t = p.title.toLowerCase();
      this.byTitle.set(t, [...(this.byTitle.get(t) ?? []), p]);
    }
  }

  resolve(target: string, fromId?: string): Page | undefined {
    let t = target.trim().replace(/\\/g, '/');
    if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
    if (fromId && (t.startsWith('./') || t.startsWith('../'))) {
      t = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), t));
    }
    if (t.startsWith(`${WIKI_DIR}/`)) t = t.slice(WIKI_DIR.length + 1);
    t = t.replace(/^\/+/, '');
    const direct = this.byId.get(t.toLowerCase());
    if (direct) return direct;
    const base = this.byBase.get(path.posix.basename(t).toLowerCase());
    if (base && base.length === 1 && !t.includes('/')) return base[0];
    const title = this.byTitle.get(t.toLowerCase());
    if (title && title.length === 1) return title[0];
    if (base && base.length > 1 && !t.includes('/')) return base[0];
    return undefined;
  }

  /** Shortest unambiguous link text for a page: basename if unique, else full id. */
  shortLink(page: Page): string {
    const base = path.posix.basename(page.id);
    const same = this.byBase.get(base.toLowerCase()) ?? [];
    return same.length === 1 ? base : page.id;
  }
}
