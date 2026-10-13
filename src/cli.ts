#!/usr/bin/env node
import fs from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { Config, ensureToolConfigDir, toolConfigDir } from './config/env.js';
import { wikiRoot } from './config/settings.js';
import { LlmWikiError } from './errors.js';
import { createChatClient, createEmbeddingClient, createParserClient } from './llm/factory.js';
import { embedMissing, search, type SearchMode } from './search/search.js';
import { EmbeddingStore, SearchStore } from './search/store.js';
import { embeddingSettings } from './config/settings.js';
import { WikiPaths } from './wiki/layout.js';
import { writeIndex } from './wiki/index.js';
import { readLog } from './wiki/log.js';
import { formatLintReport, lintStructure } from './wiki/lint.js';
import { initWiki } from './ops/init.js';
import { ingestSource, pendingSources } from './ops/ingest.js';
import { parseDocument } from './ops/parse.js';
import { queryWiki } from './ops/query.js';
import { fileLintReport, lintSemantic, renderSemanticLint } from './ops/lint-llm.js';
import { serveMcp } from './mcp/server.js';

const program = new Command();
const info = (msg: string) => process.stderr.write(`${msg}\n`);

function intArg(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer');
  return n;
}
function modeArg(v: string): SearchMode {
  if (v === 'bm25' || v === 'vector' || v === 'hybrid') return v;
  throw new InvalidArgumentError('expected bm25, vector or hybrid');
}

function loadConfig(): Config {
  ensureToolConfigDir();
  const g = program.opts<{ root?: string; provider?: string; model?: string }>();
  return Config.load({ LLM_WIKI_ROOT: g.root, LLM_WIKI_PROVIDER: g.provider, LLM_WIKI_MODEL: g.model });
}

function openWiki(config: Config): WikiPaths {
  const paths = new WikiPaths(wikiRoot(config));
  paths.assertInitialised();
  return paths;
}

program
  .name('llm-wiki')
  .description("Karpathy-style LLM wiki: compile raw sources into an interlinked markdown wiki and search it locally.")
  .version('0.1.0')
  .option('--root <dir>', 'wiki root (overrides LLM_WIKI_ROOT)')
  .option('--provider <name>', 'chat provider (overrides LLM_WIKI_PROVIDER)')
  .option('--model <name>', 'chat model (overrides LLM_WIKI_MODEL)')
  .option('--verbose', 'print stack traces for unexpected errors', false);

program
  .command('init')
  .description('create the raw/, wiki/ and schema layout in a directory')
  .argument('<dir>', 'directory to initialise (created if missing)')
  .option('--force', 'rewrite CLAUDE.md/AGENTS.md even if they exist', false)
  .action((dir: string, opts: { force: boolean }) => {
    ensureToolConfigDir();
    const r = initWiki(dir, { force: opts.force });
    info(`initialised wiki at ${r.root}`);
    for (const c of r.created) info(`  created ${c}`);
    info(`next: export LLM_WIKI_ROOT=${r.root} (or pass --root), drop sources into raw/, then run llm-wiki ingest raw/<file>`);
  });

program
  .command('ingest')
  .description('compile one or more raw sources into the wiki with the configured LLM')
  .argument('[files...]', 'source files (outside raw/ they are copied in); omit to ingest every pending source')
  .option('--force', 're-ingest even if the source is unchanged', false)
  .option('--dry-run', 'show the proposed page changes without writing', false)
  .option('--max-tokens <n>', 'reply token limit', intArg, 32000)
  .option('--related <n>', 'related pages to include as context', intArg, 8)
  .option('--context-chars <n>', 'character budget for related pages', intArg, 60000)
  .option('--max-source-chars <n>', 'refuse sources above this size instead of truncating', intArg, 300000)
  .option('--reparse', 're-convert PDF/DOCX originals even if their markdown is up to date', false)
  .option('--parse-max-tokens <n>', 'reply token limit for the parser LLM', intArg, 64000)
  .option('--max-bytes <n>', 'refuse PDF/DOCX originals above this many bytes', intArg, 30000000)
  .action(async (files: string[], opts: { force: boolean; dryRun: boolean; maxTokens: number; related: number; contextChars: number; maxSourceChars: number; reparse: boolean; parseMaxTokens: number; maxBytes: number }) => {
    const config = loadConfig();
    const paths = openWiki(config);
    const llm = createChatClient(config);
    let parser: ReturnType<typeof createParserClient> | undefined;
    const getParser = () => (parser ??= createParserClient(config));
    const targets = files.length > 0 ? files : pendingSources(paths).map((rel) => `${paths.root}/${rel}`);
    if (targets.length === 0) {
      info('nothing to ingest: every raw source is already compiled into the wiki');
      return;
    }
    for (const file of targets) {
      const r = await ingestSource(config, paths, llm, file, {
        force: opts.force,
        dryRun: opts.dryRun,
        maxTokens: opts.maxTokens,
        relatedLimit: opts.related,
        contextChars: opts.contextChars,
        maxSourceChars: opts.maxSourceChars,
        parser: getParser,
        parse: { force: opts.reparse, maxTokens: opts.parseMaxTokens, maxBytes: opts.maxBytes },
        onEvent: info,
      });
      if (r.skipped || !r.plan) continue;
      process.stdout.write(`# ${r.plan.title}\n\nSource: ${r.sourceRel}${r.originalRel ? ` (converted from ${r.originalRel})` : ''}\n\nTakeaways:\n${r.plan.takeaways.map((t) => `- ${t}`).join('\n')}\n\n`);
      if (opts.dryRun) {
        process.stdout.write(`Proposed changes (dry run):\n- replace ${r.plan.summaryPage.path}\n${r.plan.pages.map((p) => `- ${p.op} ${p.path}${p.reason ? ` — ${p.reason}` : ''}`).join('\n')}\n\n`);
      } else {
        process.stdout.write(`Pages written:\n${r.applied.map((a) => `- ${a.op} wiki/${a.id}.md${a.reason ? ` — ${a.reason}` : ''}`).join('\n')}\n\n`);
      }
    }
  });

