import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderIndex, writeIndex, indexIsStale } from '../src/wiki/index.js';
import { appendLog, parseLog, readLog } from '../src/wiki/log.js';
import { LinkResolver, listPages, normalisePageId } from '../src/wiki/layout.js';
import { lintStructure } from '../src/wiki/lint.js';
import { applyPageChanges, ensureFrontmatter } from '../src/ops/pages.js';
import { parseFrontmatter } from '../src/wiki/markdown.js';
import { addPage, tempWiki } from './helpers.js';

test('init creates the three layers, schema files, index and log', () => {
  const paths = tempWiki();
  for (const f of ['raw', 'raw/assets', 'wiki', 'wiki/sources', 'wiki/entities', '.llm-wiki', 'CLAUDE.md', 'AGENTS.md', 'wiki/index.md', 'wiki/log.md']) {
    assert.ok(fs.existsSync(path.join(paths.root, f)), `${f} missing`);
  }
  assert.match(fs.readFileSync(paths.schema, 'utf8'), /LLM Wiki — schema/);
  assert.equal(readLog(paths)[0]?.kind, 'init');
});

test('index.md is rendered from frontmatter, grouped by type, and detects staleness', () => {
  const paths = tempWiki();
  addPage(paths, 'entities/ada', 'Ada Lovelace', 'Body', { type: 'entity', sources: ['raw/a.md', 'raw/b.md'] });
  addPage(paths, 'concepts/engine', 'Analytical Engine', 'Body');
  assert.equal(indexIsStale(paths), true);
  assert.equal(writeIndex(paths), true);
  const text = fs.readFileSync(paths.index, 'utf8');
  assert.match(text, /## Entities \(1\)/);
  assert.match(text, /- \[\[ada\|Ada Lovelace\]\] — Ada Lovelace summary _\(2026-01-01, 2 sources\)_/);
  assert.match(text, /## Concepts \(1\)/);
  assert.equal(writeIndex(paths), false);
  assert.equal(indexIsStale(paths), false);
  assert.match(renderIndex([]), /wiki is empty/);
});

test('log entries append and parse with the grep-able prefix', () => {
  const paths = tempWiki();
  appendLog(paths, 'ingest', 'Some Article', 'Pages touched:\n- [[a]]', '2026-04-02');
  appendLog(paths, 'query', 'What is X?', '', '2026-04-03');
  const entries = readLog(paths);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.slice(1).map((e) => [e.date, e.kind, e.title]), [['2026-04-02', 'ingest', 'Some Article'], ['2026-04-03', 'query', 'What is X?']]);
  assert.equal(entries[1]?.body, 'Pages touched:\n- [[a]]');
  assert.equal(parseLog('no headers here').length, 0);
});

test('LinkResolver resolves id, basename, title and relative md forms', () => {
  const paths = tempWiki();
  addPage(paths, 'entities/ada', 'Ada Lovelace', 'x');
  addPage(paths, 'concepts/engine', 'Analytical Engine', 'x');
  const r = new LinkResolver(listPages(paths));
  assert.equal(r.resolve('ada')?.id, 'entities/ada');
  assert.equal(r.resolve('entities/ada.md')?.id, 'entities/ada');
  assert.equal(r.resolve('wiki/entities/ada')?.id, 'entities/ada');
  assert.equal(r.resolve('Analytical Engine')?.id, 'concepts/engine');
  assert.equal(r.resolve('../concepts/engine.md', 'entities/ada')?.id, 'concepts/engine');
  assert.equal(r.resolve('nope'), undefined);
  assert.equal(normalisePageId('/wiki/entities/ada.md'), 'entities/ada');
  assert.throws(() => normalisePageId('../etc/passwd'));
});

test('structural lint reports dangling links, orphans, stale index and un-ingested sources', () => {
  const paths = tempWiki();
  addPage(paths, 'entities/ada', 'Ada Lovelace', 'Worked with [[babbage]] on the [[engine]].');
  addPage(paths, 'entities/babbage', 'Charles Babbage', 'Built things with [[ada]].');
  addPage(paths, 'concepts/loner', 'Loner', 'No links at all.');
  fs.writeFileSync(path.join(paths.raw, 'paper.md'), '# Paper');
  const report = lintStructure(paths);
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes('dangling-link'));
  assert.ok(codes.includes('orphan-page'));
  assert.ok(codes.includes('index-stale'));
  assert.ok(codes.includes('raw-not-ingested'));
  assert.ok(report.findings.find((f) => f.code === 'orphan-page')?.page === 'concepts/loner');
  writeIndex(paths);
  assert.ok(!lintStructure(paths).findings.some((f) => f.code === 'index-stale'));
});

test('applyPageChanges normalises paths, appends, fills frontmatter and refuses escapes', () => {
  const paths = tempWiki();
  const applied = applyPageChanges(paths, [
    { op: 'create', path: 'wiki/entities/ada.md', content: '---\ntitle: Ada\ntype: entity\n---\n# Ada\n\nFirst.' },
    { op: 'append', path: 'entities/ada', content: '## More\n\nSecond.' },
    { op: 'create', path: 'concepts/no-frontmatter', content: '# Bare Page\n\ntext' },
  ], 'raw/src.md');
  assert.deepEqual(applied.map((a) => [a.op, a.id]), [['create', 'entities/ada'], ['append', 'entities/ada'], ['create', 'concepts/no-frontmatter']]);
  const ada = fs.readFileSync(paths.pageAbs('entities/ada'), 'utf8');
  assert.match(ada, /First\.\n\n## More\n\nSecond\./);
  const fm = parseFrontmatter(ada).frontmatter;
  assert.equal(fm.title, 'Ada');
  assert.deepEqual(fm.sources, ['raw/src.md']);
  assert.ok(typeof fm.updated === 'string');
  const bare = parseFrontmatter(fs.readFileSync(paths.pageAbs('concepts/no-frontmatter'), 'utf8')).frontmatter;
  assert.equal(bare.title, 'Bare Page');
  assert.equal(bare.type, 'concept');
  assert.throws(() => applyPageChanges(paths, [{ op: 'create', path: '../../evil', content: 'x' }]));
  assert.throws(() => applyPageChanges(paths, [{ op: 'create', path: 'index', content: 'x' }]));
  assert.equal(parseFrontmatter(ensureFrontmatter('# T\n\nb', { id: 'overview' })).frontmatter.type, 'overview');
});
