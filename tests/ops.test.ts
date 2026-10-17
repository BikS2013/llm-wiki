import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config/env.js';
import { ingestSource, pendingSources } from '../src/ops/ingest.js';
import { queryWiki } from '../src/ops/query.js';
import { lintSemantic, fileLintReport } from '../src/ops/lint-llm.js';
import { lintStructure } from '../src/wiki/lint.js';
import { readLog } from '../src/wiki/log.js';
import { listPages } from '../src/wiki/layout.js';
import { extractJson, isRecord } from '../src/llm/json.js';
import { FakeChat, tempWiki } from './helpers.js';

const config = Config.fromValues({});
const ingestOpts = { force: false, dryRun: false, maxTokens: 1000, relatedLimit: 4, maxSourceChars: 100000, contextChars: 10000 };

const plan = JSON.stringify({
  title: 'Ada Article',
  takeaways: ['Ada wrote the first program'],
  summary_page: { path: 'sources/ada-article', content: '---\ntitle: Ada Article\ntype: source\nsummary: An article about Ada.\n---\n# Ada Article\n\nAbout [[ada-lovelace]] and the [[analytical-engine]].' },
  pages: [
    { op: 'create', path: 'entities/ada-lovelace', content: '---\ntitle: Ada Lovelace\ntype: entity\nsummary: Mathematician.\n---\n# Ada Lovelace\n\nSee [[ada-article]] and [[analytical-engine]].', reason: 'new entity' },
    { op: 'create', path: 'concepts/analytical-engine', content: '# Analytical Engine\n\nDesigned by Babbage. Source: [[ada-article]]; programmed by [[ada-lovelace]].' },
  ],
  log_entry: 'Integrated the Ada article.',
});

test('chatJson asks for JSON mode and retries once with the parse error', async () => {
  const { chatJson } = await import('../src/llm/json.js');
  const llm = new FakeChat(['{"a": "<a href="x">broken</a>"}', '{"a": "<a href=\\"x\\">ok</a>"}']);
  const events: string[] = [];
  assert.deepEqual(await chatJson(llm, { system: 's', user: 'u', maxTokens: 10 }, isRecord, (m) => events.push(m)), { a: '<a href="x">ok</a>' });
  assert.equal(llm.requests.length, 2);
  assert.ok(llm.requests.every((r) => r.json === true));
  assert.match(llm.requests[1]!.user, /^u\n\nYour previous reply could not be used: The model reply did not contain the expected JSON/);
  assert.match(events[0]!, /asking fake\/fake-model once more/);
  await assert.rejects(chatJson(new FakeChat(['nope', 'still nope']), { system: 's', user: 'u', maxTokens: 10 }, isRecord), /expected JSON/);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('Sure:\n```json\n{"a":1}\n```', isRecord), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a":{"b":2}} suffix', isRecord), { a: { b: 2 } });
  assert.throws(() => extractJson('nothing here', isRecord), /expected JSON/);
  assert.deepEqual(extractJson('{"a": "line one\nline\ttwo", "b": "q\\"x"}', isRecord), { a: 'line one\nline\ttwo', b: 'q"x' }, 'raw control characters inside strings are repaired');
});

test('ingest stages the source, writes pages, index, ledger and log; re-ingest is skipped', async () => {
  const paths = tempWiki();
  const src = path.join(paths.root, 'ada.md');
  fs.writeFileSync(src, '# Ada\n\nAda Lovelace wrote the first program for the Analytical Engine.');
  const llm = new FakeChat([plan]);
  const r = await ingestSource(config, paths, llm, src, ingestOpts);
  assert.equal(r.sourceRel, 'raw/ada.md');
  assert.ok(fs.existsSync(path.join(paths.raw, 'ada.md')));
  assert.deepEqual(r.applied.map((a) => a.id), ['sources/ada-article', 'entities/ada-lovelace', 'concepts/analytical-engine']);
  assert.match(llm.requests[0]!.user, /<source path="raw\/ada.md">/);
  assert.match(llm.requests[0]!.system, /LLM Wiki — schema/);
  const pages = listPages(paths);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.find((p) => p.id === 'concepts/analytical-engine')?.frontmatter.sources, ['raw/ada.md']);
  assert.match(fs.readFileSync(paths.index, 'utf8'), /\[\[ada-lovelace\|Ada Lovelace\]\] — Mathematician\./);
  const last = readLog(paths).at(-1)!;
  assert.equal(last.kind, 'ingest');
  assert.match(last.body, /- create \[\[entities\/ada-lovelace\]\] — new entity/);
  assert.deepEqual(pendingSources(paths), []);
  assert.equal(lintStructure(paths).findings.filter((f) => f.severity === 'error').length, 0);
  const again = await ingestSource(config, paths, new FakeChat([]), src, ingestOpts);
  assert.equal(again.skipped, true);
});

