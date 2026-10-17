# Output conventions and JSON shapes

- **stdout** carries the result; **stderr** carries progress, the `wiki: <name> — <root>` line, notes and
  errors. Parse stdout only.
- Every command an agent needs has `--json`. With `--json`, stdout is exactly one JSON document.
- Paths are root-relative (`wiki/...`, `raw/...`). Combine with the wiki's `root` to read files.

## `wikis list --json`
```json
[{ "name": "work", "root": "/abs/path", "description": "Work docs", "healthy": true, "format": "markdown",
   "pages": 42, "pending": 1, "lastActivity": "2026-10-16 ingest | Q3 plan", "current": true }]
```
Unhealthy entries have `"healthy": false` and `"problem": "<reason>"` instead of counts.

## `wikis show [name] --json`
Same fields as one list row plus `"registered": "YYYY-MM-DD"`.

## `search --json`
```json
[{ "wiki": "work", "file": "wiki/concepts/deploy.md", "layer": "wiki", "title": "Deploy pipeline",
   "heading": "Rollback", "score": 0.29, "snippet": "…" }]
```
Scores are comparable within one call only. With several wikis, scores are rank-fusion values.

## `query --json` (one wiki; see below for several)
```json
{ "wiki": "work", "question": "…", "answer": "markdown with citations",
  "pagesUsed": ["wiki/concepts/deploy.md"], "filedAs": "wiki/syntheses/….md" }   // .html in HTML wikis
```
`filedAs` is null unless `--file`.

With `--wikis a,b` / `--all-wikis` (more than one usable wiki):
```json
{ "wikis": ["ai-committee", "research"], "question": "…", "answer": "markdown citing [[wiki:page-id]]",
  "pagesUsed": ["ai-committee:wiki/entities/sofia.html", "research:wiki/concepts/rag.md"] }
```

## `ingest --json`
```json
{ "wiki": "work", "dryRun": false, "results": [
  { "source": "raw/report.pdf.md", "original": "raw/report.pdf", "skipped": false,
    "title": "Q3 report", "takeaways": ["…"],
    "changes": [{ "op": "create", "page": "wiki/sources/q3-report.md", "reason": "…" }] } ] }
```
`op` is `create`, `replace` or `append`. With `--dry-run` the changes are proposals; nothing is written.
`skipped: true` means the source was unchanged since its last ingest.

## `parse --json`
```json
{ "wiki": "work", "results": [{ "original": "raw/x.pdf", "markdown": "raw/x.pdf.md", "skipped": false }] }
```

## `convert --to html --json`
```json
{ "wiki": "notes", "from": "markdown", "to": "html", "dryRun": false,
  "pages": ["wiki/entities/ada-lovelace.html"], "logEntries": 84,
  "unresolvedLinks": [{ "page": "entities/ada-lovelace", "target": "ghost-page" }],
  "schema": "merged", "schemaSectionsReplaced": ["Layout (three layers)", "Page format", "Operations", "Tools"],
  "backup": ".llm-wiki/backup/markdown-20261017-051719" }
```
`schema` is `rewritten` (stock schema replaced), `merged` or `kept` (`--keep-schema`); `backup` is null on a dry run.

## `index --json`
```json
{ "wiki": "work", "format": "html", "indexChanged": true, "linkedPages": ["wiki/concepts/x.html"],
  "search": { "chunks": 310, "added": 2, "updated": 1, "unchanged": 40, "removed": 0 },
  "embeddings": { "computed": 12, "stored": 310, "provider": "openai", "model": "text-embedding-3-small" } }
```
`embeddings` is null without `--embed`. `linkedPages` lists HTML pages whose hand-typed `[[wikilinks]]` were converted (always empty in markdown wikis).

## `lint --json`
```json
{ "structural": { "pages": 42, "findings": [{ "severity": "warning", "code": "orphan-page",
                   "page": "entities/foo", "message": "…" }] },
  "semantic": null }
```
Codes: dangling-link, orphan-page, missing-frontmatter, missing-summary, missing-type, empty-page,
basename-collision, index-stale, raw-not-ingested, original-not-parsed, no-outbound-links.
With `--llm`, `semantic` has `contradictions`, `stale_claims`, `missing_pages`, `missing_links`,
`data_gaps`, `suggested_questions`, `suggested_sources`.

## `log --json`
```json
[{ "date": "2026-10-16", "kind": "ingest", "title": "Q3 report", "body": "…" }]
```

## `guide --json`
The guide topics plus a machine-readable tree of every command, argument and option.
