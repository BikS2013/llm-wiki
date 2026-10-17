# Rules for agents using llm-wiki

1. **Name the wiki on every call** with `--wiki <name>`. Decide with `wikis list --json`; ask the user
   when two wikis fit equally well. Never rely on the interactive prompt or `--pick`.
2. **Use `--json`** and parse stdout only; stderr is progress and diagnostics.
3. **Search before you query.** `search` is local and free; `query` calls the LLM. For "find/where is"
   requests use `search` and read the files; use `query` for questions needing synthesis.
4. **Preview expensive writes.** For large or many sources, run `ingest --dry-run --json` first and show
   the proposed pages when the user should approve them.
5. **Never touch `raw/` contents** except by adding new files through `ingest`/`parse`. Never delete or
   edit sources; never hand-edit the index (`wiki/index.md` / `wiki/index.html`) or anything in `.llm-wiki/`.
6. **Hand edits to pages** (if the user asks) must keep the metadata — the frontmatter of a markdown page,
   the `llm-wiki-meta` JSON block and the `<main>` element of an HTML page — and must be followed by
   `llm-wiki --wiki <name> index`. Prefer MCP `wiki_write_page`, which builds HTML pages for you. Check a
   wiki's format (`wikis list --json` → `format`) before writing a page file yourself.
7. **Do not create, rename, remove, re-select or convert wikis** (`init`, `wikis add|rename|remove|use|unset`,
   `convert`) unless the user asked for it; these change the user's setup. Before `convert`, run it with
   `--dry-run --json` and report `unresolvedLinks` and the `schema` outcome.
8. **Configuration errors (exit 2) are for the user to fix.** Report the named setting; never write
   guessed values into `.env` files and never print API keys.
9. **Cite.** When relaying a `query` answer keep its citations; mention the wiki it came from.
10. **File valuable answers** with `query --file` only when the user wants the answer kept in the wiki.
