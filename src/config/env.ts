import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../errors.js';

export const TOOL_NAME = 'llm-wiki';

export type ConfigTier = 'shell' | 'tool-agents-env' | 'local-env' | 'cli';

const TIER_ORDER: ConfigTier[] = ['shell', 'tool-agents-env', 'local-env', 'cli'];

/** Higher number = higher priority. */
export function tierRank(tier: ConfigTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** `~/.tool-agents/llm-wiki` — the tool's private configuration folder. */
export function toolConfigDir(): string {
  return path.join(os.homedir(), '.tool-agents', TOOL_NAME);
}

/** `~/.tool-agents/llm-wiki/wikis.json` — the registry of named wikis. */
export function registryFile(): string {
  return path.join(toolConfigDir(), 'wikis.json');
}

/** Creates `~/.tool-agents/llm-wiki/` (0700) and an empty `.env` (0600) when missing. */
export function ensureToolConfigDir(): string {
  const dir = toolConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, '', { mode: 0o600 });
  }
  return dir;
}

/** Minimal dotenv parser: `KEY=value`, optional `export`, quotes, `#` comments. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function readDotenvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return parseDotenv(fs.readFileSync(file, 'utf8'));
}

interface Entry {
  value: string;
  tier: ConfigTier;
}

/**
 * Resolved configuration following the four-tier chain, lowest to highest priority:
 * shell env → ~/.tool-agents/llm-wiki/.env → ./.env → CLI flags.
 */
export class Config {
  private readonly entries = new Map<string, Entry>();

  private constructor() {}

  static load(cliOverrides: Record<string, string | undefined> = {}, cwd = process.cwd()): Config {
    const cfg = new Config();
    const layers: Array<[ConfigTier, Record<string, string | undefined>]> = [
      ['shell', process.env],
      ['tool-agents-env', readDotenvFile(path.join(toolConfigDir(), '.env'))],
      ['local-env', readDotenvFile(path.join(cwd, '.env'))],
      ['cli', cliOverrides],
    ];
    for (const [tier, values] of layers) {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined || value === '') continue;
        cfg.entries.set(key, { value, tier });
      }
    }
    return cfg;
  }

  /** Build a Config from explicit values only (used by tests and embedding callers). */
  static fromValues(values: Record<string, string>, tier: ConfigTier = 'cli'): Config {
    const cfg = new Config();
    for (const [key, value] of Object.entries(values)) cfg.entries.set(key, { value, tier });
    return cfg;
  }

  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }

  /** Returns the value of the first name that is set, or undefined. */
  getAny(...names: string[]): string | undefined {
    for (const n of names) {
      const v = this.get(n);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Returns the setting or throws a ConfigError. There is deliberately no default. */
  require(name: string, hint?: string): string {
    const v = this.get(name);
    if (v === undefined) {
      const where = `Set it in the shell, in ${path.join(toolConfigDir(), '.env')}, in ./.env, or via a CLI flag.`;
      throw new ConfigError(`Missing required configuration setting ${name}.${hint ? ' ' + hint : ''} ${where}`);
    }
    return v;
  }

  /** Same as require() but accepts aliases; the first set name wins. */
  requireAny(names: string[], hint?: string): string {
    const v = this.getAny(...names);
    if (v === undefined) {
      throw new ConfigError(
        `Missing required configuration setting ${names.join(' (or ')}${names.length > 1 ? ')' : ''}.${hint ? ' ' + hint : ''} ` +
          `Set it in the shell, in ${path.join(toolConfigDir(), '.env')}, in ./.env, or via a CLI flag.`,
      );
    }
    return v;
  }

  source(name: string): ConfigTier | undefined {
    return this.entries.get(name)?.tier;
  }

  /** Names and tiers for every setting matching the prefix filter (values masked when secret). */
  describe(filter: (name: string) => boolean): Array<{ name: string; tier: ConfigTier; value: string }> {
    const rows: Array<{ name: string; tier: ConfigTier; value: string }> = [];
    for (const [name, entry] of this.entries) {
      if (!filter(name)) continue;
      const secret = /KEY|TOKEN|SECRET|PASSWORD/i.test(name);
      const value = secret ? mask(entry.value) : entry.value;
      rows.push({ name, tier: entry.tier, value });
    }
    rows.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name));
    return rows;
  }
}

function mask(v: string): string {
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
