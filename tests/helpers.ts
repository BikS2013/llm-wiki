import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWiki } from '../src/ops/init.js';
import { WikiPaths, writePage } from '../src/wiki/layout.js';
import { withFrontmatter } from '../src/wiki/markdown.js';
import type { WikiFormat } from '../src/wiki/format.js';
import type { ChatClient, ChatRequest, EmbeddingClient } from '../src/llm/types.js';

export function tempWiki(format: WikiFormat = 'markdown'): WikiPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-test-'));
  initWiki(dir, { format });
  return new WikiPaths(dir);
}

export function addPage(paths: WikiPaths, id: string, title: string, body: string, fm: Record<string, string | string[]> = {}): void {
  writePage(paths, id, withFrontmatter({ title, summary: `${title} summary`, updated: '2026-01-01', ...fm }, `# ${title}\n\n${body}\n`));
}

export class FakeChat implements ChatClient {
  readonly provider = 'fake';
  readonly model = 'fake-model';
  readonly requests: ChatRequest[] = [];
  constructor(private readonly replies: Array<string | ((req: ChatRequest) => string)>) {}
  async chat(req: ChatRequest): Promise<string> {
    this.requests.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('FakeChat has no reply left');
    return typeof next === 'function' ? next(req) : next;
  }
}

/** Deterministic "embeddings": bag-of-letters vectors, good enough to test plumbing. */
export class FakeEmbed implements EmbeddingClient {
  readonly provider = 'fake';
  readonly model = 'fake-embed';
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Array<number>(26).fill(0);
      for (const ch of t.toLowerCase()) {
        const i = ch.charCodeAt(0) - 97;
        if (i >= 0 && i < 26) v[i]!++;
      }
      return v;
    });
  }
}
