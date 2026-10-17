import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import { describeCommand, GUIDE_TOPICS, renderCommandReference, renderTopic } from '../src/guide.js';

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });

test('every hand-written guide topic exists and is non-trivial', () => {
  const program = new Command('llm-wiki');
  for (const t of GUIDE_TOPICS) {
    if (t.id === 'commands') continue;
    assert.ok(renderTopic(program, t.id).length > 500, `topic ${t.id} is too short`);
  }
});

test('the command reference is generated from the commander tree', () => {
  const program = new Command('tool').option('--wiki <name>', 'which wiki');
  const sub = program.command('things').description('group');
  sub.command('add').description('add a thing').argument('<name>', 'thing name').option('--limit <n>', 'max', '5').option('--json', 'json', false);
  const spec = describeCommand(program);
  const add = spec.subcommands[0]!.subcommands[0]!;
  assert.equal(add.command, 'tool things add');
  assert.deepEqual(add.arguments, [{ name: 'name', required: true, variadic: false, description: 'thing name' }]);
  assert.deepEqual(add.options.map((o) => [o.flags, o.default]), [['--limit <n>', '5'], ['--json', undefined]]);
  const md = renderCommandReference(program);
  assert.match(md, /### `tool things add`/);
  assert.match(md, /`--wiki <name>` — which wiki/);
});

test('llm-wiki guide covers every real command, and --json is valid', () => {
  const full = run('guide');
  for (const cmd of ['init', 'wikis', 'wikis use', 'ingest', 'parse', 'query', 'search', 'index', 'lint', 'log', 'config', 'mcp', 'guide']) {
    assert.ok(full.includes(`\`llm-wiki ${cmd}\``), `guide misses ${cmd}`);
  }
  const json = JSON.parse(run('guide', '--json')) as { topics: Array<{ id: string }>; cli: { subcommands: Array<{ command: string }> } };
  assert.equal(json.topics.length, GUIDE_TOPICS.length);
  assert.ok(json.cli.subcommands.some((c) => c.command === 'llm-wiki query'));
  assert.match(run('guide', 'skill'), /Decision table/);
});