program
  .command('parse')
  .description('convert PDF/DOCX originals into markdown with the dedicated parser LLM, without ingesting')
  .argument('<files...>', 'PDF or DOCX files (outside raw/ they are copied in)')
  .option('--force', 're-convert even if the markdown is up to date', false)
  .option('--max-tokens <n>', 'reply token limit for the parser LLM', intArg, 64000)
  .option('--max-bytes <n>', 'refuse originals above this many bytes', intArg, 30000000)
  .action(async (files: string[], opts: { force: boolean; maxTokens: number; maxBytes: number }) => {
    const config = loadConfig();
    const paths = openWiki(config);
    const parser = createParserClient(config);
    for (const file of files) {
      const r = await parseDocument(paths, parser, file, { force: opts.force, maxTokens: opts.maxTokens, maxBytes: opts.maxBytes, onEvent: info });
      process.stdout.write(`${r.skipped ? 'up to date' : 'converted'}: ${r.originalRel} -> ${r.markdownRel}\n`);
    }
  });

program
  .command('query')
  .description('answer a question from the wiki with citations; --file stores the answer as a synthesis page')
  .argument('<question>')
  .option('--file', 'file the answer back into wiki/syntheses/', false)
  .option('--limit <n>', 'search hits to consider', intArg, 12)
  .option('--pages <n>', 'max pages to load into context', intArg, 8)
  .option('--context-chars <n>', 'character budget for pages', intArg, 80000)
  .option('--mode <mode>', 'bm25 | vector | hybrid (default: hybrid when embeddings exist, else bm25)', modeArg)
  .option('--max-tokens <n>', 'reply token limit', intArg, 16000)
  .action(async (question: string, opts: { file: boolean; limit: number; pages: number; contextChars: number; mode?: SearchMode; maxTokens: number }) => {
    const config = loadConfig();
    const paths = openWiki(config);
    const llm = createChatClient(config);
    const r = await queryWiki(config, paths, llm, question, { limit: opts.limit, maxPages: opts.pages, contextChars: opts.contextChars, maxTokens: opts.maxTokens, mode: opts.mode, file: opts.file, onEvent: info });
    process.stdout.write(`${r.answer}\n`);
    if (r.filedAs) info(`filed as wiki/${r.filedAs}.md`);
  });

