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

No overrides are in place. `pnpm.onlyBuiltDependencies` allows only `esbuild` (needed by `tsx`) to run its postinstall script.

## Pending items

- PDF / DOCX parsing relies on the parser LLM's faithfulness; review `raw/<doc>.pdf.md` for long or table-heavy documents. Other binary formats (PPTX, XLSX, images) are still refused.
- Semantic lint sends every page to the model within `--context-chars`; very large wikis may need a sampling strategy.
- Embedding calls are sequential batches of 32; add concurrency if a large corpus makes `index --embed` slow.
