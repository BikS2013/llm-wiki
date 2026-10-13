import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config/env.js';
import { parserSettings } from '../src/config/settings.js';
import type { DocumentParser, ParseRequest } from '../src/llm/types.js';
import { extractPdfText, isParsableDocument } from '../src/ops/extract.js';
import { ingestSource, pendingSources } from '../src/ops/ingest.js';
import { markdownPathFor, parseDocument, unwrapMarkdownFence } from '../src/ops/parse.js';
import { lintStructure } from '../src/wiki/lint.js';
import { parseFrontmatter } from '../src/wiki/markdown.js';
import { FakeChat, tempWiki } from './helpers.js';

/** A minimal but valid single-page PDF containing the text "Hello wiki". */
function tinyPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 18 Tf 20 40 Td (Hello wiki) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

class FakeParser implements DocumentParser {
  readonly provider = 'fake';
  readonly model = 'doc-model';
  readonly requests: ParseRequest[] = [];
  constructor(private readonly native: boolean, private readonly reply = '```markdown\n# Quarterly Report\n\nRevenue grew 12%.\n```') {}
  nativeMimeTypes(): ReadonlySet<string> {
    return new Set(this.native ? ['application/pdf'] : []);
  }
  async parseDocument(req: ParseRequest): Promise<string> {
    this.requests.push(req);
    return this.reply;
  }
}

const extractors = { pdf: async () => 'extracted pdf text', docx: async () => '<h1>Doc</h1><p>docx html</p>' };
const parseOpts = { force: false, maxTokens: 1000, maxBytes: 1_000_000, extractors };

test('parserSettings requires both settings and rejects unknown providers', () => {
  assert.throws(() => parserSettings(Config.fromValues({ LLM_WIKI_PARSER_PROVIDER: 'openai' })), /LLM_WIKI_PARSER_MODEL/);
  assert.deepEqual(parserSettings(Config.fromValues({ LLM_WIKI_PARSER_PROVIDER: 'gemini', LLM_WIKI_PARSER_MODEL: 'g' })), { provider: 'gemini', model: 'g' });
});

test('helpers: markdown path, fence unwrapping, document detection', () => {
  assert.equal(markdownPathFor('raw/report.pdf'), 'raw/report.pdf.md');
  assert.equal(unwrapMarkdownFence('```markdown\n# T\n\nx\n```'), '# T\n\nx');
  assert.equal(unwrapMarkdownFence('# T'), '# T');
  assert.ok(isParsableDocument('a.PDF') && isParsableDocument('b.docx') && !isParsableDocument('c.md'));
});

test('extractPdfText reads text from a real PDF via pdf.js', async () => {
  const text = await extractPdfText(tinyPdf());
  assert.match(text, /Hello wiki/);
  assert.match(text, /<!-- page 1 -->/);
});

test('parseDocument sends the PDF natively, keeps the original, writes provenance frontmatter, and skips when current', async () => {
  const paths = tempWiki();
  const src = path.join(paths.root, 'report.pdf');
  fs.writeFileSync(src, tinyPdf());
  const parser = new FakeParser(true);
  const r = await parseDocument(paths, parser, src, parseOpts);
  assert.equal(r.originalRel, 'raw/report.pdf');
  assert.equal(r.markdownRel, 'raw/report.pdf.md');
  assert.ok(fs.readFileSync(path.join(paths.raw, 'report.pdf')).equals(tinyPdf()), 'original copied unmodified');
  assert.equal(parser.requests[0]?.extractedText, undefined, 'native providers get the bytes, not extracted text');
  assert.equal(parser.requests[0]?.document.mimeType, 'application/pdf');
  const md = fs.readFileSync(path.join(paths.root, r.markdownRel), 'utf8');
  const fm = parseFrontmatter(md).frontmatter;
  assert.equal(fm.original, 'raw/report.pdf');
  assert.equal(fm.original_type, 'PDF');
  assert.equal(fm.parsed_by, 'fake/doc-model');
  assert.equal(fm.title, 'Quarterly Report');
  assert.match(md, /Converted from the original PDF document \[\[raw\/report\.pdf\]\]/);
  assert.match(md, /Revenue grew 12%/);
  const again = await parseDocument(paths, new FakeParser(true), src, parseOpts);
  assert.equal(again.skipped, true);
  const forced = await parseDocument(paths, new FakeParser(true), src, { ...parseOpts, force: true });
  assert.equal(forced.skipped, false);
});

