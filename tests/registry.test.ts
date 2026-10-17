import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config/env.js';
import { requireWiki, resolveWiki } from '../src/config/settings.js';
import { ConfigError, LlmWikiError, WikiLayoutError } from '../src/errors.js';
import { slugWikiName, WikiRegistry } from '../src/wiki/registry.js';
import { searchWikis, wikiStatus } from '../src/ops/wikis.js';
import { addPage, tempWiki } from './helpers.js';

const regFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-reg-')), 'wikis.json');
const today = '2026-10-16';

test('registry add / use / rename / describe / remove persist to disk', () => {
  const file = regFile();
  const a = tempWiki();
  const b = tempWiki();
  const reg = new WikiRegistry(file);
  reg.add('work', a.root, { today, description: 'Work notes' });
  reg.add('personal', b.root, { today });
  reg.use('work');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const again = new WikiRegistry(file);
  assert.deepEqual(again.list().map((w) => w.name), ['personal', 'work']);
  assert.equal(again.current, 'work');
  assert.equal(again.nameForRoot(b.root), 'personal');

  again.rename('work', 'job');
  assert.equal(again.current, 'job');
  again.describe('personal', 'Home stuff');
  assert.equal(new WikiRegistry(file).get('personal').description, 'Home stuff');

  again.remove('job');
  assert.equal(again.current, undefined);
  assert.ok(fs.existsSync(a.root), 'remove must never delete files');
});

test('registry refuses bad names, duplicates and uninitialised directories', () => {
  const reg = new WikiRegistry(regFile());
  const a = tempWiki();
  assert.throws(() => reg.add('Bad Name', a.root, { today }), LlmWikiError);
  reg.add('a', a.root, { today });
  assert.throws(() => reg.add('a', tempWiki().root, { today }), /already registered/);
  assert.throws(() => reg.add('b', a.root, { today }), /already registered as "a"/);
  assert.throws(() => reg.add('c', fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')), { today }), WikiLayoutError);
  assert.throws(() => reg.get('nope'), (e: unknown) => e instanceof ConfigError && /Registered: a/.test(e.message));
  assert.equal(slugWikiName('/x/My Notes!'), 'my-notes');
});

test('corrupt registry is reported, never silently reset', () => {
  const file = regFile();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new WikiRegistry(file), /not valid JSON/);
});

test('wiki selection: explicit name or root beats the current selection; higher tier wins', () => {
  const reg = new WikiRegistry(regFile());
  const a = tempWiki();
  const b = tempWiki();
  reg.add('a', a.root, { today });
  reg.add('b', b.root, { today });

  assert.equal(resolveWiki(Config.fromValues({}), reg), undefined);
  assert.throws(() => requireWiki(Config.fromValues({}), reg), /No wiki selected.*registered: a, b/);

  reg.use('a');
  assert.deepEqual(resolveWiki(Config.fromValues({}), reg), { root: a.root, name: 'a', via: 'current' });
  assert.equal(resolveWiki(Config.fromValues({ LLM_WIKI_NAME: 'b' }), reg)?.root, b.root);
  const byRoot = resolveWiki(Config.fromValues({ LLM_WIKI_ROOT: b.root }), reg);
  assert.equal(byRoot?.name, 'b');
  assert.equal(byRoot?.via, 'LLM_WIKI_ROOT');
  assert.throws(() => resolveWiki(Config.fromValues({ LLM_WIKI_NAME: 'b', LLM_WIKI_ROOT: a.root }), reg), /same|Both/);
  assert.throws(() => resolveWiki(Config.fromValues({ LLM_WIKI_NAME: 'zzz' }), reg), ConfigError);

  // --wiki (cli tier) beats LLM_WIKI_ROOT from the shell tier.
  const prev = process.env.LLM_WIKI_ROOT;
  process.env.LLM_WIKI_ROOT = a.root;
  try {
    const cfg = Config.load({ LLM_WIKI_NAME: 'b' }, '/nonexistent-cwd');
    assert.equal(resolveWiki(cfg, reg)?.name, 'b');
  } finally {
    if (prev === undefined) delete process.env.LLM_WIKI_ROOT;
    else process.env.LLM_WIKI_ROOT = prev;
  }
});

test('searchWikis fuses results across wikis and labels each hit', async () => {
  const a = tempWiki();
  const b = tempWiki();
  addPage(a, 'concepts/kubernetes', 'Kubernetes', 'Kubernetes schedules containers on nodes.');
  addPage(b, 'concepts/sourdough', 'Sourdough', 'Sourdough needs a starter and long fermentation.');
  addPage(b, 'concepts/k8s-at-home', 'Homelab', 'Running kubernetes at home on a mini PC.');
  const cfg = Config.fromValues({});
  const hits = await searchWikis(cfg, [{ name: 'work', paths: a }, { name: 'home', paths: b }], 'kubernetes', { mode: 'bm25', limit: 5, layer: 'wiki' });
  assert.deepEqual(new Set(hits.map((h) => h.wiki)), new Set(['work', 'home']));
  assert.ok(hits.every((h) => !h.chunk.file.includes('sourdough')));
  const single = await searchWikis(cfg, [{ name: 'home', paths: b }], 'sourdough', { mode: 'bm25', limit: 5, layer: 'wiki' });
  assert.equal(single[0]?.wiki, 'home');
});

test('wikiStatus reports missing roots instead of throwing', () => {
  const st = wikiStatus({ name: 'gone', root: '/nonexistent/wiki', registered: today });
  assert.equal(st.healthy, false);
  assert.match(st.problem ?? '', /does not exist/);
});
