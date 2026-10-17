/**
 * Page formats. A wiki stores its pages either as markdown (`.md`, YAML frontmatter, `[[wikilinks]]`)
 * or as standalone HTML documents (`.html`, metadata in a JSON block, relative `<a href>` links) that
 * open directly in a browser. Everything above this module works on the same two parts of a page —
 * its metadata (`Frontmatter`) and its body — and on a markdown-like plain text of the body for
 * search, summaries and headings.
 */
import path from 'node:path';
import { marked } from 'marked';
import { WikiLayoutError } from '../errors.js';
import { extractLinks, parseFrontmatter, withFrontmatter, type Frontmatter, type FrontmatterValue, type WikiLink } from './markdown.js';

export const WIKI_FORMATS = ['markdown', 'html'] as const;
export type WikiFormat = (typeof WIKI_FORMATS)[number];

export function parseWikiFormat(value: string, setting = 'format'): WikiFormat {
  const v = value.trim().toLowerCase();
  if (v === 'markdown' || v === 'md') return 'markdown';
  if (v === 'html') return 'html';
  throw new WikiLayoutError(`Unknown ${setting} "${value}": expected markdown or html.`);
}

/** Turns a link target (already resolved to a page id, or a `raw/...` path) into what the page stores. */
export type LinkTargetResolver = (target: string) => string | undefined;

export interface PageFormat {
  readonly name: WikiFormat;
  /** File extension of pages, index and log: `.md` or `.html`. */
  readonly ext: '.md' | '.html';
  /** Splits a page file into metadata and stored body. */
  parse(content: string): { frontmatter: Frontmatter; body: string };
  /** Markdown-like plain text of a stored body (headings kept as `#` lines) for search, summaries and titles. */
  text(body: string): string;
  /** Links from a stored body to other wiki pages; targets are ids or link text the LinkResolver understands. */
  links(body: string, fromId: string): WikiLink[];
  /**
   * Converts an authored body into the stored body. Markdown keeps it as written. HTML accepts an HTML
   * fragment or markdown, turns `[[wikilinks]]` into relative `<a href>` links and strips active content.
   * Idempotent on stored bodies.
   */
  prepare(body: string, fromId: string, resolve: LinkTargetResolver): string;
  /** Serialises metadata and a stored body into the page file. `id` is `index`, `log` or a page id. */
  render(frontmatter: Frontmatter, body: string, id: string): string;
}

// ---------------------------------------------------------------------------------------------
// markdown

export const markdownFormat: PageFormat = {
  name: 'markdown',
  ext: '.md',
  parse: (content) => {
    const { frontmatter, body } = parseFrontmatter(content);
    return { frontmatter, body };
  },
  text: (body) => body,
  links: (body) => extractLinks(body),
  prepare: (body) => body,
  render: (frontmatter, body) => withFrontmatter(frontmatter, body.replace(/^\n+/, '')),
};

// ---------------------------------------------------------------------------------------------
// html

const META_ID = 'llm-wiki-meta';
const META_RE = new RegExp(`<script type="application/json" id="${META_ID}">([\\s\\S]*?)</script>`, 'i');
const MAIN_RE = /<main[^>]*>([\s\S]*)<\/main>/i;
const BODY_RE = /<body[^>]*>([\s\S]*)<\/body>/i;
const WIKILINK_RE = /(?<!!)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/** Scripts are disabled in every page; styles only from the wiki's own stylesheet and inline. */
const CSP = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; base-uri 'none'; form-action 'none'";

/** Stylesheet written to `wiki/wiki.css` when an HTML wiki is created. */
export const WIKI_CSS = `/* Stylesheet of an llm-wiki HTML wiki. Edit freely; llm-wiki only creates it when missing. */
:root { color-scheme: light dark; --fg: #1d1f23; --muted: #646a73; --bg: #fbfaf7; --rule: #dcd8cf; --accent: #9a4a26; --code: #f0ede6; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e4df; --muted: #9aa0a8; --bg: #17191c; --rule: #33363b; --accent: #e08a5e; --code: #22252a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
.wiki-nav { padding: 12px 24px; border-bottom: 1px solid var(--rule); font-size: 14px; }
.wiki-nav a { margin-right: 16px; }
main { max-width: 780px; margin: 0 auto; padding: 24px 24px 64px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.5em; }
h1 { margin-top: 0.4em; font-size: 2em; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a.wikilink-missing { color: var(--muted); text-decoration-style: dashed; }
blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid var(--accent); color: var(--muted); }
code, pre { font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code); border-radius: 4px; }
code { padding: 0.1em 0.3em; }
pre { padding: 12px 14px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; margin: 1em 0; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: 6px 10px; text-align: left; vertical-align: top; }
.log-entry { border-top: 1px solid var(--rule); padding-top: 4px; }
`;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', rarr: '→', larr: '←', times: '×', deg: '°', euro: '€' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Converts HTML into markdown-like plain text: headings as `#` lines, list items as `- `, cells split by `|`. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/(p|div|section|article|blockquote|pre|table|thead|tbody|tr|ul|ol|dl|dt|dd|figure|figcaption|header|footer|aside|nav|details|summary)\s*>/gi, '\n\n')
    .replace(/<(p|div|section|article|blockquote|pre|table|tr|ul|ol|dl|figure|header|footer|aside|details)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\n- [^\n]*)\n{2,}(?=- )/g, '$1\n');
  return s.trim();
}

