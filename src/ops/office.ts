/**
 * Local readers for Office Open XML packages (zip files of XML parts):
 * - PPTX → slide-by-slide structured text (titles, text in reading order, tables, chart data, picture
 *   alt text, speaker notes) plus the slide pictures, for the parser LLM to turn into markdown;
 * - XLSX → markdown tables, one per sheet, converted entirely locally (no LLM) so numbers stay exact.
 * Only the parts these formats need are read; the XML is parsed with targeted regular expressions.
 */
import path from 'node:path';
import JSZip from 'jszip';
import { LlmWikiError } from '../errors.js';
import { decodeEntities } from '../wiki/format.js';

// ---------------------------------------------------------------------------------------------
// shared helpers

async function openPackage(bytes: Buffer, what: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch (e) {
    throw new LlmWikiError(`${what} is not a readable Office file (${(e as Error).message}). Is it password-protected or an older .ppt/.xls file?`);
  }
}

async function readPart(zip: JSZip, name: string): Promise<string | undefined> {
  const f = zip.file(name);
  return f ? f.async('string') : undefined;
}

/** Relationship id → absolute part path, for the part at `partPath`. */
async function relationships(zip: JSZip, partPath: string): Promise<Map<string, { target: string; type: string }>> {
  const dir = path.posix.dirname(partPath);
  const relsPath = path.posix.join(dir, '_rels', `${path.posix.basename(partPath)}.rels`);
  const xml = (await readPart(zip, relsPath)) ?? '';
  const out = new Map<string, { target: string; type: string }>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    const type = /\bType="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (!id || !target || /\bTargetMode="External"/.test(attrs)) continue;
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir, decodeURIComponent(target)));
    out.set(id, { target: resolved, type });
  }
  return out;
}

function attr(xml: string, name: string): string | undefined {
  const v = new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];
  return v === undefined ? undefined : decodeEntities(v);
}

/** Text of DrawingML paragraphs (`<a:p>`), one string per paragraph with its indent level. */
function paragraphs(xml: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const inner = p[1]!;
    const level = Number(/<a:pPr\b[^>]*\blvl="(\d+)"/.exec(inner)?.[1] ?? '0');
    const text = [...inner.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)]
      .map((t) => (t[0].startsWith('<a:br') ? '\n' : decodeEntities(t[1]!)))
      .join('')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (text !== '') out.push({ level, text });
  }
  return out;
}

