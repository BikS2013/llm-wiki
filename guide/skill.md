# Building a Claude skill for llm-wiki

This topic is addressed to an agent that is asked to write a skill (for example
`~/.claude/skills/llm-wiki/SKILL.md`) that lets Claude operate the tool. Generate the skill from
`llm-wiki guide` (full text) or `llm-wiki guide --json` (structured), so it matches the installed version.

## Suggested frontmatter

```yaml
---
name: llm-wiki
description: Use the llm-wiki CLI to manage the user's personal LLM-maintained wikis (markdown or HTML) — add documents
  (markdown, PDF, DOCX) to a wiki, answer questions from a wiki with citations, search one or all wikis,
  list/create/select wikis, and run health checks. Use when the user says "add this to my wiki", "ingest",
  "what does my wiki say about…", "search my notes/wikis", "which wikis do I have", "create a new wiki",
  "lint the wiki", or mentions llm-wiki.
---
```

## Sections the skill should contain

1. **Preconditions** — `llm-wiki --version` works; `llm-wiki config` shows the settings for the
   operation (chat provider/model for ingest/query; parser provider/model for PDF/DOCX; embedding
   settings for vector/hybrid search).
2. **Choosing the wiki** — the procedure from the `selection` topic: `wikis list --json`, match on
   name/description, ask when ambiguous, then always pass `--wiki <name>`.
3. **Task recipes** — one short recipe per intent, from the `workflows` topic:
   add document(s), preview an ingest, convert only, ask a question, keep the answer, search one / all
   wikis, enable semantic search, maintain/lint, register an existing wiki, create a new wiki.
4. **Reading results** — the JSON shapes from the `output` topic; read hit files via the wiki `root`.
5. **Errors** — the exit-code table from the `errors` topic and the fix for each common message.
6. **Guardrails** — the `agent-rules` topic verbatim or close to it.
7. **MCP alternative** — when the `llm-wiki` MCP server is connected, prefer its tools for search/read
   and the CLI for ingest/query (see the `mcp` topic).
8. **Self-refresh** — tell the skill to run `llm-wiki guide <topic>` when unsure, since the guide is
   generated from the installed CLI.

## Decision table to include

| User intent | Command |
|---|---|
| "add/ingest this file into my X wiki" | `llm-wiki --wiki X ingest <file> --json` |
| "what would change if I added…" | `llm-wiki --wiki X ingest <file> --dry-run --json` |
| "what does my wiki say about …" | `llm-wiki --wiki X query "<q>" --json` |
| "what do my wikis say about …" / question spanning subjects | `llm-wiki query "<q>" --wikis X,Y --json` (or `--all-wikis`); cite as `[[wiki:page]]` |
| "save that answer in the wiki" | `llm-wiki --wiki X query "<q>" --file --json` |
| "find/where are my notes on …" (wiki known) | `llm-wiki --wiki X search "<terms>" --json` |
| "search all my wikis for …" | `llm-wiki search "<terms>" --all-wikis --json` |
| "which wikis do I have?" | `llm-wiki wikis list --json` |
| "turn my <name> wiki into HTML / make it browsable" | `llm-wiki --wiki <name> convert --to html --dry-run --json`, show the result, then without `--dry-run` |
| "create a wiki for …" | `llm-wiki init <dir> --format markdown\|html --name <n> --description "<d>"` (ask which format if the user did not say: html to read in a browser, markdown for editors/Obsidian) |
| "make X my default wiki" | `llm-wiki wikis use X` |
| "check / clean up the wiki" | `llm-wiki --wiki X lint --json` (`--llm` for semantic) |
| "what happened recently in X" | `llm-wiki --wiki X log --last 10 --json` |

## Quality checklist for the generated skill

- Every command example passes `--wiki` (except `wikis`, `init`, and multi-wiki `search`).
- Every command an agent parses uses `--json`.
- No API keys, no hard-coded wiki roots, no invented configuration values.
- LLM-calling commands are flagged as costing time/money; `search` is preferred for lookups.
- The skill never edits `raw/`, `wiki/index.md` or `.llm-wiki/` directly.
