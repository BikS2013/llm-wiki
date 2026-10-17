<structure-and-conventions>
## Structure & Conventions — Documentation Map

<!-- Maintained automatically. The master copy lives at
     ~/.claude/structure-and-conventions.md (claude-workdocs repo) and the SessionStart
     hook ~/.claude/scripts/sync-claude-md.sh keeps this copy of the block up to date —
     edit the master, never this block. The block is committed with the repository on
     purpose: it tells anyone (human or agent) working with this repo where the
     project's documentation lives and how to read and maintain it. -->

### Where the documentation lives

- `docs/plans/` — every plan, one file per plan, named `plan-NNN-<indicative-description>.md`.
- `docs/design/` — all other planning and design documents:
  - `project-design.md` — the complete, always-current project design; update it with every new design or design change.
  - `project-functions.md` — the registry of all functional requirements and feature descriptions.
  - `configuration-guide.md` — the project's configuration guide, when one exists (structure below).
- `docs/reference/` — all reference material collected for the project.
- `docs/refined_requests/` — every refined request specification (create the folder if missing), one file per request named `refined-request-NNN-<slug>.md`. `NNN` is a zero-padded three-digit sequential number: the next number is the highest `NNN` already present in the folder plus one, starting at `001` — and when the category has an archive history branch, the archive's numbering counts too (see "Archiving historical documents" below). `<slug>` is the request slug reused by all downstream artifacts of the same request.
- `docs/prompts/` — every prompt created while working on the project (create the folder if missing), one file per prompt named `NNN-<indicative-description>.md`. `NNN` is a zero-padded three-digit sequential number: the next number is the highest `NNN` already present in the folder plus one, starting at `001` — and when the category has an archive history branch, the archive's numbering counts too (see "Archiving historical documents" below). The description states the prompt's use and purpose.
- `docs/tools/<tool-name>.md` — one dedicated documentation file per project tool.
- `test_scripts/` — every test script goes here; create the folder if it doesn't exist.
- `Issues - Pending Items.md` (project root) — the register of every issue, pending item, inconsistency, or discrepancy detected while working on the project. Pending items come first (most critical and important on top), completed items after. Whenever a defect or issue is fixed, check this file for an item to remove.

### How to use the documentation

- Every time an issue is solved, it must be resolved AND both the issue and the solution must be thoroughly documented.
- This file's "Tools" section (when present) lists each project tool with a one-or-two-sentence description of what it is capable of and the relative path to its dedicated documentation file under `docs/tools/` — retrieve the full documentation from there whenever it is needed. Full tool documentation must never be inlined into this file.
- Before writing any code script, consult the "Tools" section and the documentation under `docs/tools/` to check whether the planned code fits the scope of an existing tool. If so, implement it as an extension of that tool; otherwise build a generic, abstract version of the code as a new tool in the project's toolset, document it under `docs/tools/`, and reference it in the "Tools" section. The goal is to progressively grow the tools needed to test, evaluate, generate data, collect information, etc., and reuse them consistently.

### Archiving historical documents (history branches)

