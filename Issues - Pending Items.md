# Issues - Pending Items

## Dependency vetting log

All runtime and dev dependencies were checked against the GitHub Advisory Database (`gh api advisories?ecosystem=npm&affects=<pkg>@<version>`) and `pnpm audit --audit-level=high` reported no known vulnerabilities after install.

| Package | Pinned | Advisories at pin | Vetted on |
|---|---|---|---|
| commander | ^15.0.0 | 0 | 2026-09-12 |
| @anthropic-ai/sdk | ^0.125.0 | 0 | 2026-09-12 |
| @anthropic-ai/foundry-sdk | ^0.4.6 | 0 | 2026-09-12 |
| openai | ^7.15.0 | 0 | 2026-09-12 |
| @google/genai | ^2.22.0 | 0 | 2026-09-12 |
| @modelcontextprotocol/sdk | ^1.30.0 | 0 | 2026-09-12 |
| zod | ^4.6.2 | 0 | 2026-09-12 |
| typescript (dev) | ^7.0.2 | 0 | 2026-09-12 |
| tsx (dev) | ^4.23.13 | 0 | 2026-09-12 |
| @types/node (dev) | ^22.20.2 | 0 | 2026-09-12 |
| mammoth | ^1.12.3 | 0 | 2026-09-12 |
| pdfjs-dist | ^6.3.289 | 0 | 2026-09-12 (chosen over `unpdf`, which pins pdfjs-dist 5.x and pulls a native canvas binary) |
| marked | ^18.1.1 | 0 (latest, no dependencies, MIT) | 2026-10-17 — renders markdown bodies to HTML in HTML-format wikis |

Overrides are listed below with their removal condition. `pnpm.onlyBuiltDependencies` allows only `esbuild` (needed by `tsx`) to run its postinstall script.

- 2026-10-16 — `@modelcontextprotocol/sdk` ^1.32.1 (from ^1.30.0): fixes the HIGH advisory "OAuth client could send credentials to an authorization server" (<1.31.0).
- 2026-10-16 — pnpm overrides `proxy-addr` ^2.0.8 (CRITICAL IP spoofing, <2.0.8), `fast-uri` ^3.1.8 and `ip-address` ^10.7.4 (moderate), all pulled in by `@modelcontextprotocol/sdk` → express / ajv / express-rate-limit. Remove each override once the SDK's dependency tree resolves to these versions on its own (check `pnpm why <pkg>`).
- 2026-10-16 — accepted: `sprintf-js` <=1.1.3 (moderate DoS, no patched release) via `mammoth` → `argparse`. argparse is only used by mammoth's own CLI, which llm-wiki never runs. Revisit when a fixed sprintf-js or an argparse-free mammoth ships.

## Pending items

- PDF / DOCX parsing relies on the parser LLM's faithfulness; review `raw/<doc>.pdf.md` for long or table-heavy documents. Other binary formats (PPTX, XLSX, images) are still refused.
- Semantic lint sends every page to the model within `--context-chars`; very large wikis may need a sampling strategy.
- Embedding calls are sequential batches of 32; add concurrency if a large corpus makes `index --embed` slow.
- Wikis created before the registry existed (v0.1) are not registered automatically; register them once with `llm-wiki wikis add <name> <dir>`.
- Only markdown → HTML conversion exists (`llm-wiki convert --to html`). HTML → markdown needs an HTML-to-markdown converter (a new dependency to vet); until then the way back is the backup in `.llm-wiki/backup/markdown-<timestamp>/`.
- `convert` writes the HTML pages, then switches `wiki.json`, then moves the markdown files. A crash between those steps leaves both formats on disk; `lint` reports the leftovers as `foreign-format-file`, and the backup folder plus the remaining files are enough to finish or undo by hand.
- HTML sanitising of LLM-written page bodies is regex-based and best-effort; the real barrier against injected scripts is the per-page Content-Security-Policy (`script-src 'none'`). Pages opened from a host that strips `<meta http-equiv>` CSP would rely on the sanitiser alone.
- `[[wikilinks]]` to a page that does not exist yet are written in HTML pages as `<a class="wikilink wikilink-missing">` pointing at the guessed path; they are reported by lint as dangling until the page is created, but are not re-pointed automatically if the page later appears under another folder.
- `wikis.json` is written atomically (temp file + rename), but two processes editing the registry at the same instant can still lose one change; there is no file lock.

## Completed items

- 2026-10-17 — Cross-wiki question answering: `llm-wiki query "<q>" --wikis a,b` / `--all-wikis` (`queryWikis` in `src/ops/query.ts`). Problem: `query` could only answer from one wiki, so a question spanning subjects kept in different wikis needed several queries and manual merging. Solution: each wiki is searched on its own index and the rankings are fused with RRF (as `search --wikis` already did); the top pages from all wikis share one page/character budget and are given to the model tagged with their wiki; the model cites `[[<wiki>:<page-id>]]`; every wiki consulted gets a `query` log entry; `--file` is refused because a cross-wiki answer has no single home. Verified live with gemini-3.6-flash across an HTML and a markdown wiki.
