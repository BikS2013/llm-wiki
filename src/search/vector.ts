export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface VectorHit {
  id: string;
  score: number;
}

export function vectorSearch(query: number[], vectors: Map<string, number[]>, limit = 10): VectorHit[] {
  const hits: VectorHit[] = [];
  for (const [id, v] of vectors) hits.push({ id, score: cosine(query, v) });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Reciprocal-rank fusion of several ranked lists (ids only). */
export function rrf(rankings: string[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return Array.from(scores, ([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
