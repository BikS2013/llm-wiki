import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { browserCandidates, checkSources, chromiumRenderer, fetchToRaw, needsRendering, webPageToMarkdown, type PageRenderer } from '../src/ops/fetch.js';
import { FetchLedger } from '../src/ops/ledger.js';
import { stageSource } from '../src/ops/stage.js';
import { tempWiki } from './helpers.js';

type Route = { type: string; body: string | Buffer; etag?: string };

async function serve(routes: Record<string, Route>): Promise<{ base: string; hits: Record<string, number>; close: () => void }> {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hits[url] = (hits[url] ?? 0) + 1;
    const r = routes[url];
    if (!r) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (r.etag) {
      if (req.headers['if-none-match'] === r.etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('etag', r.etag);
    }
    res.setHeader('content-type', r.type);
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => server.close() };
}

const ARTICLE = (extra: string, nonce = 'a1') => `<!doctype html><html><head><title>Release notes</title><script nonce="${nonce}">window.t=${Date.now()}</script></head>
<body><article><h1>Release notes</h1><p>Version two ships the new scheduler. Jobs are now placed by expected duration instead of arrival order, which keeps short jobs from waiting behind long ones. The queue page shows the estimate for every job, and the old ordering can still be selected per queue for teams that depend on it. ${extra}</p></article></body></html>`;

