import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { LlmWikiError } from './errors.js';

/** Guide topics in reading order. `commands` is generated from the live CLI definition. */
export const GUIDE_TOPICS = [
  { id: 'overview', title: 'What llm-wiki is and what it can do' },
  { id: 'layout', title: 'Wiki directory layout, page format, PDF/DOCX handling' },
  { id: 'selection', title: 'Wiki registry and how a command picks its wiki' },
  { id: 'commands', title: 'Reference of every command, argument and option (generated)' },
  { id: 'workflows', title: 'Task recipes: create, add documents, query, search, maintain' },
  { id: 'config', title: 'Configuration settings, providers and credentials' },
  { id: 'output', title: 'stdout/stderr conventions and the JSON shape of every --json output' },
  { id: 'errors', title: 'Exit codes and common error messages with fixes' },
  { id: 'mcp', title: 'The MCP server and its tools' },
  { id: 'agent-rules', title: 'Rules an AI agent must follow when operating the tool' },
  { id: 'skill', title: 'How to build a Claude skill that uses llm-wiki' },
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number]['id'];

function guideDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '..', 'guide'), path.join(here, '..', '..', 'guide')]) {
    if (fs.existsSync(path.join(candidate, 'overview.md'))) return candidate;
  }
  throw new Error('The guide/ folder is missing from the llm-wiki installation.');
}

export interface ArgSpec {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}
export interface OptionSpec {
  flags: string;
  description: string;
  default?: unknown;
}
export interface CommandSpec {
  command: string;
  usage: string;
  description: string;
  arguments: ArgSpec[];
  options: OptionSpec[];
  subcommands: CommandSpec[];
}

/** Walks the commander tree into a plain structure (used by both the markdown and the JSON guide). */
export function describeCommand(cmd: Command, prefix: string[] = []): CommandSpec {
  const pathParts = [...prefix, cmd.name()];
  const options = cmd.options
    .filter((o) => !o.hidden)
    .map((o) => {
      // Boolean flags default to false; that is not interesting to document. --no-x defaults to true.
      const showDefault = o.defaultValue !== undefined && o.defaultValue !== false && !o.negate;
      return { flags: o.flags, description: o.description, ...(showDefault ? { default: o.defaultValue as unknown } : {}) };
    });
  return {
    command: pathParts.join(' '),
    usage: `${pathParts.join(' ')} ${cmd.usage()}`.trim(),
    description: cmd.description(),
    arguments: cmd.registeredArguments.map((a) => ({ name: a.name(), required: a.required, variadic: a.variadic, description: a.description })),
    options,
    subcommands: cmd.commands.filter((c) => c.name() !== 'help').map((c) => describeCommand(c, pathParts)),
  };
}

function renderCommand(spec: CommandSpec, level: number): string {
  const out: string[] = [];
  out.push(`${'#'.repeat(level)} \`${spec.command}\``, '', spec.description, '', '```', spec.usage, '```', '');
  if (spec.arguments.length) {
    out.push('Arguments:', '');
    for (const a of spec.arguments) out.push(`- \`${a.variadic ? `${a.name}...` : a.name}\` (${a.required ? 'required' : 'optional'}${a.variadic ? ', one or more' : ''}) — ${a.description || '—'}`);
    out.push('');
  }
  if (spec.options.length) {
    out.push('Options:', '');
    for (const o of spec.options) out.push(`- \`${o.flags}\` — ${o.description}${o.default !== undefined ? ` (default: \`${String(o.default)}\`)` : ''}`);
    out.push('');
  }
  for (const s of spec.subcommands) out.push(renderCommand(s, Math.min(level + 1, 6)));
  return out.join('\n');
}

/** The `commands` topic: global options, then every command (and `wikis` subcommand). */
export function renderCommandReference(program: Command): string {
  const root = describeCommand(program);
  const parts = ['# Command reference', '', 'Generated from the installed CLI, so it always matches this version.', ''];
  parts.push('## Global options', '', 'Placed before the command name, e.g. `llm-wiki --wiki work search "x"`.', '');
  for (const o of root.options) parts.push(`- \`${o.flags}\` — ${o.description}${o.default !== undefined ? ` (default: \`${String(o.default)}\`)` : ''}`);
  parts.push('');
  for (const c of root.subcommands) parts.push(renderCommand(c, 2));
  return parts.join('\n');
}

export function renderTopic(program: Command, id: GuideTopic): string {
  if (id === 'commands') return renderCommandReference(program);
  return fs.readFileSync(path.join(guideDir(), `${id}.md`), 'utf8').trimEnd();
}

export function parseTopic(raw: string): GuideTopic {
  const t = GUIDE_TOPICS.find((x) => x.id === raw.toLowerCase());
  if (!t) throw new LlmWikiError(`Unknown guide topic "${raw}". Topics: ${GUIDE_TOPICS.map((x) => x.id).join(', ')}.`);
  return t.id;
}

/** The whole guide as one markdown document, with a table of contents. */
export function renderGuide(program: Command, version: string): string {
  const head = [
    `# llm-wiki ${version} — complete guide`,
    '',
    'This guide is written for people and for AI agents (for example Claude building a skill).',
    'Each section is also available alone: `llm-wiki guide <topic>`; machine-readable: `llm-wiki guide --json`.',
    '',
    '## Contents',
    '',
    ...GUIDE_TOPICS.map((t) => `- \`${t.id}\` — ${t.title}`),
    '',
  ].join('\n');
  // Demote each topic's headings one level so the document has a single H1.
  const body = GUIDE_TOPICS.map((t) => renderTopic(program, t.id).replace(/^(#{1,5}) /gm, '#$1 ')).join('\n\n---\n\n');
  return `${head}\n${body}\n`;
}

export function guideJson(program: Command, version: string): unknown {
  return {
    tool: 'llm-wiki',
    version,
    topics: GUIDE_TOPICS.map((t) => ({ id: t.id, title: t.title, ...(t.id === 'commands' ? {} : { markdown: renderTopic(program, t.id) }) })),
    cli: describeCommand(program),
  };
}