function cellText(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array<string>(width - r.length).fill('')].map(cellText));
  const [head, ...body] = norm;
  return [`| ${head!.join(' | ')} |`, `|${' --- |'.repeat(width)}`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// PPTX

export interface SlideImage {
  /** Media file name inside the package, e.g. `image3.png`. */
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  bytes: Buffer;
  /** Slides that show the picture. */
  slides: number[];
  alt?: string | undefined;
}

export interface PptxExtract {
  slides: number;
  /** Structured text with `<!-- slide N -->` markers and `[image: name]` references. */
  text: string;
  /** Distinct pictures in a supported format, in order of first appearance. */
  images: SlideImage[];
  /** Pictures that could not be sent (unsupported format such as EMF/WMF/TIFF/SVG). */
  unsupportedImages: string[];
}

const IMAGE_MIME: Record<string, SlideImage['mimeType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

interface Shape {
  y: number;
  x: number;
  order: number;
  render: () => Promise<string>;
}

async function chartText(zip: JSZip, chartPath: string): Promise<string> {
  const xml = (await readPart(zip, chartPath)) ?? '';
  const title = /<c:title>([\s\S]*?)<\/c:title>/.exec(xml);
  const titleText = title ? paragraphs(title[1]!).map((p) => p.text).join(' ') : '';
  const series: Array<{ name: string; cats: string[]; vals: string[] }> = [];
  for (const s of xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)) {
    const ser = s[1]!;
    const pts = (block: string | undefined) => {
      if (!block) return [];
      const pts: string[] = [];
      for (const pt of block.matchAll(/<c:pt idx="(\d+)">\s*<c:v>([\s\S]*?)<\/c:v>/g)) pts[Number(pt[1])] = decodeEntities(pt[2]!);
      return Array.from(pts, (v) => v ?? '');
    };
    const name = /<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(ser)?.[1];
    series.push({
      name: name ? decodeEntities(name) : `Series ${series.length + 1}`,
      cats: pts(/<c:(?:cat|xVal)>([\s\S]*?)<\/c:(?:cat|xVal)>/.exec(ser)?.[1]),
      vals: pts(/<c:(?:val|yVal)>([\s\S]*?)<\/c:(?:val|yVal)>/.exec(ser)?.[1]),
    });
  }
  const kind = /<c:(bar|line|pie|area|scatter|doughnut|radar|bubble|bar3D|line3D|pie3D|area3D)Chart>/.exec(xml)?.[1] ?? 'chart';
  if (series.length === 0) return `[chart (${kind})${titleText ? `: ${titleText}` : ''} — no cached data]`;
  const cats = series.reduce((a, s) => (s.cats.length > a.length ? s.cats : a), [] as string[]);
  const n = Math.max(cats.length, ...series.map((s) => s.vals.length));
  const rows = [['', ...series.map((s) => s.name)], ...Array.from({ length: n }, (_, i) => [cats[i] ?? String(i + 1), ...series.map((s) => s.vals[i] ?? '')])];
  return `[chart (${kind})${titleText ? `: ${titleText}` : ''} — data:]\n\n${markdownTable(rows)}`;
}

/**
 * Reads a .pptx: slides in presentation order, shapes in reading order (top to bottom, left to right),
 * titles, bullets with their levels, tables, chart data, picture alt text and speaker notes.
 */
export async function extractPptx(bytes: Buffer, what = 'the presentation'): Promise<PptxExtract> {
  const zip = await openPackage(bytes, what);
  const presentation = await readPart(zip, 'ppt/presentation.xml');
  if (!presentation) throw new LlmWikiError(`${what} has no ppt/presentation.xml; it is not a PowerPoint (.pptx) file.`);
  const presRels = await relationships(zip, 'ppt/presentation.xml');
  const slidePaths = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => presRels.get(m[1]!)?.target).filter((t): t is string => !!t);

  const images = new Map<string, SlideImage>();
  const unsupported = new Set<string>();
  const sections: string[] = [];

  for (const [i, slidePath] of slidePaths.entries()) {
    const n = i + 1;
    const xml = (await readPart(zip, slidePath)) ?? '';
    const rels = await relationships(zip, slidePath);
    const hidden = /<p:sld\b[^>]*\bshow="0"/.test(xml);
    const shapes: Shape[] = [];
    let title = '';
    let order = 0;
    const pos = (block: string) => {
      const off = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(block);
      return { x: off ? Number(off[1]) : 0, y: off ? Number(off[2]) : 0 };
    };

    for (const m of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
      const sp = m[1]!;
      const ph = /<p:ph\b([^>]*)\/?>/.exec(sp)?.[1] ?? '';
      const phType = attr(ph, 'type');
      if (phType === 'sldNum' || phType === 'dt' || phType === 'ftr') continue;
      const paras = paragraphs(/<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp)?.[1] ?? '');
      if (paras.length === 0) continue;
      if ((phType === 'title' || phType === 'ctrTitle') && title === '') {
        title = paras.map((p) => p.text).join(' ');
        continue;
      }
      const isBody = phType === 'body' || phType === undefined || phType === 'obj' || phType === 'subTitle';
      shapes.push({
        ...pos(sp),
        order: order++,
        render: async () => paras.map((p) => (isBody && paras.length > 1 ? `${'  '.repeat(p.level)}- ${p.text}` : p.text)).join('\n'),
      });
    }

    for (const m of xml.matchAll(/<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g)) {
      const gf = m[1]!;
      const tbl = /<a:tbl>([\s\S]*?)<\/a:tbl>/.exec(gf)?.[1];
      if (tbl) {
        const rows = [...tbl.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((r) => [...r[1]!.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((c) => paragraphs(c[1]!).map((p) => p.text).join(' ')));
        if (rows.length > 0) shapes.push({ ...pos(gf), order: order++, render: async () => markdownTable(rows) });
        continue;
      }
      const chartRid = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(gf)?.[1];
      const chartPath = chartRid ? rels.get(chartRid)?.target : undefined;
      if (chartPath) shapes.push({ ...pos(gf), order: order++, render: () => chartText(zip, chartPath) });
      else if (/<dgm:relIds\b/.test(gf)) {
        const name = attr(/<p:cNvPr\b[^>]*>/.exec(gf)?.[0] ?? '', 'name') ?? 'diagram';
        shapes.push({ ...pos(gf), order: order++, render: async () => `[SmartArt diagram: ${name}]` });
      }
    }

    for (const m of xml.matchAll(/<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g)) {
      const pic = m[1]!;
      const cNvPr = /<p:cNvPr\b[^>]*>/.exec(pic)?.[0] ?? '';
      const alt = attr(cNvPr, 'descr') || undefined;
      const rid = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(pic)?.[1];
      const target = rid ? rels.get(rid)?.target : undefined;
      if (!target) continue;
      const name = path.posix.basename(target);
      const mime = IMAGE_MIME[path.posix.extname(name).toLowerCase()];
      if (!mime) unsupported.add(name);
      else {
        const existing = images.get(target);
        if (existing) {
          if (!existing.slides.includes(n)) existing.slides.push(n);
        } else {
          const file = zip.file(target);
          if (file) images.set(target, { name, mimeType: mime, bytes: Buffer.from(await file.async('uint8array')), slides: [n], alt });
        }
      }
      shapes.push({ ...pos(pic), order: order++, render: async () => `[image: ${name}${mime ? '' : ' (format not sent to the model)'}${alt ? ` — alt text: "${alt}"` : ''}]` });
    }

    shapes.sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order);
    const parts = [`<!-- slide ${n} -->`, `# Slide ${n}${title ? `: ${title}` : ''}${hidden ? ' (hidden slide)' : ''}`];
    for (const s of shapes) parts.push(await s.render());

    const notesRel = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'));
    if (notesRel) {
      const notesXml = (await readPart(zip, notesRel.target)) ?? '';
      const notes = [...notesXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)]
        .filter((sp) => attr(/<p:ph\b([^>]*)\/?>/.exec(sp[1]!)?.[1] ?? '', 'type') === 'body')
        .flatMap((sp) => paragraphs(sp[1]!).map((p) => p.text));
      if (notes.length > 0) parts.push(`Speaker notes:\n${notes.join('\n')}`);
    }
    sections.push(parts.join('\n\n'));
  }
  return { slides: slidePaths.length, text: sections.join('\n\n'), images: [...images.values()], unsupportedImages: [...unsupported] };
}