- A project MAY move accumulated historical, write-once process artifacts — deployment reports, codebase scans, refined requests, plans, session handoffs, and similar — off the default branch to keep its documentation lean. Living, authoritative documents (`project-design.md`, `project-functions.md`, the guides, tool docs, the issue register) are never archived.
- Each archived category gets a dedicated **orphan, docs-only branch** named `<category>-history`, whose tree contains ONLY that category's files at their original repository paths — so retrieval paths never change: `git show <category>-history:<original-path>`, no branch switching required. A pointer note/README stays in the category's folder on the default branch stating the branch name, the retrieval command, and (for numbered categories) the next number. Archive branches are append-only: never rebase, rewrite, delete, or merge them.
- **Numbering across the archive**: for every `NNN`-numbered folder, the next number is `max(highest NNN in the folder, highest NNN on the category's archive branch) + 1`. Before creating the FIRST document of a numbered category, check whether an archive branch exists for it (the folder's README/pointer note, or `git branch --list --all '*-history'`) and continue from the archive's highest number — never restart at `001`, never reuse an archived number. The archive branch is authoritative over the pointer note's recorded "next number" if they disagree.
- **Migration** runs in a temporary linked worktree so the main checkout — and any uncommitted changes in it — is never disturbed: `git worktree add <tmp> <category>-history` (first-time archiving: `git worktree add --detach <tmp> <default-branch>`, then inside it `git switch --orphan <category>-history` and `git checkout <default-branch> -- <category-paths>`); bring the new artifacts over at their original paths and commit ONLY the category's files; then on the default branch `git rm` the migrated files, update the pointer note, and commit referencing the archive commit. Verify with `git ls-tree -r <category>-history --name-only` and a `git show` spot-check.
- The project's concrete category → branch registry (which categories are archived, under which branch names) is project-specific and lives OUTSIDE this synced block — typically a "Document Archiving Strategy" section in the project's CLAUDE.md.

<configuration-guide>
- A configuration guide, when requested, is created at `docs/design/configuration-guide.md` and explains:
  - When multiple configuration options exist (config file, env variables, CLI params, etc.), what the options are and the priority of each one.
  - The purpose and use of each configuration variable.
  - How the user can obtain such a configuration variable.
  - The recommended approach for storing or managing the variable.
  - Which options exist for the variable and what each option means for the project.
  - Any default value the parameter has.
  - For configuration parameters that expire (e.g., PAT keys, tokens), propose adding a parameter that captures the expiration date, so the app or service can proactively warn users to renew.
</configuration-guide>

</structure-and-conventions>

# wiki-v2 — llm-wiki

TypeScript implementation of Andrej Karpathy's **LLM Wiki** pattern (gist `karpathy/442a6bf555914893e9891c11519de94f`, April 2026): an LLM-maintained, interlinked wiki (markdown or HTML pages, chosen per wiki) compiled from immutable raw sources, with local search, ingest, query, lint, and an MCP server.

## Project layout

- `src/cli.ts` — commander entry point (`llm-wiki`).
- `src/config/` — four-tier configuration resolution (shell env → `~/.tool-agents/llm-wiki/.env` → `./.env` → CLI flags), no fallback values.
- `src/wiki/` — layout (`raw/`, `wiki/`, `.llm-wiki/`), `format.ts` (the markdown and HTML page formats), markdown/frontmatter/wikilink parsing, index generation, the log, structural lint, and `registry.ts` (named wikis in `~/.tool-agents/llm-wiki/wikis.json`).
- `src/search/` — tokenizer, BM25, embeddings cache, incremental chunk index, hybrid (RRF) search.
- `src/llm/` — provider factory for the eight standard providers (OpenAI, Anthropic, Gemini, Azure OpenAI, Azure Anthropic/Foundry, Ollama, LiteLLM, MLX).
- `src/ops/` — `init`, `ingest`, `query`, semantic `lint`, page-change application, `parse` (PDF/DOCX/PPTX/images → markdown via the dedicated parser LLM, XLSX locally; `extract.ts` routes file types and runs pdf.js/mammoth, `office.ts` reads PPTX/XLSX packages with jszip), `convert`.
- `src/mcp/` — MCP stdio server exposing `wiki_*` tools.
- `templates/CLAUDE.md` — the schema written into every new wiki root.
- `guide/*.md` + `src/guide.ts` — the `llm-wiki guide` manual for people and agents; the `commands` topic is generated from the commander tree, the other topics are the markdown files. Update them whenever a command, option, JSON shape or rule changes.
- `skills/llm-wiki/SKILL.md` — the Claude skill for operating the CLI (installed as a symlink by `pnpm skill:install`); `llm-wiki-docs/` holds its development notes. Update the skill together with the guide.
- `tests/` — `node:test` suites run with `pnpm test`.

## Commands

```
pnpm build        # tsc → dist/
pnpm dev -- ...   # run from source via tsx
pnpm test         # node --test via tsx
pnpm audit        # pnpm audit --audit-level=high
pnpm link:global  # build and install the `llm-wiki` OS command (pnpm unlink:global removes it)
```

## Rules specific to this project

- Never write defaults for configuration settings; use `Config.require()` which throws `ConfigError`.
- Sources under `raw/` of a wiki are immutable; the tool only reads them. The one thing it writes into `raw/` is the markdown conversion of a PDF/DOCX/PPTX/XLSX/image original (`raw/<doc>.<ext>.md`), never touching the original.
- A command works on exactly one wiki, chosen by `--wiki`/`LLM_WIKI_NAME` or `--root`/`LLM_WIKI_ROOT`, then the registry's current selection, then an interactive prompt; never guessed (`resolveWiki` in `src/config/settings.ts`). Only `search` / `query` with `--wikis`/`--all-wikis` (and MCP `wiki_search`) span several wikis; nothing writes to several wikis except the cross-wiki query log entries.
- The index (`wiki/index.md` / `wiki/index.html`) is generated from page metadata — never hand-edit it; change the metadata and run `llm-wiki index`.
- A wiki's page format (`markdown` | `html`) is chosen at `init` (`--format` / `LLM_WIKI_FORMAT`, no default), recorded in `.llm-wiki/wiki.json`; the only change allowed is `convert --to html` (`src/ops/convert.ts`), which backs up the markdown files. Code above `src/wiki/format.ts` works on frontmatter + body and must not assume `.md`: use `paths.format`, `paths.pageRel(id)`, `paths.index` / `paths.log`, `readPageParts` / `writePageParts`.

## Tools

- **llm-wiki** — Karpathy-style LLM wiki: compiles raw sources into interlinked markdown or HTML wikis (several, kept in a named registry) and indexes/searches them locally (BM25, vector, hybrid, across wikis), with ingest, query, lint and an MCP server. See `docs/tools/llm-wiki.md`.
