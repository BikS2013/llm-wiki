import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { Config } from '../src/config/env.js';
import type { DocumentParser, ParseRequest } from '../src/llm/types.js';
import { IMAGE_MIMES } from '../src/llm/types.js';
import { documentMime, isParsableDocument, needsParserLlm } from '../src/ops/extract.js';
import { ingestSource, pendingSources } from '../src/ops/ingest.js';
import { columnName, excelDate, extractPptx, extractXlsx } from '../src/ops/office.js';
import { parseDocument } from '../src/ops/parse.js';
import { parseFrontmatter } from '../src/wiki/markdown.js';
import { FakeChat, tempWiki } from './helpers.js';

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const rels = (items: Array<[string, string, string]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const para = (text: string, lvl = 0) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
const off = (y: number, x = 100) => `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>`;
const sp = (name: string, ph: string | null, y: number, paras: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>${off(y)}<p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
const pic = (rid: string, descr: string, y: number) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture" descr="${descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill>${off(y)}</p:pic>`;
const frame = (y: number, inner: string) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Frame"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100" y="${y}"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData>${inner}</a:graphicData></a:graphic></p:graphicFrame>`;

/** A two-slide deck: title, bullets, a table, a chart, a picture, speaker notes, a hidden slide reusing the picture. */
export async function samplePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']]));
  const table = `<a:tbl><a:tr h="1"><a:tc><a:txBody>${para('Region')}</a:txBody></a:tc><a:tc><a:txBody>${para('Sales')}</a:txBody></a:tc></a:tr><a:tr h="1"><a:tc><a:txBody>${para('North')}</a:txBody></a:tc><a:tc><a:txBody>${para('1,200')}</a:txBody></a:tc></a:tr></a:tbl>`;
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld ${P}><p:cSld><p:spTree>` +
      pic('rId5', 'Revenue chart screenshot', 9000) + // first in XML, last in reading order
      sp('Title 1', 'title', 0, para('Quarterly review &amp; outlook')) +
      sp('Content', 'body', 2000, para('Revenue up 12%') + para('North led', 1)) +
      frame(3000, table) +
      frame(4000, '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId7"/>') +
      sp('Slide Number', 'sldNum', 10000, para('1')) +
      `</p:spTree></p:cSld></p:sld>`,
  );
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId5', 'image', '../media/image1.png'], ['rId6', 'notesSlide', '../notesSlides/notesSlide1.xml'], ['rId7', 'chart', '../charts/chart1.xml']]));
  zip.file(
    'ppt/charts/chart1.xml',
    `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:title><c:tx><c:rich>${para('Revenue by quarter')}</c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2025</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
  );
  zip.file('ppt/notesSlides/notesSlide1.xml', `<p:notes ${P}><p:cSld><p:spTree>${sp('Slide Image', 'sldImg', 0, '')}${sp('Notes', 'body', 1, para('Mention the new region.'))}${sp('Num', 'sldNum', 2, para('1'))}</p:spTree></p:cSld></p:notes>`);
  zip.file('ppt/slides/slide2.xml', `<p:sld ${P} show="0"><p:cSld><p:spTree>${sp('T', 'title', 0, para('Appendix'))}${pic('rId1', '', 100)}${pic('rId2', 'icon', 200)}${pic('rId3', 'logo', 300)}</p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/_rels/slide2.xml.rels', rels([['rId1', 'image', '../media/image1.png'], ['rId2', 'image', '../media/image2.png'], ['rId3', 'image', '../media/image3.emf']]));
  zip.file('ppt/media/image1.png', Buffer.alloc(6000, 1));
  zip.file('ppt/media/image2.png', Buffer.alloc(100, 2)); // an icon: below the size threshold
  zip.file('ppt/media/image3.emf', Buffer.alloc(9000, 3)); // unsupported format
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A workbook with strings, numbers, a date, a percentage, a formula, a boolean, a hidden and an empty sheet. */
export async function sampleXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<workbook xmlns:r="${REL}"><workbookPr/><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Empty" sheetId="3" r:id="rId3"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'worksheet', 'worksheets/sheet3.xml']]));
  zip.file('xl/sharedStrings.xml', `<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Date</t></si><si><t>Share</t></si><si><r><t>Laptop | </t></r><r><t>pro</t></r></si><si><t>secret</t></si></sst>`);
  zip.file('xl/styles.xml', `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`);
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet><sheetData>` +
      `<row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c><c r="D2" t="s"><v>2</v></c><c r="E2" t="s"><v>3</v></c></row>` +
      `<row r="3"><c r="B3" t="s"><v>4</v></c><c r="C3"><v>1234.5</v></c><c r="D3" s="1"><v>45292</v></c><c r="E3" s="2"><v>0.25</v></c></row>` +
      `<row r="4"><c r="B4"/></row>` +
      `<row r="5"><c r="B5" t="inlineStr"><is><t>Total</t></is></c><c r="C5"><f>SUM(C3:C3)</f><v>1234.5000000000002</v></c><c r="F5" t="b"><v>1</v></c></row>` +
      `<row r="6"><c r="C6"><f>C5*2</f></c><c r="D6" s="2"><f>C6/10</f><v></v></c></row>` +
      `</sheetData></worksheet>`,
  );
  zip.file('xl/worksheets/sheet2.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>`);
  zip.file('xl/worksheets/sheet3.xml', `<worksheet><sheetData/></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

class VisionParser implements DocumentParser {
  readonly provider = 'fake';
  readonly model = 'vision-model';
  readonly requests: ParseRequest[] = [];
  constructor(private readonly reply = '# Converted\n\nBody.') {}
  nativeMimeTypes(): ReadonlySet<string> {
    return new Set(['application/pdf', ...IMAGE_MIMES]);
  }
  async parseDocument(req: ParseRequest): Promise<string> {
    this.requests.push(req);
    return this.reply;
  }
}

const noParser = () => {
  throw new Error('the parser LLM must not be used');
};

test('document types: new formats are parsable; legacy formats are refused with a hint', () => {
  for (const f of ['a.pptx', 'b.XLSX', 'c.png', 'd.JPG', 'e.jpeg', 'f.gif', 'g.webp']) assert.ok(isParsableDocument(f), f);
  assert.equal(needsParserLlm('b.xlsx'), false);
  assert.equal(needsParserLlm('a.pptx') && needsParserLlm('c.png'), true);
  assert.throws(() => documentMime('old.ppt'), /save it as \.pptx/);
  assert.throws(() => documentMime('photo.heic'), /convert it to JPEG or PNG/);
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(27), 'AB');
  assert.equal(excelDate(45292, false), '2024-01-01');
  assert.equal(excelDate(45292.5, false), '2024-01-01 12:00:00');
});

test('extractPptx: slides in order, reading order, tables, chart data, notes, pictures deduplicated', async () => {
  const x = await extractPptx(await samplePptx());
  assert.equal(x.slides, 2);
  const s1 = x.text.slice(0, x.text.indexOf('<!-- slide 2 -->'));
  assert.match(s1, /^<!-- slide 1 -->\n\n# Slide 1: Quarterly review & outlook/);
  assert.match(s1, /- Revenue up 12%\n {2}- North led/);
  assert.match(s1, /\| Region \| Sales \|\n\| --- \| --- \|\n\| North \| 1,200 \|/);
  assert.match(s1, /\[chart \(bar\): Revenue by quarter — data:\][\s\S]*\| Q1 \| 10 \|\n\| Q2 \| 12\.5 \|/);
  assert.match(s1, /Speaker notes:\nMention the new region\./);
  assert.ok(s1.indexOf('Revenue up 12%') < s1.indexOf('| Region') && s1.indexOf('[chart') < s1.indexOf('[image: image1.png'), 'shapes follow reading order');
  assert.doesNotMatch(s1, /\n1\n/, 'slide numbers are skipped');
  assert.match(x.text, /# Slide 2: Appendix \(hidden slide\)/);
  assert.deepEqual(x.images.map((i) => [i.name, i.slides, i.alt]), [['image1.png', [1, 2], 'Revenue chart screenshot'], ['image2.png', [2], 'icon']]);
  assert.deepEqual(x.unsupportedImages, ['image3.emf']);
  await assert.rejects(extractPptx(Buffer.from('not a zip')), /not a readable Office file/);
});

test('extractXlsx: one markdown table per sheet with exact values', async () => {
  const x = await extractXlsx(await sampleXlsx());
  assert.deepEqual(x.sheets, [
    { name: 'Budget & plan', hidden: false, rows: 5, columns: 5 },
    { name: 'Hidden', hidden: true, rows: 1, columns: 1 },
    { name: 'Empty', hidden: false, rows: 0, columns: 0 },
  ]);
  assert.match(x.markdown, /## Sheet: Budget & plan\n\n<!-- range B2:F6 -->/);
  assert.match(x.markdown, /\|  \| =C5\*2 \| =C6\/10 \|  \|  \|/, 'a formula without a cached value is shown as the formula');
  assert.match(x.markdown, /\| Item \| Cost \| Date \| Share \|  \|\n\| --- \| --- \| --- \| --- \| --- \|/);
  assert.match(x.markdown, /\| Laptop \\\| pro \| 1234\.5 \| 2024-01-01 \| 25% \|  \|/);
  assert.match(x.markdown, /\| Total \| 1234\.5 \|  \|  \| TRUE \|/, 'formula shows its value, rounded to 15 digits; blank row dropped');
  assert.match(x.markdown, /## Sheet: Hidden \(hidden\)\n\n<!-- range A1:A1 -->\n\n\| secret \|/);
  assert.match(x.markdown, /## Sheet: Empty\n\n_\(empty sheet\)_/);
});

test('parse: XLSX is converted locally without the parser LLM', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'budget.xlsx'), await sampleXlsx());
  const r = await parseDocument(paths, noParser, 'raw/budget.xlsx', { force: false, maxTokens: 1000, maxBytes: 1_000_000 });
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(paths.root, r.markdownRel), 'utf8'));
  assert.equal(frontmatter.original_type, 'XLSX');
  assert.equal(frontmatter.parsed_by, 'llm-wiki/xlsx-reader');
  assert.match(body, /by llm-wiki locally \(no LLM/);
  assert.match(body, /# budget\n\nWorkbook with 3 sheet\(s\): Budget & plan — 5 row\(s\) × 5 column\(s\)/);
});

test('parse: PPTX sends the extracted slides plus the pictures; skipped pictures are recorded', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'review.pptx'), await samplePptx());
  const parser = new VisionParser('# Quarterly review\n\n## Slide 1 — Quarterly review');
  const r = await parseDocument(paths, parser, 'raw/review.pptx', { force: false, maxTokens: 1000, maxBytes: 1_000_000 });
  const req = parser.requests[0]!;
  assert.match(req.extractedText ?? '', /<!-- slide 1 -->/);
  assert.deepEqual(req.images?.map((i) => i.label), ['image1.png (slides 1, 2) — alt text: "Revenue chart screenshot"']);
  assert.match(req.instruction, /## Slide N — <slide title>/);
  const md = fs.readFileSync(path.join(paths.root, r.markdownRel), 'utf8');
  assert.match(md, /original_type: PPTX/);
  assert.match(md, /Not converted: image3\.emf was not sent to the model: unsupported picture format/);

  const capped = new VisionParser();
  await parseDocument(paths, capped, 'raw/review.pptx', { force: true, maxTokens: 1000, maxBytes: 1_000_000, maxImages: 0 });
  assert.deepEqual(capped.requests[0]!.images, []);
  assert.match(fs.readFileSync(path.join(paths.root, r.markdownRel), 'utf8'), /image1\.png \(slide 1, 2\) was not sent to the model: over the --max-images limit of 0/);
});

test('parse: an image is sent natively and transcribed; a model without vision is refused', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'whiteboard.png'), Buffer.alloc(2000, 7));
  const parser = new VisionParser('# Whiteboard: release plan\n\nShip on Friday.');
  const r = await parseDocument(paths, parser, 'raw/whiteboard.png', { force: false, maxTokens: 1000, maxBytes: 1_000_000 });
  assert.equal(parser.requests[0]!.document.mimeType, 'image/png');
  assert.equal(parser.requests[0]!.extractedText, undefined);
  assert.match(parser.requests[0]!.instruction, /transcribe every piece of visible text exactly/);
  const md = fs.readFileSync(path.join(paths.root, r.markdownRel), 'utf8');
  assert.match(md, /Converted from the original PNG image \[\[raw\/whiteboard\.png\]\]/);
  const blind: DocumentParser = { provider: 'blind', model: 'm', nativeMimeTypes: () => new Set(), parseDocument: async () => 'x' };
  await assert.rejects(parseDocument(paths, blind, 'raw/whiteboard.png', { force: true, maxTokens: 1000, maxBytes: 1_000_000 }), /cannot read images/);
});

test('ingest: an XLSX needs no parser settings; images in raw/ are pending but raw/assets/ is not', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'budget.xlsx'), await sampleXlsx());
  fs.writeFileSync(path.join(paths.raw, 'diagram.png'), Buffer.alloc(10, 1));
  fs.writeFileSync(path.join(paths.raw, 'assets', 'logo.png'), Buffer.alloc(10, 1));
  assert.deepEqual(pendingSources(paths), ['raw/budget.xlsx', 'raw/diagram.png']);
  const plan = JSON.stringify({ title: 'Budget', takeaways: ['Laptops cost 1234.5'], summary_page: { path: 'sources/budget', content: '---\ntitle: Budget\n---\n# Budget\n\nLaptop costs.' }, pages: [], log_entry: 'Budget sheet.' });
  const llm = new FakeChat([plan]);
  const r = await ingestSource(Config.fromValues({}), paths, llm, 'raw/budget.xlsx', { force: false, dryRun: false, maxTokens: 1000, relatedLimit: 4, maxSourceChars: 100000, contextChars: 10000 });
  assert.equal(r.sourceRel, 'raw/budget.xlsx.md');
  assert.equal(r.originalRel, 'raw/budget.xlsx');
  assert.match(llm.requests[0]!.user, /\| Laptop \\\| pro \| 1234\.5 \| 2024-01-01 \| 25% \|/);
  await assert.rejects(
    ingestSource(Config.fromValues({}), paths, new FakeChat([]), 'raw/diagram.png', { force: false, dryRun: false, maxTokens: 1000, relatedLimit: 4, maxSourceChars: 100000, contextChars: 10000 }),
    /PNG original and needs the parser LLM/,
  );
});
