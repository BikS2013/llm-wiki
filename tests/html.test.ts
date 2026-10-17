import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config/env.js';
import { initWiki } from '../src/ops/init.js';
import { ingestSource } from '../src/ops/ingest.js';
import { queryWiki } from '../src/ops/query.js';
import { applyPageChanges, linkHtmlPages } from '../src/ops/pages.js';
import { htmlFormat, htmlToText, sanitizeHtml } from '../src/wiki/format.js';
import { indexIsStale, writeIndex } from '../src/wiki/index.js';
import { listPages, WikiPaths } from '../src/wiki/layout.js';
import { lintStructure } from '../src/wiki/lint.js';
import { appendLog, readLog } from '../src/wiki/log.js';
import { search } from '../src/search/search.js';
import { SearchStore } from '../src/search/store.js';
import { FakeChat, tempWiki } from './helpers.js';

const config = Config.fromValues({});
const ingestOpts = { force: false, dryRun: false, maxTokens: 1000, relatedLimit: 4, maxSourceChars: 100000, contextChars: 10000 };

test('init --format html writes wiki.json, index.html, log.html, the stylesheet and an HTML schema', () => {
  const paths = tempWiki('html');
  assert.equal(paths.format.name, 'html');
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')), { version: 1, format: 'html' });
  for (const f of ['index.html', 'log.html', 'wiki.css']) assert.ok(fs.existsSync(path.join(paths.wiki, f)), f);
  assert.ok(!fs.existsSync(path.join(paths.wiki, 'index.md')));
  const schema = fs.readFileSync(paths.schema, 'utf8');
  assert.match(schema, /entities\/ada-lovelace\.html/);
  assert.match(schema, /llm-wiki-meta/);
  assert.doesNotMatch(schema, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(fs.readFileSync(tempWiki('markdown').schema, 'utf8'), /\{\{[A-Z_]+\}\}|llm-wiki-meta/);
  const log = readLog(paths);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.kind, 'init');
});

test('the format is required for a new wiki, fixed afterwards, and read off index.md for older wikis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-fmt-'));
  assert.throws(() => initWiki(dir), /Choose the page format/);
  initWiki(dir, { format: 'markdown' });
  assert.throws(() => initWiki(dir, { force: true, format: 'html' }), /init cannot change its format/);
  assert.equal(initWiki(dir, { force: true }).format, 'markdown');
  fs.rmSync(path.join(dir, '.llm-wiki', 'wiki.json'));
  assert.equal(new WikiPaths(dir).format.name, 'markdown', 'legacy wiki detected from index.md');
  fs.rmSync(path.join(dir, 'wiki', 'index.md'));
  assert.throws(() => new WikiPaths(dir).format, /Cannot tell the page format/);
});

test('HTML pages: wikilinks become relative links, metadata round-trips, active content is removed', () => {
  const paths = tempWiki('html');
  fs.writeFileSync(path.join(paths.raw, 'paper.pdf'), 'x');
  applyPageChanges(paths, [
    { op: 'create', path: 'entities/ada-lovelace', content: '---\ntitle: Ada Lovelace\ntype: entity\nsummary: Mathematician <and> writer.\ntags: [math, history]\n---\n<h1>Ada Lovelace</h1>\n<p onclick="alert(1)">Worked on the [[analytical-engine|Analytical Engine]]; see [[raw/paper.pdf]].</p><script>alert(2)</script>' },
    { op: 'create', path: 'concepts/analytical-engine', content: '---\ntitle: Analytical Engine\n---\n# Analytical Engine\n\nProgrammed by [[ada-lovelace]].\n\n| a | b |\n|---|---|\n| [[ada-lovelace|Ada]] | 1 |\n\n`[[not-a-link]]`' },
  ]);
  const ada = fs.readFileSync(path.join(paths.wiki, 'entities', 'ada-lovelace.html'), 'utf8');
  assert.match(ada, /^<!doctype html>/);
  assert.match(ada, /<a class="wikilink" href="\.\.\/concepts\/analytical-engine\.html">Analytical Engine<\/a>/);
  assert.match(ada, /href="\.\.\/\.\.\/raw\/paper\.pdf"/);
  assert.match(ada, /<link rel="stylesheet" href="\.\.\/wiki\.css">/);
  assert.match(ada, /script-src 'none'/);
  assert.doesNotMatch(ada, /onclick|alert\(2\)/);
  const engine = fs.readFileSync(path.join(paths.wiki, 'concepts', 'analytical-engine.html'), 'utf8');
  assert.match(engine, /<table>/, 'markdown bodies are rendered to HTML');
  assert.match(engine, /<td><a class="wikilink" href="\.\.\/entities\/ada-lovelace\.html">Ada<\/a><\/td>/);
  assert.match(engine, /<code>\[\[not-a-link\]\]<\/code>/, 'code is left alone');

  const pages = listPages(paths);
  assert.deepEqual(pages.map((p) => p.id), ['concepts/analytical-engine', 'entities/ada-lovelace']);
  const p = pages[1]!;
  assert.equal(p.title, 'Ada Lovelace');
  assert.equal(p.frontmatter.summary, 'Mathematician <and> writer.');
  assert.deepEqual(p.frontmatter.tags, ['math', 'history']);
  assert.ok(p.links.some((l) => l.target === 'concepts/analytical-engine'));
  assert.doesNotMatch(p.text, /<[a-z]/);
  assert.match(p.source, /^---\ntitle: Ada Lovelace/);
  const lint = lintStructure(paths);
  assert.deepEqual(lint.findings.filter((f) => f.code === 'dangling-link' || f.code === 'orphan-page'), []);
});

