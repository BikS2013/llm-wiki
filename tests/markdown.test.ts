import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSections, extractLinks, parseFrontmatter, serializeFrontmatter, slugify, splitSections, withFrontmatter } from '../src/wiki/markdown.js';

test('parseFrontmatter handles scalars, inline lists and block lists', () => {
  const doc = `---\ntitle: Ada Lovelace\ntype: entity\ntags: [math, computing]\nsources:\n  - raw/a.md\n  - raw/b.md\ncount: 3\nflag: true\n---\n\n# Ada\n\nBody.`;
  const { frontmatter, body, hasFrontmatter } = parseFrontmatter(doc);
  assert.equal(hasFrontmatter, true);
  assert.equal(frontmatter.title, 'Ada Lovelace');
  assert.deepEqual(frontmatter.tags, ['math', 'computing']);
  assert.deepEqual(frontmatter.sources, ['raw/a.md', 'raw/b.md']);
  assert.equal(frontmatter.count, 3);
  assert.equal(frontmatter.flag, true);
  assert.equal(body.trim(), '# Ada\n\nBody.');
});

test('frontmatter round-trips through serialize/parse', () => {
  const fm = { title: 'A: B', tags: ['x', 'y z'], updated: '2026-01-02', n: 2 };
  const text = withFrontmatter(fm, '# A: B\n');
  const back = parseFrontmatter(text).frontmatter;
  assert.equal(back.title, 'A: B');
  assert.deepEqual(back.tags, ['x', 'y z']);
  assert.equal(back.updated, '2026-01-02');
  assert.equal(back.n, 2);
  assert.match(serializeFrontmatter(fm), /^---\n/);
});

test('extractLinks finds wikilinks with alias/heading and relative md links, ignoring code', () => {
  const body = 'See [[ada-lovelace]] and [[entities/babbage|Charles]] and [[topic#Section]] plus [doc](../concepts/engine.md) and ![[image.png]].\n```\n[[not-a-link]]\n```\n`[[nor-this]]` [ext](https://x.com/a.md)';
  const links = extractLinks(body);
  assert.deepEqual(links.map((l) => l.target), ['ada-lovelace', 'entities/babbage', 'topic', '../concepts/engine.md']);
  assert.equal(links[1]?.alias, 'Charles');
  assert.equal(links[2]?.heading, 'Section');
});

test('slugify produces kebab-case', () => {
  assert.equal(slugify('  Héllo, World! 2026 '), 'hello-world-2026');
  assert.equal(slugify('!!!'), 'untitled');
});

test('splitSections tracks heading paths and chunkSections bounds size', () => {
  const body = 'intro\n\n# A\n\ntext a\n\n## B\n\ntext b\n\n```\n# not heading\n```\n\n### C\n\n' + 'x'.repeat(4000);
  const sections = splitSections(body);
  assert.deepEqual(sections.map((s) => s.heading), ['', 'A', 'A > B', 'A > B > C']);
  const chunks = chunkSections(sections, 1500);
  assert.ok(chunks.length > sections.length);
  assert.ok(chunks.every((c) => c.text.length <= 1500));
});
