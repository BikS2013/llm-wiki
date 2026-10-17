/**
 * Ingesting from a URL: the document is downloaded into `raw/web/` and kept there unmodified, like any
 * other original. A web page (HTML) is also converted locally to `raw/web/<name>.html.md` — its main
 * content as markdown-like text, with the URL in the frontmatter — and that conversion is what the wiki
 * ingests. PDFs, Office files and images go through the usual converters (`parse`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { ConfigError, LlmWikiError } from '../errors.js';
import { sha256 } from '../search/store.js';
import { decodeEntities, htmlToText } from '../wiki/format.js';
import type { WikiPaths } from '../wiki/layout.js';
import { slugify, todayIso, withFrontmatter } from '../wiki/markdown.js';
import { DOCUMENT_MIME } from './extract.js';
import { FetchLedger, OriginLedger, ParseLedger, type FetchRecord } from './ledger.js';

export function isUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** Content types the tool can keep as a source, mapped to the extension the original is stored with. */
const TYPE_EXT: Record<string, string> = {
  'text/html': '.html',
  'application/xhtml+xml': '.html',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  ...Object.fromEntries(Object.entries(DOCUMENT_MIME).map(([ext, mime]) => [mime, ext === '.jpeg' ? '.jpg' : ext])),
};

const EXT_OK = new Set([...Object.values(TYPE_EXT), '.htm', '.markdown', '.rst', '.org', '.jpeg']);

export interface FetchResult {
  url: string;
  /** The downloaded original, e.g. `raw/web/example.com-article.html`. */
  originalRel: string;
  /** What to ingest: the markdown conversion of a web page, or the original itself. */
  sourceRel: string;
  /** False when an identical earlier download was reused. */
  downloaded: boolean;
}

function extensionFor(url: URL, contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  const byType = TYPE_EXT[type];
  if (byType) return byType;
  const ext = path.posix.extname(url.pathname).toLowerCase();
  if (EXT_OK.has(ext)) return ext;
  throw new LlmWikiError(`${url.href} returned "${type || 'no content type'}", which llm-wiki cannot ingest (supported: web pages, text, PDF, DOCX, PPTX, XLSX, images).`);
}