test('appending to an HTML page keeps the shell and metadata; replacing keeps created', () => {
  const paths = tempWiki('html');
  applyPageChanges(paths, [{ op: 'create', path: 'concepts/x', content: '---\ntitle: X\ncreated: 2020-01-01\n---\n<h1>X</h1><p>one</p>' }]);
  applyPageChanges(paths, [{ op: 'append', path: 'concepts/x', content: '## More\n\ntwo' }]);
  let page = listPages(paths)[0]!;
  assert.match(page.body, /<p>one<\/p>[\s\S]*<h2>More<\/h2>\s*<p>two<\/p>/);
  assert.equal(page.frontmatter.created, '2020-01-01');
  assert.equal((fs.readFileSync(page.abs, 'utf8').match(/<main>/g) ?? []).length, 1);
  applyPageChanges(paths, [{ op: 'replace', path: 'concepts/x', content: '---\ntitle: X2\n---\n<p>new</p>' }]);
  page = listPages(paths)[0]!;
  assert.equal(page.title, 'X2');
  assert.equal(page.frontmatter.created, '2020-01-01');
});

test('index.html links every page relatively and is regenerated deterministically', () => {
  const paths = tempWiki('html');
  applyPageChanges(paths, [{ op: 'create', path: 'entities/ada-lovelace', content: '---\ntitle: Ada Lovelace\nsummary: Mathematician.\n---\n<p>x</p>' }]);
  writeIndex(paths);
  const index = fs.readFileSync(paths.index, 'utf8');
  assert.match(index, /<a class="wikilink" href="entities\/ada-lovelace\.html">Ada Lovelace<\/a> — Mathematician\./);
  assert.match(index, /<link rel="stylesheet" href="wiki\.css">/);
  assert.equal(indexIsStale(paths), false);
  assert.equal(writeIndex(paths), false);
});

test('HTML log entries append inside <main> and read back', () => {
  const paths = tempWiki('html');
  appendLog(paths, 'note', 'First <note>', 'Touched [[missing-page]].\n\n- one\n- two', '2026-01-02');
  appendLog(paths, 'edit', 'Second', '', '2026-01-03');
  const entries = readLog(paths);
  assert.deepEqual(entries.map((e) => `${e.date} ${e.kind} ${e.title}`).slice(1), ['2026-01-02 note First <note>', '2026-01-03 edit Second']);
  assert.match(entries[1]!.body, /- one/);
  const html = fs.readFileSync(paths.log, 'utf8');
  assert.ok(html.indexOf('Second') < html.lastIndexOf('</main>'));
  assert.equal((html.match(/<main>/g) ?? []).length, 1);
});

test('search indexes the text of HTML pages, not their markup', async () => {
  const paths = tempWiki('html');
  applyPageChanges(paths, [{ op: 'create', path: 'concepts/kube', content: '---\ntitle: Kubernetes\n---\n<h1>Kubernetes</h1><h2>Scheduling</h2><p>The scheduler places pods on nodes.</p>' }]);
  const store = new SearchStore(paths);
  store.reindex({ includeRaw: false });
  const hits = await search(store, 'scheduler pods', { mode: 'bm25', limit: 5, layer: 'wiki' });
  assert.equal(hits[0]?.chunk.file, 'wiki/concepts/kube.html');
  assert.equal(hits[0]?.chunk.heading, 'Kubernetes > Scheduling');
  assert.doesNotMatch(hits[0]!.snippet, /<p>|class=/);
});