/** Applies `fn` to the parts of `text` outside the segments matched by `protect` (code, pre). */
function outside(text: string, protect: RegExp, fn: (s: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(protect)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

const MD_CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const HTML_CODE = /<(pre|code)\b[\s\S]*?<\/\1\s*>/gi;

/** Relative href from page `fromId` to `target` (a page id, or a `raw/...` path outside wiki/). */
export function hrefBetween(fromId: string, target: string): string {
  const fromDir = path.posix.dirname(`wiki/${fromId}`);
  const to = target.startsWith('raw/') ? target : `wiki/${target}.html`;
  return path.posix.relative(fromDir, to).split('/').map(encodeURIComponent).join('/');
}

function wikilinksToAnchors(text: string, fromId: string, resolve: LinkTargetResolver): string {
  return text.replace(WIKILINK_RE, (_m, rawTarget: string, heading: string | undefined, alias: string | undefined) => {
    const target = rawTarget.trim();
    const label = escapeHtml((alias ?? target).trim());
    const resolved = resolve(target);
    if (resolved === undefined) {
      const guess = target.replace(/\\/g, '/').replace(/\.(md|html?)$/i, '').replace(/^wiki\//, '');
      return `<a class="wikilink wikilink-missing" href="${hrefBetween(fromId, guess)}">${label}</a>`;
    }
    const anchor = heading ? `#${encodeURIComponent(heading.trim().toLowerCase().replace(/\s+/g, '-'))}` : '';
    return `<a class="wikilink" href="${hrefBetween(fromId, resolved)}${anchor}">${label}</a>`;
  });
}

/** Best-effort removal of active content; the page CSP (`script-src 'none'`) is the real barrier. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|base|meta|link|form|input|button|textarea|select|html|head|body|main|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"');
}

function isFrontmatterValue(v: unknown): v is FrontmatterValue {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

function parseMeta(json: string): Frontmatter {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new WikiLayoutError(`The page's <script id="${META_ID}"> block is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new WikiLayoutError(`The page's <script id="${META_ID}"> block must hold a JSON object.`);
  const fm: Frontmatter = {};
  for (const [k, v] of Object.entries(data)) if (isFrontmatterValue(v)) fm[k] = v;
  return fm;
}

/** Links of a stored HTML body: relative `<a href>` to `.html` pages under wiki/ and to files under raw/, plus any leftover `[[wikilinks]]`. */
function htmlLinks(body: string, fromId: string): WikiLink[] {
  const links: WikiLink[] = [];
  const stripped = body.replace(HTML_CODE, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of stripped.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    let href = decodeEntities(m[1] ?? m[2] ?? '').trim();
    if (href === '' || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const hash = href.indexOf('#');
    const heading = hash >= 0 ? href.slice(hash + 1) : undefined;
    href = href.replace(/[?#].*$/, '');
    try {
      href = decodeURIComponent(href);
    } catch {
      /* keep as written */
    }
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(`wiki/${fromId}`), href));
    if (rel.startsWith('raw/')) {
      links.push({ target: rel, alias: htmlToText(m[3] ?? ''), kind: 'html' });
      continue;
    }
    if (!rel.startsWith('wiki/') || !/\.html?$/i.test(rel)) continue;
    const id = rel.slice('wiki/'.length).replace(/\.html?$/i, '');
    if (id === 'index' || id === 'log') continue;
    const link: WikiLink = { target: id, alias: htmlToText(m[3] ?? ''), kind: 'html' };
    if (heading) link.heading = heading;
    links.push(link);
  }
  for (const l of extractLinks(htmlToText(stripped))) if (l.kind === 'wiki') links.push(l);
  return links;
}

function metaJson(fm: Frontmatter): string {
  return JSON.stringify(fm, null, 2).replace(/</g, '\\u003c');
}

export const htmlFormat: PageFormat = {
  name: 'html',
  ext: '.html',
  parse: (content) => {
    const meta = META_RE.exec(content);
    const main = MAIN_RE.exec(content) ?? BODY_RE.exec(content);
    return { frontmatter: meta ? parseMeta(meta[1]!) : {}, body: (main ? main[1]! : content).replace(/^\n+/, '').trimEnd() };
  },
  text: (body) => htmlToText(body),
  links: (body, fromId) => htmlLinks(body, fromId),
  prepare: (body, fromId, resolve) => {
    const trimmed = body.trim();
    if (trimmed === '') return '';
    let html: string;
    if (trimmed.startsWith('<')) html = outside(trimmed, HTML_CODE, (s) => wikilinksToAnchors(s, fromId, resolve));
    else html = (marked.parse(outside(trimmed, MD_CODE, (s) => wikilinksToAnchors(s, fromId, resolve)), { async: false, gfm: true }) as string).trim();
    return sanitizeHtml(html);
  },
  render: (frontmatter, body, id) => {
    const up = '../'.repeat(id.split('/').length - 1);
    const title = typeof frontmatter.title === 'string' && frontmatter.title.trim() !== '' ? frontmatter.title : path.posix.basename(id);
    const summary = typeof frontmatter.summary === 'string' && frontmatter.summary.trim() !== '' ? `\n<meta name="description" content="${escapeHtml(frontmatter.summary)}">` : '';
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      `<meta name="generator" content="llm-wiki">`,
      `<title>${escapeHtml(title)}</title>${summary}`,
      `<link rel="stylesheet" href="${up}wiki.css">`,
      `<script type="application/json" id="${META_ID}">`,
      metaJson(frontmatter),
      '</script>',
      '</head>',
      '<body>',
      `<nav class="wiki-nav"><a href="${up}index.html">Index</a><a href="${up}log.html">Log</a></nav>`,
      '<main>',
      body.trim(),
      '</main>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  },
};

export function pageFormat(name: WikiFormat): PageFormat {
  return name === 'html' ? htmlFormat : markdownFormat;
}
