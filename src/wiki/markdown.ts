/** Markdown helpers: YAML-subset frontmatter, wikilinks, headings, slugs, chunking. */

export type FrontmatterValue = string | number | boolean | string[] | null;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  body: string;
  hasFrontmatter: boolean;
}

function parseScalar(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => String(parseScalar(s) ?? '')).filter((s) => s !== '');
  }
  return v;
}

/**
 * Parses a YAML subset that covers what wiki pages use: scalars, inline lists,
 * and block lists (`key:` followed by `- item` lines). Nested maps are not supported.
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: {}, body: content, hasFrontmatter: false };
  const fm: Frontmatter = {};
  const lines = m[1]!.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!;
    if (rest.trim() === '' && i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
        items.push(String(parseScalar(lines[i]!.replace(/^\s*-\s+/, '')) ?? ''));
        i++;
      }
      fm[key] = items;
    } else {
      fm[key] = parseScalar(rest);
    }
  }
  return { frontmatter: fm, body: content.slice(m[0].length), hasFrontmatter: true };
}

function serializeScalar(v: FrontmatterValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((s) => quoteIfNeeded(s)).join(', ')}]`;
  return quoteIfNeeded(v);
}

function quoteIfNeeded(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === '' || /[:#\[\]{},"'\n]|^\s|\s$|^(true|false|null|~)$|^-?\d/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${serializeScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export function withFrontmatter(fm: Frontmatter, body: string): string {
  return serializeFrontmatter(fm) + (body.startsWith('\n') ? body : `\n${body}`);
}

/** `Some Title!` → `some-title`. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

export interface WikiLink {
  /** Target as written, without alias or heading, e.g. `entities/foo` or `Foo`. */
  target: string;
  alias?: string;
  heading?: string;
  /** `wiki` for `[[...]]`, `md` for `[text](x.md)`. */
  kind: 'wiki' | 'md';
}

/** Extracts `[[target|alias]]`, `[[target#heading]]` and `[text](relative.md)` links. */
export function extractLinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  const stripped = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const wikiRe = /(?<!!)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(stripped)) !== null) {
    const link: WikiLink = { target: m[1]!.trim(), kind: 'wiki' };
    if (m[2]) link.heading = m[2].trim();
    if (m[3]) link.alias = m[3].trim();
    links.push(link);
  }
  const mdRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+?\.md)(?:#([^)]+))?\)/g;
  while ((m = mdRe.exec(stripped)) !== null) {
    const target = m[2]!;
    if (/^[a-z]+:\/\//i.test(target)) continue;
    const link: WikiLink = { target: decodeURIComponent(target), alias: m[1]!, kind: 'md' };
    if (m[3]) link.heading = m[3];
    links.push(link);
  }
  return links;
}

/** First `# Heading` in the body, if any. */
export function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m?.[1]?.trim();
}

export interface Section {
  /** Heading path such as `Overview > Details`, or `` for preamble. */
  heading: string;
  text: string;
}

/** Splits a body into heading-delimited sections (levels 1–3 start a new section). */
export function splitSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text !== '') sections.push({ heading: stack.map((s) => s.title).join(' > '), text });
    buf = [];
  };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush();
      const level = h[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: h[2]! });
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** Splits long sections at paragraph boundaries so chunks stay near `maxChars`. */
export function chunkSections(sections: Section[], maxChars = 1500): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    if (s.text.length <= maxChars) {
      out.push(s);
      continue;
    }
    const paras = s.text.split(/\n{2,}/);
    let cur = '';
    for (const p of paras) {
      if (cur !== '' && cur.length + p.length + 2 > maxChars) {
        out.push({ heading: s.heading, text: cur.trim() });
        cur = '';
      }
      if (p.length > maxChars) {
        for (let i = 0; i < p.length; i += maxChars) out.push({ heading: s.heading, text: p.slice(i, i + maxChars) });
        continue;
      }
      cur += (cur === '' ? '' : '\n\n') + p;
    }
    if (cur.trim() !== '') out.push({ heading: s.heading, text: cur.trim() });
  }
  return out;
}

/** Turns a plain string, list, or missing frontmatter value into a string list. */
export function asStringList(v: FrontmatterValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  return [String(v)];
}

/** Today's date in the local time zone as YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