test('ingest and query --file in an HTML wiki write .html pages with working links', async () => {
  const paths = tempWiki('html');
  const plan = JSON.stringify({
    title: 'Ada Article',
    takeaways: ['Ada wrote the first program'],
    summary_page: { path: 'sources/ada-article', content: '---\ntitle: Ada Article\ntype: source\nsummary: An article about Ada.\n---\n<h1>Ada Article</h1><p>About [[ada-lovelace]].</p>' },
    pages: [{ op: 'create', path: 'entities/ada-lovelace', content: '---\ntitle: Ada Lovelace\nsummary: Mathematician.\n---\n<h1>Ada Lovelace</h1><p>See [[sources/ada-article|the article]].</p>', reason: 'new' }],
    log_entry: 'Integrated.',
  });
  fs.writeFileSync(path.join(paths.raw, 'ada.md'), '# Ada\n\nAda Lovelace wrote the first program.');
  const llm = new FakeChat([plan, 'Ada wrote the first program [[ada-lovelace]].']);
  const r = await ingestSource(config, paths, llm, path.join(paths.raw, 'ada.md'), ingestOpts);
  assert.deepEqual(r.applied.map((a) => paths.pageRel(a.id)), ['wiki/sources/ada-article.html', 'wiki/entities/ada-lovelace.html']);
  assert.match(llm.requests[0]!.system, /HTML fragment/);
  assert.match(fs.readFileSync(path.join(paths.wiki, 'sources', 'ada-article.html'), 'utf8'), /href="\.\.\/entities\/ada-lovelace\.html"/);
  assert.match(fs.readFileSync(paths.index, 'utf8'), /href="sources\/ada-article\.html"/);

  const q = await queryWiki(config, paths, llm, 'What does the Ada article say about Ada Lovelace?', { limit: 5, maxPages: 4, contextChars: 10000, maxTokens: 1000, file: true });
  assert.ok(q.filedAs?.startsWith('syntheses/'));
  const filed = fs.readFileSync(paths.pageAbs(q.filedAs!), 'utf8');
  assert.match(filed, /<a class="wikilink" href="\.\.\/entities\/ada-lovelace\.html">ada-lovelace<\/a>/);
  assert.match(llm.requests[1]!.user, /<index>[\s\S]*\[\[ada-lovelace\|Ada Lovelace\]\]/, 'the LLM sees the index in markdown form');
  assert.match(llm.requests[1]!.user, /<page id="entities\/ada-lovelace"[^>]*>\n---\ntitle: Ada Lovelace/, 'pages reach the LLM as frontmatter + body');
  assert.deepEqual(lintStructure(paths).findings.filter((f) => f.severity === 'error'), []);
});

test('hand-edited HTML pages: leftover wikilinks are flagged and converted; foreign .md files are flagged', () => {
  const paths = tempWiki('html');
  applyPageChanges(paths, [{ op: 'create', path: 'entities/b', content: '---\ntitle: B\n---\n<p>b</p>' }]);
  const abs = paths.pageAbs('entities/a');
  fs.writeFileSync(abs, htmlFormat.render({ title: 'A' }, '<h1>A</h1><p>Links to [[b]].</p>', 'entities/a'));
  fs.writeFileSync(path.join(paths.wiki, 'stray.md'), '# stray');
  const codes = lintStructure(paths).findings.map((f) => f.code);
  assert.ok(codes.includes('unconverted-wikilink'));
  assert.ok(codes.includes('foreign-format-file'));
  assert.deepEqual(linkHtmlPages(paths), ['entities/a']);
  assert.match(fs.readFileSync(abs, 'utf8'), /<a class="wikilink" href="b\.html">b<\/a>/);
  assert.ok(!lintStructure(paths).findings.some((f) => f.code === 'unconverted-wikilink' || f.code === 'dangling-link'));
  assert.deepEqual(linkHtmlPages(paths), []);
});

test('htmlToText and sanitizeHtml', () => {
  assert.equal(htmlToText('<h2>A &amp; B</h2><p>x<br>y</p><ul><li>one</li><li>two</li></ul>'), '## A & B\n\nx\ny\n\n- one\n- two');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)" onmouseover=\'x()\'>z</a><iframe src="e"></iframe>'), '<a href="#">z</a>');
});

