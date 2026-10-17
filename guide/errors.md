# Exit codes and errors

| Exit | Meaning | What to do |
|---|---|---|
| 0 | success | — |
| 1 | operational error (bad input, file not found, wiki not initialised, refused oversize source, lint found errors, `wikis current` with nothing selected) | read the stderr message; fix input |
| 2 | configuration error: a required setting is missing or invalid, unknown wiki name, no wiki selected | set the named setting or pass `--wiki`; never invent values |
| 3 | LLM provider error (auth, quota, model not found, unusable reply) | check credentials/model with `llm-wiki config`; retry later for rate limits |

Errors are printed as `error: <message>` on stderr. `--verbose` adds a stack trace for unexpected errors.

Common messages:

| Message starts with | Cause | Fix |
|---|---|---|
| `No wiki selected.` | no `--wiki`, no `--root`, no current selection | pass `--wiki <name>` (names are listed in the message) |
| `No wiki named "x" is registered.` | typo or unregistered | `llm-wiki wikis list`; or `wikis add x <dir>` |
| `Missing required configuration setting X` | setting not configured | set X in `~/.tool-agents/llm-wiki/.env` or the shell |
| `... is not an initialised wiki` | wrong directory | `llm-wiki init <dir>` or correct the path |
| `Pass either --root or --wiki, not both.` | conflicting flags | keep one |
| `... above the --max-source-chars limit` | source too large | split the source, or raise the limit deliberately |
| `... is not a supported source` / `not a supported document type` | e.g. `.doc`, `.ppt`, `.xls`, `.heic`, `.key` | the message names the fix: save as .docx/.pptx/.xlsx, or convert to PNG/JPEG |
| `... cannot read images` | the parser provider has no vision | use a parser model with vision |
| `... is not a readable Office file` | password-protected, corrupt, or an old binary format renamed | save it again as .docx/.pptx/.xlsx |
| `The model reply did not contain the expected JSON` | the chat model returned malformed JSON twice (the tool already retried once) | run the ingest again; for very large sources raise `--max-tokens` |
| `No embeddings are stored yet.` | vector/hybrid search before embedding | `index --embed`, or use `--mode bm25` |
| `--pick needs an interactive terminal` | agent used `--pick` | use `--wiki <name>` |
