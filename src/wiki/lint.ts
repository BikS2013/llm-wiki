import fs from 'node:fs';
import path from 'node:path';
import { LinkResolver, listPages, listRawFiles, type Page, type WikiPaths } from './layout.js';
import { indexIsStale } from './index.js';
import { IngestLedger, ParseLedger } from '../ops/ledger.js';
import { isParsableDocument } from '../ops/extract.js';
import { markdownPathFor } from '../ops/parse.js';

export type Severity = 'error' | 'warning' | 'info';

export interface LintFinding {
  severity: Severity;
  code:
    | 'dangling-link'
    | 'orphan-page'
    | 'missing-frontmatter'
    | 'missing-summary'
    | 'missing-type'
    | 'empty-page'
    | 'basename-collision'
    | 'index-stale'
    | 'raw-not-ingested'
    | 'original-not-parsed'
    | 'no-outbound-links';
  page?: string;
  message: string;
}

export interface LintReport {
  pages: number;
  findings: LintFinding[];
}

/** Deterministic, LLM-free health check of the wiki's structure. */
export function lintStructure(paths: WikiPaths): LintReport {
  const pages = listPages(paths);
  const resolver = new LinkResolver(pages);
  const findings: LintFinding[] = [];
  const inbound = new Map<string, number>(pages.map((p) => [p.id, 0]));

  for (const p of pages) {
    if (Object.keys(p.frontmatter).length === 0) findings.push({ severity: 'warning', code: 'missing-frontmatter', page: p.id, message: `${p.id} has no frontmatter (title/summary/type/updated).` });
    else {
      if (typeof p.frontmatter.summary !== 'string' || p.frontmatter.summary.trim() === '') findings.push({ severity: 'info', code: 'missing-summary', page: p.id, message: `${p.id} has no \`summary:\` in frontmatter; the index will fall back to the first paragraph.` });
      if (typeof p.frontmatter.type !== 'string') findings.push({ severity: 'info', code: 'missing-type', page: p.id, message: `${p.id} has no \`type:\` in frontmatter; inferred "${p.type}" from its folder.` });
    }
    if (p.body.trim().replace(/^#.*$/m, '').trim() === '') findings.push({ severity: 'warning', code: 'empty-page', page: p.id, message: `${p.id} has no content beyond its heading.` });
    let outbound = 0;
    for (const link of p.links) {
      const target = resolver.resolve(link.target, p.id);
      if (!target) {
        findings.push({ severity: 'error', code: 'dangling-link', page: p.id, message: `${p.id} links to [[${link.target}]] which does not exist.` });
        continue;
      }
      if (target.id !== p.id) {
        inbound.set(target.id, (inbound.get(target.id) ?? 0) + 1);
        outbound++;
      }
    }
    if (outbound === 0 && p.type !== 'lint') findings.push({ severity: 'info', code: 'no-outbound-links', page: p.id, message: `${p.id} links to no other page.` });
  }
  for (const p of pages) {
    if ((inbound.get(p.id) ?? 0) === 0 && p.type !== 'overview' && p.type !== 'lint') {
      findings.push({ severity: 'warning', code: 'orphan-page', page: p.id, message: `${p.id} has no inbound links from other pages (the index does not count).` });
    }
  }
  const byBase = new Map<string, Page[]>();
  for (const p of pages) {
    const b = path.posix.basename(p.id).toLowerCase();
    byBase.set(b, [...(byBase.get(b) ?? []), p]);
  }
  for (const [base, group] of byBase) {
    if (group.length > 1) findings.push({ severity: 'warning', code: 'basename-collision', message: `Several pages share the basename "${base}": ${group.map((g) => g.id).join(', ')}. Short [[${base}]] links are ambiguous; use the full id.` });
  }
  if (indexIsStale(paths, pages)) findings.push({ severity: 'warning', code: 'index-stale', message: 'wiki/index.md is out of date. Run `llm-wiki index` (or `llm-wiki lint --fix`).' });

  const ledger = new IngestLedger(paths);
  const parsed = new ParseLedger(paths);
  for (const abs of listRawFiles(paths)) {
    const rel = paths.relToRoot(abs);
    if (rel.startsWith('raw/assets/')) continue;
    if (isParsableDocument(abs)) {
      if (!parsed.isCurrent(rel, fs.readFileSync(abs)) || !fs.existsSync(path.join(paths.root, markdownPathFor(rel)))) {
        findings.push({ severity: 'info', code: 'original-not-parsed', message: `${rel} is a PDF/DOCX original without an up-to-date markdown conversion. Run \`llm-wiki ingest ${rel}\` (or \`llm-wiki parse ${rel}\`).` });
      }
      continue;
    }
    if (!ledger.isIngested(rel, fs.readFileSync(abs))) findings.push({ severity: 'info', code: 'raw-not-ingested', message: `${rel} is in raw/ but has not been ingested (or changed since). Run \`llm-wiki ingest ${rel}\`.` });
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.message.localeCompare(b.message));
  return { pages: pages.length, findings };
}

export function formatLintReport(report: LintReport): string {
  if (report.findings.length === 0) return `Checked ${report.pages} page(s): no structural findings.`;
  const lines = [`Checked ${report.pages} page(s): ${report.findings.length} finding(s).`, ''];
  for (const sev of ['error', 'warning', 'info'] as Severity[]) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`${sev.toUpperCase()} (${group.length})`);
    for (const f of group) lines.push(`  [${f.code}] ${f.message}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
