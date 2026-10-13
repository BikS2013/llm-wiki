import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bm25Index } from '../src/search/bm25.js';
import { tokenize, stem } from '../src/search/tokenize.js';
import { rrf, cosine } from '../src/search/vector.js';
import { EmbeddingStore, SearchStore } from '../src/search/store.js';
import { embedMissing, search } from '../src/search/search.js';
import { addPage, FakeEmbed, tempWiki } from './helpers.js';

test('tokenize lowercases, strips stopwords and stems', () => {
  assert.deepEqual(tokenize('The Indexing of indexed indexes!'), ['index', 'index', 'index']);
  assert.equal(stem('libraries'), 'library');
  assert.equal(stem('programmed'), stem('program'));
  assert.equal(stem('falling'), 'fall');
});

test('bm25 ranks the document mentioning the query terms first', () => {
  const idx = new Bm25Index([
    { id: 'a', text: 'postgres runs in docker on this machine' },
    { id: 'b', text: 'the cat sat on the mat' },
    { id: 'c', text: 'docker compose file for redis' },
  ]);
  const hits = idx.search('postgres docker');
  assert.equal(hits[0]?.id, 'a');
  assert.equal(hits.length, 2);
});

test('rrf fuses rankings and cosine is 1 for identical vectors', () => {
  assert.equal(rrf([['a', 'b'], ['b', 'a']])[0]?.id, 'a');
  assert.equal(rrf([['a', 'b'], ['b', 'c']])[0]?.id, 'b');
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

test('SearchStore reindexes incrementally and drops deleted files', () => {
  const paths = tempWiki();
  addPage(paths, 'entities/postgres', 'Postgres', 'Postgres runs in docker.');
  addPage(paths, 'concepts/docker', 'Docker', 'Containers everywhere.');
  const store = new SearchStore(paths);
  let r = store.reindex({ includeRaw: false });
  assert.equal(r.added, 2);
  r = new SearchStore(paths).reindex({ includeRaw: false });
  assert.equal(r.unchanged, 2);
  addPage(paths, 'entities/postgres', 'Postgres', 'Postgres runs in docker. Updated.');
  fs.rmSync(path.join(paths.wiki, 'concepts/docker.md'));
  r = new SearchStore(paths).reindex({ includeRaw: false });
  assert.equal(r.updated, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.chunks, 1);
});

test('search over the store returns bm25 hits with snippets, and raw layer is opt-in', async () => {
  const paths = tempWiki();
  addPage(paths, 'entities/postgres', 'Postgres', 'Postgres runs in docker on this machine.');
  fs.writeFileSync(path.join(paths.raw, 'notes.md'), '# Notes\n\nkubernetes cluster notes');
  const store = new SearchStore(paths);
  store.reindex({ includeRaw: true });
  const wikiHits = await search(store, 'docker', { mode: 'bm25', limit: 5, layer: 'wiki' });
  assert.equal(wikiHits.length, 1);
  assert.equal(wikiHits[0]?.chunk.file, 'wiki/entities/postgres.md');
  assert.match(wikiHits[0]!.snippet, /docker/);
  const rawHits = await search(store, 'kubernetes', { mode: 'bm25', limit: 5, layer: 'wiki' });
  assert.equal(rawHits.length, 0);
  const allHits = await search(store, 'kubernetes', { mode: 'bm25', limit: 5, layer: 'all' });
  assert.equal(allHits[0]?.chunk.layer, 'raw');
});

test('embedMissing caches by chunk hash and hybrid search works', async () => {
  const paths = tempWiki();
  addPage(paths, 'entities/postgres', 'Postgres', 'Postgres runs in docker.');
  addPage(paths, 'entities/redis', 'Redis', 'Redis is a cache.');
  const store = new SearchStore(paths);
  store.reindex({ includeRaw: false });
  const embed = new FakeEmbed();
  const es = new EmbeddingStore(paths, 'fake', 'fake-embed');
  assert.equal(await embedMissing(store, es, embed), 2);
  assert.equal(await embedMissing(store, es, embed), 0);
  const es2 = new EmbeddingStore(paths, 'fake', 'fake-embed');
  assert.equal(es2.size, 2);
  const other = new EmbeddingStore(paths, 'fake', 'different-model');
  assert.equal(other.size, 0, 'model change invalidates the cache');
  const hits = await search(store, 'postgres docker', { mode: 'hybrid', limit: 2, layer: 'wiki', embedder: { client: embed, store: es2 } });
  assert.equal(hits[0]?.chunk.file, 'wiki/entities/postgres.md');
  await assert.rejects(search(store, 'x', { mode: 'vector', limit: 1, layer: 'wiki' }), /embedding provider/);
});
