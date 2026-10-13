# llm-wiki

A TypeScript implementation of Andrej Karpathy's **LLM Wiki** pattern — the idea file he published as a gist in April 2026 ([karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)). Instead of RAG that re-derives answers from raw documents on every question, an LLM **incrementally compiles** your sources into a persistent, interlinked markdown wiki that keeps getting richer. This tool gives you the three layers, the two special files, the operations, and the "optional CLI tools" the gist describes, aimed at indexing and searching personal documentation.

## User guide (slides)

A 24-slide walkthrough of setup, the daily loop, PDF/DOCX handling and agent integration, in the BikS2013 theme:

- **[View the deck](https://biks2013.github.io/llm-wiki/presentations/llm-wiki-user-guide.html)** (HTML, arrow keys to navigate; double-click text to edit, right-click for the menu)
- [PDF](https://biks2013.github.io/llm-wiki/presentations/llm-wiki-user-guide.pdf) · [PowerPoint](https://github.com/BikS2013/llm-wiki/raw/main/docs/presentations/llm-wiki-user-guide.pptx)

## What it implements from the spec

| Spec element | Implementation |
|---|---|
| Raw sources (immutable) | `raw/` — the tool only ever reads it; external files are copied in on ingest |
| The wiki (LLM-owned markdown) | `wiki/` with `sources/`, `entities/`, `concepts/`, `syntheses/`, `lint/`, optional `overview.md` |
| The schema | `CLAUDE.md` + `AGENTS.md` written into the wiki root from `templates/CLAUDE.md` |
| `index.md` (content catalog) | Generated deterministically from page frontmatter by `llm-wiki index` |
| `log.md` (chronological, grep-able) | Append-only `## [YYYY-MM-DD] kind \| title` entries; `llm-wiki log --last 5` |
| Ingest | `llm-wiki ingest raw/file.md` — LLM writes the summary page and updates 5–15 entity/concept pages, then index + log + ledger are updated |
| Query | `llm-wiki query "…"` — search → read pages → cited answer; `--file` files it as a synthesis page |
| Lint | `llm-wiki lint` (dangling links, orphans, stale index, un-ingested sources) and `--llm` (contradictions, stale claims, missing pages/links, gaps, next questions) |
| Search tool (CLI + MCP) | Local BM25, vector, and hybrid (RRF) search over heading-level chunks; `llm-wiki mcp` exposes `wiki_search`, `wiki_read_page`, `wiki_write_page`, … |
| PDF / DOCX sources | A dedicated parser LLM converts originals to `raw/<doc>.pdf.md` / `raw/<doc>.docx.md`; the original stays untouched in `raw/` and is referenced from the conversion and the wiki's source page |

## Install

```bash
pnpm install
pnpm build
npm link            # optional: puts `llm-wiki` on your PATH
```

Requires Node 22+.

## Configure

Settings resolve in four tiers, lowest to highest priority: shell env → `~/.tool-agents/llm-wiki/.env` → `./.env` → CLI flags. Missing settings raise an error; nothing is defaulted.

```bash
# ~/.tool-agents/llm-wiki/.env
LLM_WIKI_ROOT=/Users/you/notes-wiki
LLM_WIKI_PROVIDER=anthropic          # openai | anthropic | gemini | azure-openai | azure-anthropic | ollama | litellm | mlx
LLM_WIKI_MODEL=claude-opus-5
ANTHROPIC_API_KEY=...

# optional — enables vector / hybrid search
LLM_WIKI_EMBEDDING_PROVIDER=openai
LLM_WIKI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=...

# optional — dedicated model for converting PDF / DOCX originals to markdown
LLM_WIKI_PARSER_PROVIDER=gemini      # anthropic, gemini, openai, azure-openai, litellm read PDFs natively; ollama/mlx get locally extracted text
LLM_WIKI_PARSER_MODEL=gemini-3.6-pro
```

Provider credentials use the vendor's canonical names: `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_ORG_ID`, `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`), `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_DEPLOYMENT`/`AZURE_OPENAI_API_VERSION`, `AZURE_AI_INFERENCE_KEY`/`AZURE_AI_INFERENCE_ENDPOINT`, `OLLAMA_HOST`, `LITELLM_PROXY_URL`/`LITELLM_MASTER_KEY`; MLX-LM reuses `OPENAI_BASE_URL`. `llm-wiki config` shows what resolved and from where.

## Use

```bash
llm-wiki init ~/notes-wiki                 # creates raw/, wiki/, CLAUDE.md, index.md, log.md
export LLM_WIKI_ROOT=~/notes-wiki

cp ~/Downloads/some-article.md ~/notes-wiki/raw/
llm-wiki ingest raw/some-article.md        # or just `llm-wiki ingest` for every pending source
llm-wiki ingest raw/x.md --dry-run         # see the proposed page changes first

llm-wiki ingest raw/report.pdf             # converts with the parser LLM to raw/report.pdf.md, then ingests it
llm-wiki parse raw/contract.docx           # convert only, review raw/contract.docx.md before ingesting

llm-wiki search "postgres docker"          # BM25, no LLM needed
llm-wiki index --embed                     # compute embeddings, then:
llm-wiki search "how do I run the db" --mode hybrid

llm-wiki query "What did I decide about the deployment pipeline?" --file
llm-wiki lint --llm --report
llm-wiki log --last 5
```

Open the wiki root in Obsidian to browse it (graph view shows hubs and orphans), exactly as the gist suggests.

### With Claude Code / Codex

The wiki root's `CLAUDE.md` is the schema: open the root in Claude Code and it becomes the wiki maintainer. Give it the search tool natively:

```bash
claude mcp add llm-wiki -- node /path/to/wiki-v2/dist/cli.js --root ~/notes-wiki mcp
```

Tools exposed: `wiki_search`, `wiki_read_page`, `wiki_list_pages`, `wiki_write_page`, `wiki_append_log`, `wiki_recent_log`, `wiki_lint`, `wiki_reindex`.

## PDF and DOCX originals

`ingest` (or `parse`) sends a PDF/DOCX to the parser LLM configured by `LLM_WIKI_PARSER_PROVIDER` / `LLM_WIKI_PARSER_MODEL`, separate from the chat model, and writes the faithful markdown conversion next to the original as `raw/<name>.pdf.md` or `raw/<name>.docx.md`. Providers with native document input (Anthropic, Azure Anthropic/Foundry, Gemini, OpenAI, Azure OpenAI, LiteLLM) receive the PDF itself, which also handles scanned pages; Ollama and MLX receive text extracted locally with pdf.js. DOCX is always converted to HTML locally with mammoth first, then turned into markdown by the model.

The conversion's frontmatter records provenance and the body opens with a link to the original:

```markdown
---
title: Quarterly Report
original: raw/report.pdf
original_type: PDF
original_sha256: 3f2a…
parsed_by: gemini/gemini-3.6-pro
parsed_at: 2026-09-12
---
> **Converted from the original PDF document [[raw/report.pdf]]** (412 KB, sha256 3f2a…) by gemini/gemini-3.6-pro on 2026-09-12. The original is kept unmodified in `raw/`.
```

The wiki's `sources/` page also carries `original: raw/report.pdf` and links it. Conversions are cached by the original's hash in `.llm-wiki/parsed.json`; `--reparse` (or `parse --force`) redoes them.

## Page format

```markdown
---
title: Ada Lovelace
type: entity            # overview | entity | concept | source | synthesis | lint
summary: One sentence shown in index.md.
tags: [mathematics]
created: 2026-04-02
updated: 2026-04-09
sources: [raw/some-article.md]
---
# Ada Lovelace

Links use wikilinks: [[analytical-engine]] or [[concepts/analytical-engine|the Engine]].
```

## Develop

```bash
pnpm dev -- search "term" --root ./example
pnpm test
pnpm typecheck
```