test('parseDocument falls back to local extraction for DOCX and for providers without native PDF', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'notes.docx'), Buffer.from('not really a docx'));
  fs.writeFileSync(path.join(paths.raw, 'scan.pdf'), tinyPdf());
  const docxParser = new FakeParser(true);
  await parseDocument(paths, docxParser, 'raw/notes.docx', parseOpts);
  assert.equal(docxParser.requests[0]?.extractedText, '<h1>Doc</h1><p>docx html</p>');
  const localParser = new FakeParser(false);
  await parseDocument(paths, localParser, 'raw/scan.pdf', parseOpts);
  assert.equal(localParser.requests[0]?.extractedText, 'extracted pdf text');
  await assert.rejects(parseDocument(paths, new FakeParser(true), 'raw/scan.pdf', { ...parseOpts, force: true, maxBytes: 10 }), /never truncates/);
  await assert.rejects(parseDocument(paths, new FakeParser(false), 'raw/scan.pdf', { ...parseOpts, force: true, extractors: { ...extractors, pdf: async () => '' } }), /scanned image/);
});

test('ingesting a PDF converts it first, records the original on the summary page, and clears pending/lint', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'report.pdf'), tinyPdf());
  assert.deepEqual(pendingSources(paths), ['raw/report.pdf']);
  assert.ok(lintStructure(paths).findings.some((f) => f.code === 'original-not-parsed'));
  const plan = JSON.stringify({
    title: 'Quarterly Report',
    takeaways: ['Revenue grew'],
    summary_page: { path: 'sources/quarterly-report', content: '---\ntitle: Quarterly Report\ntype: source\nsummary: Q report.\n---\n# Quarterly Report\n\nRevenue grew 12% ([[revenue]]).' },
    pages: [{ op: 'create', path: 'concepts/revenue', content: '# Revenue\n\nSee [[quarterly-report]].' }],
    log_entry: 'Integrated the report.',
  });
  const chat = new FakeChat([plan]);
  const r = await ingestSource(Config.fromValues({}), paths, chat, 'raw/report.pdf', {
    force: false, dryRun: false, maxTokens: 1000, relatedLimit: 2, maxSourceChars: 100000, contextChars: 10000,
    parser: () => new FakeParser(true), parse: { force: false, maxTokens: 1000, maxBytes: 1_000_000, extractors },
  });
  assert.equal(r.originalRel, 'raw/report.pdf');
  assert.equal(r.sourceRel, 'raw/report.pdf.md');
  assert.match(chat.requests[0]!.user, /<source path="raw\/report\.pdf\.md" original="raw\/report\.pdf">/);
  const summary = fs.readFileSync(paths.pageAbs('sources/quarterly-report'), 'utf8');
  assert.equal(parseFrontmatter(summary).frontmatter.original, 'raw/report.pdf');
  assert.match(summary, /\*\*Original document:\*\* \[\[raw\/report\.pdf\]\]/);
  assert.deepEqual(pendingSources(paths), []);
  const codes = lintStructure(paths).findings.map((f) => f.code);
  assert.ok(!codes.includes('original-not-parsed') && !codes.includes('raw-not-ingested'));
  await assert.rejects(ingestSource(Config.fromValues({}), paths, chat, 'raw/report.pdf', { force: true, dryRun: false, maxTokens: 1, relatedLimit: 1, maxSourceChars: 1000, contextChars: 100 }), /parser LLM/);
});
