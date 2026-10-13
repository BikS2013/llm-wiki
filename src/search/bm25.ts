import { tokenize } from './tokenize.js';

export interface Bm25Doc {
  id: string;
  text: string;
  /** Multiplicative boost (e.g. titles). */
  boost?: number;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

/** In-memory Okapi BM25 over a fixed document set. Cheap to rebuild at wiki scale. */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly docLen = new Map<string, number>();
  private readonly boosts = new Map<string, number>();
  private readonly postings = new Map<string, Map<string, number>>();
  private avgLen = 0;
  private n = 0;

  constructor(docs: Bm25Doc[], opts: { k1?: number; b?: number } = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    let total = 0;
    for (const doc of docs) {
      const toks = tokenize(doc.text);
      this.docLen.set(doc.id, toks.length);
      this.boosts.set(doc.id, doc.boost ?? 1);
      total += toks.length;
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, count] of tf) {
        let p = this.postings.get(term);
        if (!p) this.postings.set(term, (p = new Map()));
        p.set(doc.id, count);
      }
    }
    this.n = docs.length;
    this.avgLen = this.n === 0 ? 0 : total / this.n;
  }

  get size(): number {
    return this.n;
  }

  search(query: string, limit = 10): Bm25Hit[] {
    const terms = Array.from(new Set(tokenize(query)));
    const scores = new Map<string, number>();
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (const [id, tf] of posting) {
        const len = this.docLen.get(id) ?? 0;
        const denom = tf + this.k1 * (1 - this.b + (this.b * len) / (this.avgLen || 1));
        const s = idf * ((tf * (this.k1 + 1)) / denom);
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    return Array.from(scores, ([id, score]) => ({ id, score: score * (this.boosts.get(id) ?? 1) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
