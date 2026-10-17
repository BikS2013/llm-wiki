# MCP server

`llm-wiki mcp` serves **all registered wikis** over MCP stdio. Register it once with Claude Code:

```bash
claude mcp add llm-wiki -- llm-wiki mcp
# or pin a default wiki for calls that name none:
claude mcp add llm-wiki -- llm-wiki --wiki work mcp
```

Every tool takes an optional `wiki` argument (a registered name). Calls without it use the server's
default wiki (resolved at start-up like any command); with no default they fail and list the names.
The registry is re-read on each call.

| Tool | Arguments | Does |
|---|---|---|
| `wiki_list_wikis` | — | registered wikis with description, page count, pending sources, last activity |
| `wiki_search` | `query`, `mode?` (bm25/vector/hybrid), `limit?`, `layer?` (wiki/raw/all), `wiki?` or `wikis?` (list, `["*"]` = all) | ranked chunk hits labelled by wiki |
| `wiki_read_page` | `page` (id, or `index` / `log`), `wiki?` | the page as frontmatter + body (markdown, or an HTML fragment in HTML wikis); the index as markdown |
| `wiki_list_pages` | `type?`, `wiki?` | page ids, types, titles, summaries |
| `wiki_write_page` | `path`, `op` (create/replace/append), `content`, `reason?`, `sources?`, `wiki?` | writes a page (`content` = frontmatter + body; in HTML wikis the body is an HTML fragment or markdown, `[[wikilinks]]` allowed), then regenerates index and search index |
| `wiki_append_log` | `kind` (ingest/query/lint/edit/note), `title`, `body?`, `wiki?` | appends to log.md / log.html |
| `wiki_recent_log` | `last?`, `wiki?` | recent log entries |
| `wiki_lint` | `wiki?` | structural health report |
| `wiki_reindex` | `includeRaw?`, `wiki?` | regenerate the index and search index (HTML: converts leftover `[[wikilinks]]`) |

The MCP tools never call an LLM themselves: the client agent does the thinking. LLM-driven operations
(`ingest`, `query`, `parse`, `lint --llm`) are CLI-only.