// ---------------------------------------------------------------------------------------------
// XLSX

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function columnName(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel serial date → ISO date (and time when the serial has a fraction). */
export function excelDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400000);
  const d = new Date(epoch + ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function formatNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  // Excel stores binary doubles; show at most 15 significant digits, as Excel itself does.
  return String(Number(n.toPrecision(15)));
}

export interface XlsxExtract {
  sheets: Array<{ name: string; hidden: boolean; rows: number; columns: number }>;
  markdown: string;
}

/**
 * Converts every sheet of a .xlsx into a markdown table (the first used row is the header row). Cell
 * values are the stored ones: formulas show their last calculated value, dates become ISO dates,
 * percentages are shown with `%`. Nothing is summarised or dropped.
 */
export async function extractXlsx(bytes: Buffer, what = 'the workbook'): Promise<XlsxExtract> {
  const zip = await openPackage(bytes, what);
  const workbook = await readPart(zip, 'xl/workbook.xml');
  if (!workbook) throw new LlmWikiError(`${what} has no xl/workbook.xml; it is not an Excel (.xlsx) file.`);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const wbRels = await relationships(zip, 'xl/workbook.xml');

  const shared: string[] = [];
  const sst = (await readPart(zip, 'xl/sharedStrings.xml')) ?? '';
  for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const withoutPhonetic = si[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    shared.push([...withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1]!)).join(''));
  }

  const styles = (await readPart(zip, 'xl/styles.xml')) ?? '';
  const customFormats = new Map<number, string>();
  for (const f of styles.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) customFormats.set(Number(f[1]), decodeEntities(f[2]!));
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const styleKinds = [...cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((x) => {
    const id = Number(attr(x[1]!, 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(id)) return 'date';
    if (BUILTIN_PERCENT_FORMATS.has(id)) return 'percent';
    const code = customFormats.get(id);
    if (code) {
      const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      if (/%/.test(bare)) return 'percent';
      if (/[dmy]/i.test(bare) || /h+:m|m+:s/i.test(bare)) return 'date';
    }
    return 'general';
  });

  const sheets: XlsxExtract['sheets'] = [];
  const sections: string[] = [];
  for (const s of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = s[1]!;
    const name = attr(a, 'name') ?? `Sheet${sheets.length + 1}`;
    const hidden = /\bstate="(hidden|veryHidden)"/.test(a);
    const rid = /\br:id="([^"]+)"/.exec(a)?.[1];
    const sheetPath = rid ? wbRels.get(rid)?.target : undefined;
    const xml = sheetPath ? ((await readPart(zip, sheetPath)) ?? '') : '';
    const grid = new Map<number, Map<number, string>>();
    let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = c[1]!;
      const inner = c[2] ?? '';
      const ref = attr(ca, 'r');
      if (!ref) continue;
      const type = attr(ca, 't') ?? 'n';
      // An empty <v></v> (written by some libraries for formulas they did not calculate) is no value, not 0.
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || undefined;
      let value: string;
      if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : '';
      else if (type === 'inlineStr') value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1]!)).join('');
      else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (type === 'str' || type === 'e') value = v !== undefined ? decodeEntities(v) : '';
      else if (v === undefined) value = '';
      else {
        const kind = styleKinds[Number(attr(ca, 's') ?? '0')] ?? 'general';
        const num = Number(v);
        value = kind === 'date' && Number.isFinite(num) ? excelDate(num, date1904) : kind === 'percent' && Number.isFinite(num) ? `${formatNumber(String(num * 100))}%` : formatNumber(v);
      }
      if (value.trim() === '') {
        // A formula without a cached result (files written by libraries, never recalculated): show the formula.
        const formula = /<f\b[^>]*>([\s\S]+?)<\/f>/.exec(inner)?.[1];
        if (!formula) continue;
        value = `=${decodeEntities(formula)}`;
      }
      const row = Number(/\d+$/.exec(ref)?.[0] ?? '0') - 1;
      const col = columnIndex(ref);
      if (!grid.has(row)) grid.set(row, new Map());
      grid.get(row)!.set(col, value);
      minR = Math.min(minR, row); maxR = Math.max(maxR, row); minC = Math.min(minC, col); maxC = Math.max(maxC, col);
    }
    const heading = `## Sheet: ${name}${hidden ? ' (hidden)' : ''}`;
    if (maxR < 0) {
      sheets.push({ name, hidden, rows: 0, columns: 0 });
      sections.push(`${heading}\n\n_(empty sheet)_`);
      continue;
    }
    const rows: string[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const cells = grid.get(r);
      rows.push(Array.from({ length: maxC - minC + 1 }, (_, i) => cells?.get(minC + i) ?? ''));
    }
    // Drop fully empty rows inside the used range; they carry no information in a markdown table.
    const kept = rows.filter((r, i) => i === 0 || r.some((v) => v !== ''));
    const range = `${columnName(minC)}${minR + 1}:${columnName(maxC)}${maxR + 1}`;
    sheets.push({ name, hidden, rows: maxR - minR + 1, columns: maxC - minC + 1 });
    sections.push(`${heading}\n\n<!-- range ${range} -->\n\n${markdownTable(kept)}`);
  }
  if (sheets.length === 0) throw new LlmWikiError(`${what} contains no worksheets.`);
  return { sheets, markdown: sections.join('\n\n') };
}