function baseName(url: URL): string {
  const pathPart = url.pathname.replace(/\/+$/, '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const slug = slugify(`${pathPart} ${url.search}`.trim()) || 'index';
  return `${url.hostname.replace(/^www\./, '')}-${slug}`.slice(0, 120);
}

interface Downloaded {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

/** GET with an optional conditional request; `undefined` means 304 Not Modified. */
async function download(url: string, maxBytes: number, conditional?: { etag?: string | undefined; lastModified?: string | undefined }): Promise<Downloaded | undefined> {
  let res: Response;
  const headers: Record<string, string> = { 'user-agent': 'llm-wiki (+https://github.com/biks2013-tools/llm-wiki)', accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8' };
  if (conditional?.etag) headers['if-none-match'] = conditional.etag;
  if (conditional?.lastModified) headers['if-modified-since'] = conditional.lastModified;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers });
  } catch (e) {
    throw new LlmWikiError(`Could not download ${url}: ${(e as Error).message}`);
  }
  if (res.status === 304) return undefined;
  if (!res.ok) throw new LlmWikiError(`Could not download ${url}: HTTP ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new LlmWikiError(`${url} is ${(declared / 1e6).toFixed(1)} MB, above the --max-bytes limit of ${(maxBytes / 1e6).toFixed(1)} MB.`);
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new LlmWikiError(`${url} is larger than the --max-bytes limit of ${(maxBytes / 1e6).toFixed(1)} MB; the tool never truncates sources.`);
      chunks.push(Buffer.from(chunk));
    }
  }
  return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '', finalUrl: res.url || url, etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined };
}

/** The readable part of a web page: `<article>` or `<main>` when present, without navigation, scripts or forms. */
export function webPageToMarkdown(html: string): { title: string | undefined; text: string } {
  const titleRaw = /<meta\b[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = titleRaw ? decodeEntities(titleRaw).replace(/\s+/g, ' ').trim() || undefined : undefined;
  let main = /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html)?.[1] ?? /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  main = main.replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|template|button|select)\b[\s\S]*?<\/\1\s*>/gi, '');
  return { title, text: htmlToText(main) };
}

/**
 * True when a page builds its content with JavaScript: almost no readable text, or a <noscript> / text
 * asking for JavaScript, or an empty application root such as `<div id="root"></div>`.
 */
export function needsRendering(html: string, text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  const scripted = /<script\b[^>]*\bsrc=|<script\b[^>]*>[\s\S]{200,}?<\/script>/i.test(html);
  if (words < 40 && scripted) return true;
  const noscript = [...html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)].map((m) => m[1]!).join(' ');
  if (/(enable|turn on|requires?|need)\s+(?:\w+\s+){0,3}javascript|javascript (is )?(required|disabled)/i.test(`${noscript} ${words < 150 ? text : ''}`)) return words < 150;
  return /<div\b[^>]*\bid="(root|app|__next|__nuxt)"[^>]*>\s*<\/div>/i.test(html) && words < 150;
}

/** Text hash used to decide whether a web page changed (markup, scripts and whitespace do not count). */
export function textHash(text: string): string {
  return sha256(text.replace(/\s+/g, ' ').trim());
}

/** Headless-browser helper for pages that need JavaScript: rendered DOM text and a printed PDF. */
export interface PageRenderer {
  /** The page's HTML after scripts ran. */
  dumpDom(url: string): Promise<string>;
  /** The page printed to PDF, as the browser's "Save as PDF" would. */
  printPdf(url: string): Promise<Buffer>;
}

/** A PageRenderer driving a Chromium-family browser (Chrome, Chromium, Edge, Brave) in headless mode. */
export function chromiumRenderer(browser: string): PageRenderer {
  const run = (args: string[], url: string): Promise<{ stdout: Buffer; dir: string }> =>
    new Promise((resolve, reject) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-render-'));
      const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=15000', '--run-all-compositor-stages-before-draw', ...args, url], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Chrome stalls when HOME is not the account's real home (keychain / crash-reporter lookups); always use it.
        env: { ...process.env, HOME: os.userInfo().homedir },
      });
      const out: Buffer[] = [];
      let err = '';
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new LlmWikiError(`Could not start the browser ${browser} (LLM_WIKI_BROWSER): ${e.message}`));
      });
      // 'exit', not 'close': Chrome's crash-handler helper inherits the pipes and can keep them open long after
      // the browser itself has finished. Give stdout a moment to drain, then settle.
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const settle = () => {
          if (code !== 0) reject(new LlmWikiError(`The browser ${browser} failed to render ${url} (${signal ? `killed by ${signal}` : `exit ${code}`}): ${err.split('\n').filter((l) => /error/i.test(l)).slice(-2).join(' ')}`));
          else resolve({ stdout: Buffer.concat(out), dir });
        };
        if (child.stdout.readableEnded) settle();
        else {
          const t = setTimeout(settle, 2000);
          child.stdout.once('end', () => {
            clearTimeout(t);
            settle();
          });
        }
      });
    });
  return {
    async dumpDom(url) {
      const { stdout, dir } = await run(['--dump-dom'], url);
      fs.rmSync(dir, { recursive: true, force: true });
      return stdout.toString('utf8');
    },
    async printPdf(url) {
      const target = path.join(os.tmpdir(), `llm-wiki-render-${process.pid}-${Date.now()}.pdf`);
      const { dir } = await run([`--print-to-pdf=${target}`, '--no-pdf-header-footer'], url);
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(target)) throw new LlmWikiError(`The browser did not produce a PDF for ${url}.`);
      const pdf = fs.readFileSync(target);
      fs.rmSync(target, { force: true });
      return pdf;
    },
  };
}

/** Chromium-family browsers found in the usual places, for the LLM_WIKI_BROWSER error message. */
export function browserCandidates(): string[] {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

export interface FetchOptions {
  maxBytes: number;
  /** Renders pages that need JavaScript; required only when such a page is met (or `render` is set). */
  renderer?: (() => PageRenderer) | undefined;
  /** Print the page to PDF with the browser even when its HTML has readable text. */
  render?: boolean | undefined;
  onEvent?: ((msg: string) => void) | undefined;
}

/** Saves bytes as a raw/web/ original named after the URL; an identical content hash reuses the latest copy. */
function storeOriginal(paths: WikiPaths, u: URL, ext: string, bytes: Buffer, previous: [string, FetchRecord] | undefined, contentHash: string): { abs: string; downloaded: boolean } {
  if (previous && previous[1].contentHash === contentHash && path.extname(previous[0]) === ext && fs.existsSync(path.join(paths.root, previous[0]))) {
    return { abs: path.join(paths.root, previous[0]), downloaded: false };
  }
  const dir = path.join(paths.raw, 'web');
  fs.mkdirSync(dir, { recursive: true });
  const base = baseName(u);
  let abs = path.join(dir, `${base}${ext}`);
  if (fs.existsSync(abs) && !fs.readFileSync(abs).equals(bytes)) {
    // raw/ is immutable: a changed page is kept as a new, dated original.
    let candidate = path.join(dir, `${base}-${todayIso()}${ext}`);
    for (let i = 2; fs.existsSync(candidate) && !fs.readFileSync(candidate).equals(bytes); i++) candidate = path.join(dir, `${base}-${todayIso()}-${i}${ext}`);
    abs = candidate;
  }
  const downloaded = !fs.existsSync(abs);
  if (downloaded) fs.writeFileSync(abs, bytes);
  return { abs, downloaded };
}

function writeWebConversion(paths: WikiPaths, originalRel: string, bytes: Buffer, finalUrl: string, title: string, text: string): string {
  const markdownRel = `${originalRel}.md`;
  const ledger = new ParseLedger(paths);
  if (ledger.isCurrent(originalRel, bytes) && fs.existsSync(path.join(paths.root, markdownRel))) return markdownRel;
  const today = todayIso();
  const body = `> **Fetched from <${finalUrl}>** on ${today} and converted locally (no LLM). The page as downloaded is kept unmodified as [[${originalRel}]].\n\n# ${title}\n\n${text}\n`;
  fs.writeFileSync(
    path.join(paths.root, markdownRel),
    withFrontmatter({ title, url: finalUrl, fetched_at: today, original: originalRel, original_type: 'HTML', original_sha256: sha256(bytes), parsed_by: 'llm-wiki/html-reader', parsed_at: today }, body),
  );
  ledger.record(originalRel, bytes, markdownRel, 'llm-wiki/html-reader');
  return markdownRel;
}

/**
 * Downloads `url` into raw/web/ and records where it came from. A web page with readable HTML is converted
 * locally to `<original>.html.md`; a page that builds its content with JavaScript (or any page with
 * `render`) is printed to PDF with the headless browser and kept as `<name>.pdf`, which the parser LLM then
 * converts. Unchanged content (same text hash) reuses the latest copy; changed content becomes a new, dated
 * original. Returns what to ingest.
 */
export async function fetchToRaw(paths: WikiPaths, url: string, opts: FetchOptions): Promise<FetchResult> {
  const log = opts.onEvent ?? (() => undefined);
  if (!isUrl(url)) throw new LlmWikiError(`Not an http(s) URL: ${url}`);
  const ledger = new FetchLedger(paths);
  const previous = ledger.latest(url);
  log(`downloading ${url}`);
  const got = (await download(url, opts.maxBytes))!;
  if (got.bytes.length === 0) throw new LlmWikiError(`${url} returned an empty document.`);
  const u = new URL(got.finalUrl);
  const ext = extensionFor(u, got.contentType);

  if (ext === '.html') {
    const html = got.bytes.toString('utf8');
    const page = webPageToMarkdown(html);
    if (opts.render || needsRendering(html, page.text)) {
      if (!opts.renderer) {
        const found = browserCandidates();
        throw new ConfigError(`${url} builds its content with JavaScript, so it must be rendered in a browser and saved as PDF. Set LLM_WIKI_BROWSER to a Chromium-family browser executable${found.length ? ` (found: ${found.join(', ')})` : ''}.`);
      }
      const renderer = opts.renderer();
      log(`${opts.render ? 'rendering' : 'the page needs JavaScript; rendering'} ${url} in the headless browser`);
      const dom = await renderer.dumpDom(got.finalUrl);
      const rendered = webPageToMarkdown(dom);
      if (rendered.text.trim() === '') throw new LlmWikiError(`${url} shows no text even after rendering (login wall or blocked headless browser?).`);
      const contentHash = textHash(rendered.text);
      const pdfPrev = previous && previous[1].rendered ? previous : undefined;
      if (pdfPrev && pdfPrev[1].contentHash === contentHash && fs.existsSync(path.join(paths.root, pdfPrev[0]))) {
        log(`${pdfPrev[0]} is unchanged since the last download (same rendered text)`);
        return { url, originalRel: pdfPrev[0], sourceRel: pdfPrev[0], downloaded: false };
      }
      const pdf = await renderer.printPdf(got.finalUrl);
      const { abs, downloaded } = storeOriginal(paths, u, '.pdf', pdf, undefined, contentHash);
      const originalRel = paths.relToRoot(abs);
      ledger.record(originalRel, { url, finalUrl: got.finalUrl, contentType: 'application/pdf', contentHash, etag: got.etag, lastModified: got.lastModified, rendered: true });
      log(`saved ${originalRel} (printed to PDF, ${(pdf.length / 1024).toFixed(0)} KB)`);
      return { url, originalRel, sourceRel: originalRel, downloaded };
    }
    const contentHash = textHash(page.text);
    const { abs, downloaded } = storeOriginal(paths, u, ext, got.bytes, previous, contentHash);
    const originalRel = paths.relToRoot(abs);
    ledger.record(originalRel, { url, finalUrl: got.finalUrl, contentType: got.contentType, contentHash, etag: got.etag, lastModified: got.lastModified });
    log(downloaded ? `saved ${originalRel} (${(got.bytes.length / 1024).toFixed(0)} KB)` : `${originalRel} is unchanged since the last download (same text)`);
    const sourceRel = writeWebConversion(paths, originalRel, fs.readFileSync(abs), got.finalUrl, page.title ?? u.hostname, page.text);
    return { url, originalRel, sourceRel, downloaded };
  }

  const contentHash = sha256(got.bytes);
  const { abs, downloaded } = storeOriginal(paths, u, ext, got.bytes, previous, contentHash);
  const originalRel = paths.relToRoot(abs);
  ledger.record(originalRel, { url, finalUrl: got.finalUrl, contentType: got.contentType, contentHash, etag: got.etag, lastModified: got.lastModified });
  log(downloaded ? `saved ${originalRel} (${(got.bytes.length / 1024).toFixed(0)} KB)` : `${originalRel} is unchanged since the last download`);
  return { url, originalRel, sourceRel: originalRel, downloaded };
}

export type SourceStatus = 'unchanged' | 'changed' | 'missing' | 'error';

export interface SourceCheck {
  kind: 'url' | 'file';
  /** The URL or the absolute path of the outside file. */
  origin: string;
  /** The latest raw copy of it. */
  raw: string;
  status: SourceStatus;
  detail?: string | undefined;
  /** When the recorded copy was made. */
  since: string;
}

/**
 * Compares every outside source (downloaded URLs and files copied in from outside the wiki) with its latest
 * raw copy by SHA-256: web pages by the hash of their readable (or rendered) text, everything else by
 * bytes. URLs use a conditional request first (ETag / Last-Modified). Writes nothing.
 */
export async function checkSources(paths: WikiPaths, opts: { maxBytes: number; renderer?: (() => PageRenderer) | undefined; onEvent?: ((msg: string) => void) | undefined }): Promise<SourceCheck[]> {
  const log = opts.onEvent ?? (() => undefined);
  const out: SourceCheck[] = [];
  for (const [rel, r] of new OriginLedger(paths).origins()) {
    const base = { kind: 'file' as const, origin: r.origin, raw: rel, since: r.stagedAt };
    if (!fs.existsSync(r.origin)) {
      out.push({ ...base, status: 'missing', detail: 'the outside file no longer exists' });
      continue;
    }
    out.push({ ...base, status: sha256(fs.readFileSync(r.origin)) === r.hash ? 'unchanged' : 'changed' });
  }
  for (const [rel, r] of new FetchLedger(paths).urls()) {
    const base = { kind: 'url' as const, origin: r.url, raw: rel, since: r.fetchedAt };
    try {
      log(`checking ${r.url}`);
      const got = await download(r.url, opts.maxBytes, { etag: r.etag, lastModified: r.lastModified });
      if (!got) {
        out.push({ ...base, status: 'unchanged', detail: 'not modified (HTTP 304)' });
        continue;
      }
      let hash: string;
      if (r.rendered) {
        if (!opts.renderer) throw new ConfigError('This page was rendered with a browser; set LLM_WIKI_BROWSER to check it.');
        hash = textHash(webPageToMarkdown(await opts.renderer().dumpDom(got.finalUrl)).text);
      } else if (extensionFor(new URL(got.finalUrl), got.contentType) === '.html') hash = textHash(webPageToMarkdown(got.bytes.toString('utf8')).text);
      else hash = sha256(got.bytes);
      // Downloads made before hashes were recorded: hash the stored raw copy the same way.
      let recorded = r.contentHash;
      if (recorded === undefined && fs.existsSync(path.join(paths.root, rel)) && !r.rendered) {
        const stored = fs.readFileSync(path.join(paths.root, rel));
        recorded = /\.html?$/i.test(rel) ? textHash(webPageToMarkdown(stored.toString('utf8')).text) : sha256(stored);
      }
      out.push({ ...base, status: hash === recorded ? 'unchanged' : 'changed' });
    } catch (e) {
      out.push({ ...base, status: 'error', detail: (e as Error).message });
    }
  }
  return out;
}
