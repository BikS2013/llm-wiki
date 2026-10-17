import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, LlmWikiError } from '../errors.js';
import { WikiPaths } from './layout.js';

/** One registered wiki. The name is the handle used with `--wiki <name>`. */
export interface WikiEntry {
  name: string;
  root: string;
  description?: string;
  registered: string;
}

interface RegistryFile {
  version: 1;
  current?: string;
  wikis: Record<string, Omit<WikiEntry, 'name'>>;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertWikiName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new LlmWikiError(`"${name}" is not a valid wiki name: use lowercase letters, digits, ".", "_" or "-" (max 64 chars, starting with a letter or digit).`);
  }
  return name;
}

/** Turns a directory name into a valid wiki name, e.g. `My Notes` → `my-notes`. */
export function slugWikiName(dir: string): string {
  const slug = path
    .basename(path.resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  if (slug === '') throw new LlmWikiError(`Cannot derive a wiki name from "${dir}"; pass --name.`);
  return slug;
}

/**
 * The registry of known wikis, persisted as JSON (`~/.tool-agents/llm-wiki/wikis.json` for the CLI).
 * It only records names, roots and the current selection; it never creates or deletes wiki files.
 */
export class WikiRegistry {
  private data: RegistryFile;

  constructor(readonly file: string) {
    this.data = WikiRegistry.read(file);
  }

  private static read(file: string): RegistryFile {
    if (!fs.existsSync(file)) return { version: 1, wikis: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new LlmWikiError(`The wiki registry ${file} is not valid JSON (${(err as Error).message}). Fix or remove it.`);
    }
    const p = parsed as Partial<RegistryFile>;
    if (!p || typeof p !== 'object' || p.version !== 1 || typeof p.wikis !== 'object' || p.wikis === null) {
      throw new LlmWikiError(`The wiki registry ${file} has an unexpected shape (expected {"version":1,"wikis":{...}}).`);
    }
    return { version: 1, wikis: p.wikis, ...(typeof p.current === 'string' ? { current: p.current } : {}) };
  }

  private save(): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list(): WikiEntry[] {
    return Object.entries(this.data.wikis)
      .map(([name, e]) => ({ name, ...e }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return Object.keys(this.data.wikis).length;
  }

  find(name: string): WikiEntry | undefined {
    const e = this.data.wikis[name];
    return e ? { name, ...e } : undefined;
  }

  /** Returns the entry or throws, naming the wikis that do exist. */
  get(name: string): WikiEntry {
    const e = this.find(name);
    if (!e) {
      const known = this.list().map((w) => w.name);
      throw new ConfigError(`No wiki named "${name}" is registered.${known.length ? ` Registered: ${known.join(', ')}.` : ' The registry is empty.'} Add one with: llm-wiki wikis add <name> <dir>`);
    }
    return e;
  }

  /** Name of the registered wiki whose root is `dir`, if any. */
  nameForRoot(dir: string): string | undefined {
    const abs = path.resolve(dir);
    return this.list().find((w) => w.root === abs)?.name;
  }

  get current(): string | undefined {
    return this.data.current;
  }

  /** Registers an initialised wiki. Refuses duplicate names and duplicate roots. */
  add(name: string, root: string, opts: { description?: string; today: string }): WikiEntry {
    assertWikiName(name);
    const abs = path.resolve(root);
    new WikiPaths(abs).assertInitialised();
    if (this.data.wikis[name]) throw new LlmWikiError(`A wiki named "${name}" is already registered (${this.data.wikis[name]!.root}).`);
    const clash = this.nameForRoot(abs);
    if (clash) throw new LlmWikiError(`${abs} is already registered as "${clash}".`);
    this.data.wikis[name] = { root: abs, registered: opts.today, ...(opts.description ? { description: opts.description } : {}) };
    this.save();
    return this.get(name);
  }

  /** Unregisters a wiki. Files on disk are never touched. Clears the selection if it pointed here. */
  remove(name: string): WikiEntry {
    const e = this.get(name);
    delete this.data.wikis[name];
    if (this.data.current === name) delete this.data.current;
    this.save();
    return e;
  }

  rename(from: string, to: string): WikiEntry {
    const e = this.get(from);
    assertWikiName(to);
    if (this.data.wikis[to]) throw new LlmWikiError(`A wiki named "${to}" is already registered.`);
    const { name: _n, ...rest } = e;
    delete this.data.wikis[from];
    this.data.wikis[to] = rest;
    if (this.data.current === from) this.data.current = to;
    this.save();
    return this.get(to);
  }

  describe(name: string, description: string | undefined): WikiEntry {
    const e = this.data.wikis[this.get(name).name]!;
    if (description) e.description = description;
    else delete e.description;
    this.save();
    return this.get(name);
  }

  /** Makes `name` the wiki used when a command names none. */
  use(name: string): WikiEntry {
    const e = this.get(name);
    this.data.current = name;
    this.save();
    return e;
  }

  clearCurrent(): void {
    delete this.data.current;
    this.save();
  }
}