test('ingest dry-run writes nothing and rejects summary pages outside sources/', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'x.md'), 'text');
  const r = await ingestSource(config, paths, new FakeChat([plan]), 'raw/x.md', { ...ingestOpts, dryRun: true });
  assert.equal(r.plan?.pages.length, 2);
  assert.equal(listPages(paths).length, 0);
  const bad = JSON.parse(plan) as { summary_page: { path: string } };
  bad.summary_page.path = 'entities/oops';
  await assert.rejects(ingestSource(config, paths, new FakeChat([JSON.stringify(bad)]), path.join(paths.raw, 'x.md'), ingestOpts), /under sources/);
  await assert.rejects(ingestSource(config, paths, new FakeChat([]), path.join(paths.raw, 'x.md'), { ...ingestOpts, maxSourceChars: 2 }), /never truncates/);
});

test('query searches, answers with context, and files the answer as a synthesis', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'ada.md'), 'Ada');
  await ingestSource(config, paths, new FakeChat([plan]), path.join(paths.raw, 'ada.md'), ingestOpts);
  const llm = new FakeChat(['Ada wrote the first program ([[ada-lovelace]]).\n\n## Sources\n- [[ada-lovelace]]']);
  const r = await queryWiki(config, paths, llm, 'Who programmed the Analytical Engine?', { limit: 5, maxPages: 3, contextChars: 20000, maxTokens: 500, file: true });
  assert.match(llm.requests[0]!.user, /<pages>[\s\S]*<page id="concepts\/analytical-engine"/);
  assert.ok(r.pagesUsed.includes('concepts/analytical-engine'));
  assert.equal(r.filedAs, 'syntheses/who-programmed-the-analytical-engine');
  const filed = fs.readFileSync(paths.pageAbs(r.filedAs!), 'utf8');
  assert.match(filed, /type: synthesis/);
  assert.match(filed, /summary: "?Ada wrote the first program \(ada-lovelace\)\./);
  assert.equal(readLog(paths).at(-1)?.kind, 'query');
  assert.match(fs.readFileSync(paths.index, 'utf8'), /Syntheses & answers \(1\)/);
});

test('semantic lint parses the model JSON and files a report page', async () => {
  const paths = tempWiki();
  fs.writeFileSync(path.join(paths.raw, 'ada.md'), 'Ada');
  await ingestSource(config, paths, new FakeChat([plan]), path.join(paths.raw, 'ada.md'), ingestOpts);
  const reply = JSON.stringify({ contradictions: [{ pages: ['a', 'b'], description: 'dates differ' }], stale_claims: [], missing_pages: [{ name: 'Charles Babbage', mentioned_in: ['concepts/analytical-engine'], why: 'central figure' }], missing_links: [], data_gaps: ['birth date'], suggested_questions: ['q?'], suggested_sources: [] });
  const { result } = await lintSemantic(paths, new FakeChat([reply]), { contextChars: 100000, maxTokens: 500 });
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.missing_pages[0]?.name, 'Charles Babbage');
  const id = fileLintReport(paths, lintStructure(paths), result);
  assert.match(id, /^lint\/\d{4}-\d{2}-\d{2}$/);
  const page = fs.readFileSync(paths.pageAbs(id), 'utf8');
  assert.match(page, /## Contradictions/);
  assert.match(page, /\*\*Charles Babbage\*\*/);
  assert.equal(readLog(paths).at(-1)?.kind, 'lint');
});

test('cross-wiki query: pages from several wikis, [[wiki:page]] citations, a log entry in each wiki', async () => {
  const { queryWikis } = await import('../src/ops/query.js');
  const { addPage } = await import('./helpers.js');
  const work = tempWiki();
  const home = tempWiki('html');
  addPage(work, 'concepts/deploy-pipeline', 'Deploy pipeline', 'Releases go through the kubernetes deploy pipeline every Tuesday.');
  const { applyPageChanges } = await import('../src/ops/pages.js');
  applyPageChanges(home, [{ op: 'create', path: 'concepts/home-lab', content: '---\ntitle: Home lab\n---\n<h1>Home lab</h1><p>The home kubernetes cluster runs on three mini PCs.</p>' }]);
  const llm = new FakeChat(['Work deploys weekly [[work:concepts/deploy-pipeline]]; home runs three nodes [[home:concepts/home-lab]].']);
  const r = await queryWikis(config, [{ name: 'work', paths: work, description: 'Work docs' }, { name: 'home', paths: home }], llm, 'kubernetes cluster deploy', { limit: 10, maxPages: 5, contextChars: 20000, maxTokens: 500 });
  assert.deepEqual(r.wikis, ['work', 'home']);
  assert.deepEqual([...r.pagesUsed].sort(), ['home:wiki/concepts/home-lab.html', 'work:wiki/concepts/deploy-pipeline.md']);
  assert.match(llm.requests[0]!.system, /\[\[<wiki>:<page-id>\]\]/);
  assert.match(llm.requests[0]!.user, /- work: Work docs/);
  assert.match(llm.requests[0]!.user, /<page wiki="home" id="concepts\/home-lab"/);
  for (const w of [work, home]) assert.match(readLog(w).at(-1)!.body, /Cross-wiki query together with/);
});