test('convert --to html: pages, links, log, index and backup; dry run writes nothing', async () => {
  const { convertToHtml } = await import('../src/ops/convert.js');
  const paths = tempWiki('markdown');
  fs.writeFileSync(path.join(paths.raw, 'paper.pdf'), 'x');
  applyPageChanges(paths, [
    { op: 'create', path: 'entities/ada-lovelace', content: '---\ntitle: Ada Lovelace\nsummary: Mathematician.\ntags: [math]\n---\n# Ada Lovelace\n\nWorked on the [[analytical-engine|Engine]] ([source](../sources/paper.md#key-claims)); original [[raw/paper.pdf]]; see [[ghost-page]].' },
    { op: 'create', path: 'concepts/analytical-engine', content: '---\ntitle: Analytical Engine\n---\n# Analytical Engine\n\nProgrammed by [[ada-lovelace]].' },
    { op: 'create', path: 'sources/paper', content: '---\ntitle: Paper\n---\n# Paper\n\nAbout [[ada-lovelace]] and [[analytical-engine]].' },
  ]);
  writeIndex(paths);
  appendLog(paths, 'ingest', 'Paper', 'Pages touched:\n- create [[entities/ada-lovelace]]');

  const dry = convertToHtml(paths, { dryRun: true, keepSchema: false });
  assert.equal(dry.pages.length, 3);
  assert.equal(dry.schema, 'rewritten', 'an untouched schema is replaced wholesale');
  assert.deepEqual(dry.unresolvedLinks, [{ page: 'entities/ada-lovelace', target: 'ghost-page' }]);
  assert.equal(new WikiPaths(paths.root).format.name, 'markdown');
  assert.ok(!fs.existsSync(path.join(paths.wiki, 'entities', 'ada-lovelace.html')));

  const r = convertToHtml(paths, { dryRun: false, keepSchema: false, now: new Date(2026, 0, 2, 3, 4, 5) });
  assert.equal(r.backup, '.llm-wiki/backup/markdown-20260102-030405');
  const after = new WikiPaths(paths.root);
  assert.equal(after.format.name, 'html');
  assert.deepEqual(listPages(after).map((p) => p.relPath), ['wiki/concepts/analytical-engine.html', 'wiki/entities/ada-lovelace.html', 'wiki/sources/paper.html']);
  const ada = listPages(after)[1]!;
  assert.deepEqual(ada.frontmatter.tags, ['math']);
  assert.match(ada.body, /href="\.\.\/concepts\/analytical-engine\.html">Engine</);
  assert.match(ada.body, /href="\.\.\/sources\/paper\.html#key-claims">source</);
  assert.match(ada.body, /href="\.\.\/\.\.\/raw\/paper\.pdf"/);
  assert.match(ada.body, /wikilink-missing/);
  for (const f of ['index.md', 'log.md', 'entities/ada-lovelace.md']) {
    assert.ok(!fs.existsSync(path.join(after.wiki, f)), `${f} removed`);
    assert.ok(fs.existsSync(path.join(after.root, r.backup!, 'wiki', f)), `${f} backed up`);
  }
  assert.ok(fs.existsSync(path.join(after.wiki, 'index.html')) && fs.existsSync(path.join(after.wiki, 'wiki.css')));
  assert.match(fs.readFileSync(after.index, 'utf8'), /href="entities\/ada-lovelace\.html"/);
  assert.deepEqual(readLog(after).map((e) => e.kind), ['init', 'ingest', 'edit']);
  assert.match(fs.readFileSync(after.log, 'utf8'), /href="entities\/ada-lovelace\.html"/);
  assert.match(fs.readFileSync(after.schema, 'utf8'), /llm-wiki-meta/);
  const codes = lintStructure(after).findings.map((f) => `${f.code}:${f.page ?? ''}`);
  assert.deepEqual(codes.filter((c) => c.startsWith('dangling')), ['dangling-link:entities/ada-lovelace'], 'only the link that was already broken');
  assert.throws(() => convertToHtml(after, { dryRun: true, keepSchema: false }), /already an HTML wiki/);
});

test('convert merges a customised schema: template sections replaced, custom sections kept', async () => {
  const { convertToHtml, mergeSchema } = await import('../src/ops/convert.js');
  const paths = tempWiki('markdown');
  const custom = `${fs.readFileSync(paths.schema, 'utf8')}\n## Purpose and domain conventions\n\nCommittee decks, one slide per source.\n`;
  fs.writeFileSync(paths.schema, custom);
  fs.writeFileSync(path.join(paths.root, 'AGENTS.md'), custom);
  const r = convertToHtml(paths, { dryRun: false, keepSchema: false });
  assert.equal(r.schema, 'merged');
  assert.deepEqual(r.schemaSectionsReplaced, ['Layout (three layers)', 'Page format', 'Operations', 'Tools']);
  const schema = fs.readFileSync(paths.schema, 'utf8');
  assert.match(schema, /llm-wiki-meta/);
  assert.match(schema, /## Purpose and domain conventions\n\nCommittee decks, one slide per source\.\n$/);
  assert.equal(fs.readFileSync(path.join(paths.root, 'AGENTS.md'), 'utf8'), schema);
  assert.equal(mergeSchema('# T\n\n## Mine\n\nx\n', '# T2\n\n## Other\n\ny\n').replaced.length, 0);

  const kept = tempWiki('markdown');
  fs.writeFileSync(kept.schema, custom);
  assert.equal(convertToHtml(kept, { dryRun: false, keepSchema: true }).schema, 'kept');
  assert.equal(fs.readFileSync(kept.schema, 'utf8'), custom);
});
