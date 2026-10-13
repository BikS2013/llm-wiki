const STOPWORDS = new Set(
  'a an and are as at be but by for from has have he her his how i if in into is it its of on or she so than that the their them then there these they this to was we were what when where which who why will with you your not no yes can could would should do does did done been being am'.split(' '),
);

/** Very light stemmer: strips common English suffixes so `indexing`/`indexed`/`indexes` collide. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  for (const [suffix, min] of [
    ['ingly', 5], ['ations', 5], ['ation', 5], ['ness', 5], ['ments', 5], ['ment', 5],
    ['ies', 4], ['ing', 4], ['ers', 4], ['ies', 4], ['ed', 4], ['er', 4], ['ly', 4], ['es', 4], ['s', 4],
  ] as const) {
    if (word.endsWith(suffix) && word.length > min) {
      let base = word.slice(0, -suffix.length);
      if (suffix === 'ies') return `${base}y`;
      // Porter step 1b: "programm" → "program", "stopp" → "stop" (keep l, s, z doubles).
      if ((suffix === 'ed' || suffix === 'ing' || suffix === 'er' || suffix === 'ers') && /([b-df-hj-km-np-rtvwxy])\1$/.test(base)) base = base.slice(0, -1);
      return base;
    }
  }
  return word;
}

/** Lowercases, splits on non-alphanumerics (unicode aware), drops stopwords, stems. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '' || raw.length > 40) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}
