import fs from 'node:fs';
import path from 'node:path';
import { WikiLayoutError } from '../errors.js';
import { firstHeading, withFrontmatter, type Frontmatter, type WikiLink } from './markdown.js';
import { pageFormat, parseWikiFormat, type PageFormat, type WikiFormat } from './format.js';

export const RAW_DIR = 'raw';
export const WIKI_DIR = 'wiki';
export const STATE_DIR = '.llm-wiki';
export const INDEX_NAME = 'index';
export const LOG_NAME = 'log';
export const SCHEMA_FILE = 'CLAUDE.md';
export const AGENTS_FILE = 'AGENTS.md';
/** Ids of the generated files at the top of wiki/ (index and log), never pages. */
export const SPECIAL_IDS = new Set([INDEX_NAME, LOG_NAME]);
/** `.llm-wiki/wiki.json` — per-wiki settings fixed at init (the page format). */
export const WIKI_SETTINGS_FILE = 'wiki.json';

export interface WikiSettings {
  version: 1;
  format: WikiFormat;
}

export const PAGE_TYPES = ['overview', 'entity', 'concept', 'source', 'synthesis', 'lint', 'other'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** Absolute paths of the three layers plus the tool's private state directory. */
export class WikiPaths {
  readonly root: string;
  readonly raw: string;
  readonly wiki: string;
  readonly state: string;
  readonly schema: string;
  readonly settingsFile: string;
  private cachedFormat: PageFormat | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.raw = path.join(this.root, RAW_DIR);
    this.wiki = path.join(this.root, WIKI_DIR);
    this.state = path.join(this.root, STATE_DIR);
    this.schema = path.join(this.root, SCHEMA_FILE);
    this.settingsFile = path.join(this.state, WIKI_SETTINGS_FILE);
  }

  /**
   * The wiki's page format, recorded in `.llm-wiki/wiki.json` at init. Wikis created before the
   * setting existed have no such file; their format is read off the index file that is present.
   */
  get format(): PageFormat {
    if (this.cachedFormat) return this.cachedFormat;
    let name: WikiFormat;
    if (fs.existsSync(this.settingsFile)) {
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      } catch (e) {
        throw new WikiLayoutError(`${this.settingsFile} is not valid JSON (${(e as Error).message}); fix it by hand — it records the wiki's page format.`);
      }
      const fmt = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).format : undefined;
      if (typeof fmt !== 'string') throw new WikiLayoutError(`${this.settingsFile} has no "format" (markdown or html).`);
      name = parseWikiFormat(fmt, `format in ${this.settingsFile}`);
    } else {
      const md = fs.existsSync(path.join(this.wiki, `${INDEX_NAME}.md`));
      const html = fs.existsSync(path.join(this.wiki, `${INDEX_NAME}.html`));
      if (md === html) {
        throw new WikiLayoutError(`Cannot tell the page format of ${this.root}: ${this.settingsFile} is missing and wiki/ holds ${md ? 'both index.md and index.html' : 'neither index.md nor index.html'}. Create ${this.settingsFile} with {"version":1,"format":"markdown"} or {"version":1,"format":"html"}.`);
      }
      name = md ? 'markdown' : 'html';
    }
    this.cachedFormat = pageFormat(name);
    return this.cachedFormat;
  }

  /** Records the page format of a new wiki. Refuses to change the format of an existing one unless `convert` says so. */
  writeSettings(format: WikiFormat, opts: { convert?: boolean } = {}): void {
    if (!opts.convert && fs.existsSync(this.settingsFile) && this.format.name !== format) {
      throw new WikiLayoutError(`${this.root} is a ${this.format.name} wiki; its format cannot be set to ${format} here (use "llm-wiki convert --to html").`);
    }
    fs.mkdirSync(this.state, { recursive: true });
    const settings: WikiSettings = { version: 1, format };
    fs.writeFileSync(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    this.cachedFormat = pageFormat(format);
  }

  get index(): string {
    return path.join(this.wiki, `${INDEX_NAME}${this.format.ext}`);
  }

  get log(): string {
    return path.join(this.wiki, `${LOG_NAME}${this.format.ext}`);
  }

  /** Root-relative path of a page id, e.g. `wiki/entities/foo.md` or `wiki/entities/foo.html`. */
  pageRel(id: string): string {
    return `${WIKI_DIR}/${normalisePageId(id)}${this.format.ext}`;
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

  /** Absolute path for a page id such as `entities/foo`, `entities/foo.md` or `entities/foo.html`. */
  pageAbs(id: string): string {
    const clean = normalisePageId(id);
    const abs = path.resolve(this.wiki, `${clean}${this.format.ext}`);
    if (!abs.startsWith(this.wiki + path.sep)) throw new WikiLayoutError(`Page path escapes the wiki directory: ${id}`);
    return abs;
  }
}

/** `wiki/entities/foo.md`, `entities/foo.html`, `entities/foo`, `/entities/foo` → `entities/foo`. */
export function normalisePageId(id: string): string {
  let s = id.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (s.startsWith(`${WIKI_DIR}/`)) s = s.slice(WIKI_DIR.length + 1);
  s = s.replace(/\.(md|html?)$/i, '');
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
  /** Stored body: markdown, or the HTML inside `<main>` for HTML wikis. */
  body: string;
  /** Markdown-like plain text of the body (equal to `body` for markdown wikis). */
  text: string;
  /** The page as an editor sees it: frontmatter + stored body (equal to the file for markdown wikis). */
  source: string;
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
  const fmt = paths.format;
  const raw = fs.readFileSync(abs, 'utf8');
  const rel = path.relative(paths.wiki, abs).split(path.sep).join('/');
  const id = rel.replace(/\.(md|html?)$/i, '');
  let parsed: { frontmatter: Frontmatter; body: string };
  try {
    parsed = fmt.parse(raw);
  } catch (e) {
    throw new WikiLayoutError(`${WIKI_DIR}/${rel}: ${(e as Error).message}`);
  }
  const { frontmatter, body } = parsed;
  const text = fmt.text(body);
  const title = (typeof frontmatter.title === 'string' && frontmatter.title.trim()) || firstHeading(text) || path.basename(id);
  return {
    id,
    relPath: `${WIKI_DIR}/${rel}`,
    abs,
    title,
    type: inferType(id, frontmatter),
    frontmatter,
    body,
    text,
    source: fmt.name === 'markdown' ? raw : withFrontmatter(frontmatter, body),
    raw,
    links: fmt.links(body, id),
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

/** Files under wiki/ in the wiki's page format, except the index and log, as absolute paths. */
function pageFiles(paths: WikiPaths): string[] {
  const ext = paths.format.ext;
  return walk(paths.wiki)
    .filter((abs) => abs.toLowerCase().endsWith(ext))
    .filter((abs) => !(path.dirname(abs) === paths.wiki && SPECIAL_IDS.has(path.basename(abs, ext))));
}

/** Files under wiki/ in the other page format (`.md` in an HTML wiki, `.html` in a markdown wiki). */
export function foreignPageFiles(paths: WikiPaths): string[] {
  const other = paths.format.name === 'html' ? /\.md$/i : /\.html?$/i;
  return walk(paths.wiki).filter((abs) => other.test(abs)).sort();
}

/** Every wiki page except the index and the log, sorted by id. */
export function listPages(paths: WikiPaths): Page[] {
  return pageFiles(paths)
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
 * with or without `.md`/`.html`, matched by id, unique basename, or title (case-insensitive).
 */
export class LinkResolver<P extends { id: string; title: string } = Page> {
  private readonly byId = new Map<string, P>();
  private readonly byBase = new Map<string, P[]>();
  private readonly byTitle = new Map<string, P[]>();

  constructor(pages: P[]) {
    for (const p of pages) {
      this.byId.set(p.id.toLowerCase(), p);
      const base = path.posix.basename(p.id).toLowerCase();
      this.byBase.set(base, [...(this.byBase.get(base) ?? []), p]);
      const t = p.title.toLowerCase();
      this.byTitle.set(t, [...(this.byTitle.get(t) ?? []), p]);
    }
  }

  resolve(target: string, fromId?: string): P | undefined {
    let t = target.trim().replace(/\\/g, '/');
    t = t.replace(/\.(md|html?)$/i, '');
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
  shortLink(page: P): string {
    const base = path.posix.basename(page.id);
    const same = this.byBase.get(base.toLowerCase()) ?? [];
    return same.length === 1 ? base : page.id;
  }
}