program
  .command('search')
  .description('local search over wiki pages (no LLM needed for bm25)')
  .argument('<query>')
  .option('--mode <mode>', 'bm25 | vector | hybrid', modeArg, 'bm25')
  .option('--limit <n>', 'hits to return', intArg, 10)
  .option('--layer <layer>', 'wiki | raw | all', (v: string) => { if (v === 'wiki' || v === 'raw' || v === 'all') return v; throw new InvalidArgumentError('expected wiki, raw or all'); }, 'wiki')
  .option('--json', 'machine-readable output', false)
  .action(async (query: string, opts: { mode: SearchMode; limit: number; layer: 'wiki' | 'raw' | 'all'; json: boolean }) => {
    const config = loadConfig();
    const paths = openWiki(config);
    const store = new SearchStore(paths);
    store.reindex({ includeRaw: opts.layer !== 'wiki' });
    let embedder: Parameters<typeof search>[2]['embedder'];
    if (opts.mode !== 'bm25') {
      const { provider, model } = embeddingSettings(config);
      embedder = { client: createEmbeddingClient(config), store: new EmbeddingStore(paths, provider, model) };
    }
    const hits = await search(store, query, { mode: opts.mode, limit: opts.limit, layer: opts.layer, embedder });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(hits.map((h) => ({ file: h.chunk.file, layer: h.chunk.layer, title: h.chunk.title, heading: h.chunk.heading, score: h.score, snippet: h.snippet })), null, 2)}\n`);
      return;
    }
    if (hits.length === 0) {
      process.stdout.write('No hits.\n');
      return;
    }
    hits.forEach((h, i) => process.stdout.write(`${i + 1}. ${h.chunk.file}${h.chunk.heading ? ` › ${h.chunk.heading}` : ''}  (${h.score.toFixed(3)})\n   ${h.snippet}\n`));
  });

program
  .command('index')
  .description('regenerate wiki/index.md and rebuild the search index incrementally')
  .option('--raw', 'also index raw/ sources for search', false)
  .option('--embed', 'compute missing embeddings with the configured embedding provider', false)
  .action(async (opts: { raw: boolean; embed: boolean }) => {
    const config = loadConfig();
    const paths = openWiki(config);
    const changed = writeIndex(paths);
    info(`wiki/index.md ${changed ? 'updated' : 'unchanged'}`);
    const store = new SearchStore(paths);
    const r = store.reindex({ includeRaw: opts.raw });
    info(`search index: ${r.chunks} chunk(s) — ${r.added} file(s) added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.removed} removed`);
    if (opts.embed) {
      const { provider, model } = embeddingSettings(config);
      const embedStore = new EmbeddingStore(paths, provider, model);
      const n = await embedMissing(store, embedStore, createEmbeddingClient(config), { onProgress: (d, t) => info(`embedded ${d}/${t}`) });
      info(`embeddings: ${n} computed, ${embedStore.size} stored (${provider}/${model})`);
    }
  });

program
  .command('lint')
  .description('health-check the wiki; --llm adds semantic checks (contradictions, stale claims, missing pages)')
  .option('--llm', 'run the semantic lint with the configured LLM', false)
  .option('--fix', 'regenerate index.md and the search index', false)
  .option('--report', 'file the findings as wiki/lint/<date>.md', false)
  .option('--json', 'machine-readable output', false)
  .option('--context-chars <n>', 'character budget for pages sent to the LLM', intArg, 200000)
  .option('--max-tokens <n>', 'reply token limit', intArg, 16000)
  .action(async (opts: { llm: boolean; fix: boolean; report: boolean; json: boolean; contextChars: number; maxTokens: number }) => {
    const config = loadConfig();
    const paths = openWiki(config);
    if (opts.fix) {
      writeIndex(paths);
      new SearchStore(paths).reindex({ includeRaw: false });
      info('index.md and search index regenerated');
    }
    const structural = lintStructure(paths);
    let semantic: Awaited<ReturnType<typeof lintSemantic>>['result'] | undefined;
    if (opts.llm) semantic = (await lintSemantic(paths, createChatClient(config), { contextChars: opts.contextChars, maxTokens: opts.maxTokens, onEvent: info })).result;
    if (opts.json) process.stdout.write(`${JSON.stringify({ structural, semantic }, null, 2)}\n`);
    else {
      process.stdout.write(`${formatLintReport(structural)}\n`);
      if (semantic) process.stdout.write(`\n${renderSemanticLint(semantic)}\n`);
    }
    if (opts.report) info(`filed as wiki/${fileLintReport(paths, structural, semantic)}.md`);
    if (structural.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
  });

program
  .command('log')
  .description('show recent log entries')
  .option('--last <n>', 'number of entries', intArg, 10)
  .option('--kind <kind>', 'filter by kind (ingest, query, lint, edit, note, init)')
  .option('--json', 'machine-readable output', false)
  .action((opts: { last: number; kind?: string; json: boolean }) => {
    const paths = openWiki(loadConfig());
    const entries = readLog(paths).filter((e) => !opts.kind || e.kind === opts.kind).slice(-opts.last);
    if (opts.json) process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    else process.stdout.write(entries.length === 0 ? 'Log is empty.\n' : `${entries.map((e) => `## [${e.date}] ${e.kind} | ${e.title}${e.body ? `\n${e.body}` : ''}`).join('\n\n')}\n`);
  });

program
  .command('config')
  .description('show which settings are resolved and from which tier')
  .action(() => {
    const config = loadConfig();
    const rows = config.describe((n) => /^(LLM_WIKI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_OPENAI_|AZURE_AI_INFERENCE_|OLLAMA_|LITELLM_)/.test(n));
    process.stdout.write(`config folder: ${toolConfigDir()} (${fs.existsSync(toolConfigDir()) ? 'present' : 'missing'})\n`);
    process.stdout.write(`resolution: shell env < ~/.tool-agents/llm-wiki/.env < ./.env < CLI flags\n\n`);
    if (rows.length === 0) process.stdout.write('no llm-wiki or provider settings found\n');
    for (const r of rows) process.stdout.write(`${r.name.padEnd(32)} ${r.tier.padEnd(16)} ${r.value}\n`);
  });

program
  .command('mcp')
  .description('serve the wiki as an MCP server over stdio (tools: wiki_search, wiki_read_page, wiki_write_page, ...)')
  .action(async () => {
    const config = loadConfig();
    await serveMcp(config, openWiki(config));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof LlmWikiError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  const verbose = program.opts<{ verbose?: boolean }>().verbose === true;
  const msg = err instanceof Error ? (verbose ? (err.stack ?? err.message) : err.message) : String(err);
  process.stderr.write(`error: ${msg}\n${verbose ? '' : '(re-run with --verbose for a stack trace)\n'}`);
  process.exit(1);
});
