# Overview

`llm-wiki` is a command-line tool that implements Andrej Karpathy's **LLM Wiki** pattern: instead of
re-reading a pile of documents every time a question is asked (classic RAG), an LLM *compiles* the
documents once into a persistent, interlinked wiki — markdown or HTML pages, chosen per wiki — keeps it up to date as new documents arrive,
and answers questions from the compiled pages.

A user typically keeps **several wikis** (for example `work`, `personal`, `research`), each in its own
directory, all known to the tool through a **registry** of names. Every command works on exactly one wiki,
except `search`, which can span several.

What the tool does:

| Capability | Command | Needs an LLM? |
|---|---|---|
| Create and register a wiki | `init`, `wikis add` | no |
| Choose / list / describe wikis | `wikis ...` | no |
| Add a document to a wiki (compile it into pages) | `ingest` | yes (chat model; parser model for PDF, DOCX, PPTX and images) |
| Convert a PDF, DOCX, PPTX, XLSX or image to markdown only | `parse` | parser model (none for XLSX) |
| Answer a question from a wiki (or several: `--wikis`, `--all-wikis`), with citations | `query` | yes (chat model) |
| Find pages by keyword or meaning | `search` | bm25: no; vector/hybrid: embedding model |
| Rebuild the catalog and search index | `index` | only with `--embed` |
| Health-check a wiki | `lint` | only with `--llm` |
| Read the activity log | `log` | no |
| Show resolved configuration | `config` | no |
| Serve wikis to an MCP client | `mcp` | depends on the tool called |
| Print this guide | `guide` | no |

Key ideas an agent must keep in mind:

1. **Pick the wiki explicitly.** Always pass `--wiki <name>`; list the candidates with
   `llm-wiki wikis list --json` and choose by name and description.
2. **`raw/` is immutable.** Source documents are never edited or deleted. The tool only adds the markdown
   conversion of a PDF, DOCX, PPTX, XLSX or image next to its original.
3. **`wiki/` is owned by the tool/LLM.** The index (`wiki/index.md` or `wiki/index.html`) is generated; never hand-edit it.
4. **LLM commands cost money and time.** `ingest`, `query`, `parse`, `lint --llm`, `index --embed` call a
   model. Prefer `search` (free, local) to locate information, and `ingest --dry-run` to preview.
5. **Nothing is defaulted.** A missing setting raises a configuration error (exit code 2) that names the
   setting. Fix the configuration; do not guess values.