const SPA = `<!doctype html><html><head><title>Dashboard</title><script src="/app.js" defer></script></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;

function tinyPdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1');
}

/** A stand-in for headless Chrome: returns a fixed rendered DOM and a PDF, and counts calls. */
class FakeRenderer implements PageRenderer {
  dumps = 0;
  prints = 0;
  constructor(public dom: string) {}
  async dumpDom(): Promise<string> {
    this.dumps++;
    return this.dom;
  }
  async printPdf(): Promise<Buffer> {
    this.prints++;
    return tinyPdf(this.dom);
  }
}

test('needsRendering: application shells and JavaScript notices yes, articles no', () => {
  assert.equal(needsRendering(SPA, webPageToMarkdown(SPA).text), true);
  const article = ARTICLE('');
  assert.equal(needsRendering(article, webPageToMarkdown(article).text), false);
  const tinyStatic = '<html><body><p>Short static page.</p></body></html>';
  assert.equal(needsRendering(tinyStatic, webPageToMarkdown(tinyStatic).text), false, 'a short page without scripts is just short');
});

test('pages that need JavaScript are printed to PDF with the browser; unchanged rendered text is reused', async () => {
  const srv = await serve({ '/dash': { type: 'text/html', body: SPA } });
  try {
    const paths = tempWiki();
    await assert.rejects(fetchToRaw(paths, `${srv.base}/dash`, { maxBytes: 1e6 }), (e: Error) => e.name === 'ConfigError' && /LLM_WIKI_BROWSER/.test(e.message));
    const renderer = new FakeRenderer('<html><body><main><h1>Dashboard</h1><p>Open incidents: 3. Deploys today: 12.</p></main></body></html>');
    const first = await fetchToRaw(paths, `${srv.base}/dash`, { maxBytes: 1e6, renderer: () => renderer });
    assert.equal(first.originalRel, 'raw/web/127.0.0.1-dash.pdf');
    assert.equal(first.sourceRel, first.originalRel, 'the PDF itself is the source; the parser LLM converts it');
    assert.equal(new FetchLedger(paths).get(first.originalRel)?.rendered, true);
    assert.equal(renderer.prints, 1);
    const again = await fetchToRaw(paths, `${srv.base}/dash`, { maxBytes: 1e6, renderer: () => renderer });
    assert.equal(again.downloaded, false);
    assert.equal(renderer.prints, 1, 'same rendered text: no new PDF');
    renderer.dom = renderer.dom.replace('3.', '5.');
    const changed = await fetchToRaw(paths, `${srv.base}/dash`, { maxBytes: 1e6, renderer: () => renderer });
    assert.match(changed.originalRel, /^raw\/web\/127\.0\.0\.1-dash-\d{4}-\d{2}-\d{2}\.pdf$/);
    assert.equal(renderer.prints, 2);
  } finally {
    srv.close();
  }
});

test('--render prints any page; a static page whose markup changes but text does not is unchanged', async () => {
  const routes: Record<string, Route> = { '/notes': { type: 'text/html', body: ARTICLE('', 'n1') } };
  const srv = await serve(routes);
  try {
    const paths = tempWiki();
    const first = await fetchToRaw(paths, `${srv.base}/notes`, { maxBytes: 1e6 });
    routes['/notes'] = { type: 'text/html', body: ARTICLE('', 'n2-different-nonce') };
    const second = await fetchToRaw(paths, `${srv.base}/notes`, { maxBytes: 1e6 });
    assert.equal(second.originalRel, first.originalRel);
    assert.equal(second.downloaded, false, 'only scripts/nonces changed: same text hash');
    const renderer = new FakeRenderer(ARTICLE(''));
    const forced = await fetchToRaw(paths, `${srv.base}/notes`, { maxBytes: 1e6, render: true, renderer: () => renderer });
    assert.match(forced.originalRel, /\.pdf$/);
  } finally {
    srv.close();
  }
});

test('sources check: URLs by text hash and HTTP 304, outside files by SHA-256; changed files get dated copies', async () => {
  const routes: Record<string, Route> = {
    '/notes': { type: 'text/html', body: ARTICLE('') },
    '/spec.pdf': { type: 'application/pdf', body: tinyPdf('v1'), etag: '"v1"' },
  };
  const srv = await serve(routes);
  try {
    const paths = tempWiki();
    await fetchToRaw(paths, `${srv.base}/notes`, { maxBytes: 1e6 });
    await fetchToRaw(paths, `${srv.base}/spec.pdf`, { maxBytes: 1e6 });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-outside-'));
    const file = path.join(outside, 'plan.md');
    fs.writeFileSync(file, '# Plan\n\nv1');
    assert.equal(stageSource(paths, file), 'raw/plan.md');

    let checks = await checkSources(paths, { maxBytes: 1e6 });
    const status = () => Object.fromEntries(checks.map((c) => [c.origin.replace(srv.base, ''), c.status]));
    assert.deepEqual(status(), { [file]: 'unchanged', '/notes': 'unchanged', '/spec.pdf': 'unchanged' });
    assert.equal(checks.find((c) => c.origin.endsWith('/spec.pdf'))?.detail, 'not modified (HTTP 304)');

    routes['/notes'] = { type: 'text/html', body: ARTICLE('Version two also adds per-team quotas.') };
    routes['/spec.pdf'] = { type: 'application/pdf', body: tinyPdf('v2'), etag: '"v2"' };
    fs.writeFileSync(file, '# Plan\n\nv2');
    checks = await checkSources(paths, { maxBytes: 1e6 });
    assert.deepEqual(status(), { [file]: 'changed', '/notes': 'changed', '/spec.pdf': 'changed' });

    const dated = stageSource(paths, file);
    assert.match(dated, /^raw\/plan-\d{4}-\d{2}-\d{2}\.md$/);
    assert.equal(fs.readFileSync(path.join(paths.root, 'raw/plan.md'), 'utf8'), '# Plan\n\nv1', 'the first copy is untouched');
    checks = await checkSources(paths, { maxBytes: 1e6 });
    assert.equal(checks.find((c) => c.kind === 'file')?.status, 'unchanged');
    assert.equal(checks.find((c) => c.kind === 'file')?.raw, dated);

    fs.rmSync(file);
    checks = await checkSources(paths, { maxBytes: 1e6 });
    assert.equal(checks.find((c) => c.kind === 'file')?.status, 'missing');
    routes['/notes'] = { type: 'text/html', body: '' };
    delete routes['/notes'];
    checks = await checkSources(paths, { maxBytes: 1e6 });
    assert.equal(checks.find((c) => c.origin.endsWith('/notes'))?.status, 'error');
  } finally {
    srv.close();
  }
});

test('a different file with the same name from elsewhere is still refused', () => {
  const paths = tempWiki();
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-b-'));
  fs.writeFileSync(path.join(a, 'notes.md'), 'one');
  fs.writeFileSync(path.join(b, 'notes.md'), 'two');
  stageSource(paths, path.join(a, 'notes.md'));
  assert.throws(() => stageSource(paths, path.join(b, 'notes.md')), /already exists with different content/);
});

test('real headless browser: renders a JavaScript-built page to DOM text and PDF', { skip: browserCandidates().length === 0 ? 'no Chromium-family browser installed' : false }, async () => {
  const appJs = `document.getElementById('root').innerHTML = '<h1>Rendered by JavaScript</h1><p>' + 'The quarterly figures appear only after the script runs. '.repeat(8) + '</p>';`;
  const srv = await serve({ '/': { type: 'text/html', body: SPA }, '/app.js': { type: 'application/javascript', body: appJs } });
  try {
    const renderer = chromiumRenderer(browserCandidates()[0]!);
    const dom = await renderer.dumpDom(`${srv.base}/`);
    assert.match(webPageToMarkdown(dom).text, /Rendered by JavaScript/);
    const pdf = await renderer.printPdf(`${srv.base}/`);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const paths = tempWiki();
    const r = await fetchToRaw(paths, `${srv.base}/`, { maxBytes: 1e6, renderer: () => renderer });
    assert.match(r.originalRel, /\.pdf$/);
  } finally {
    srv.close();
  }
});
