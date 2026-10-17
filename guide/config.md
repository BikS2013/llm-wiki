# Configuration

Settings resolve in four tiers, lowest to highest priority:
**shell environment → `~/.tool-agents/llm-wiki/.env` → `./.env` (current directory) → CLI flags.**
There are no defaults: a setting that a command needs but cannot find raises a configuration error
(exit 2) naming the setting and where to set it. `llm-wiki config` shows what resolved and from where
(secrets masked).

## Tool settings

| Setting | Flag | Needed by | Meaning |
|---|---|---|---|
| `LLM_WIKI_NAME` | `--wiki` | wiki-bound commands (optional) | registered wiki to use |
| `LLM_WIKI_ROOT` | `--root` | wiki-bound commands (optional) | wiki directory to use (alternative to a name) |
| `LLM_WIKI_BROWSER` | — | `ingest`/`parse` of a URL whose page needs JavaScript, `--render`, `sources check` of such pages | absolute path of a Chromium-family browser executable (Chrome, Chromium, Edge, Brave) used headless to render and print pages to PDF |
| `LLM_WIKI_FORMAT` | `init --format` | init of a new wiki | page format of the new wiki: `markdown` or `html`; recorded in `.llm-wiki/wiki.json`, ignored afterwards |
| `LLM_WIKI_PROVIDER` | `--provider` | ingest, query, lint --llm | chat provider |
| `LLM_WIKI_MODEL` | `--model` | ingest, query, lint --llm | chat model (Azure OpenAI uses `AZURE_OPENAI_DEPLOYMENT`) |
| `LLM_WIKI_EMBEDDING_PROVIDER` | — | index --embed, search --mode vector/hybrid | embedding provider (not anthropic/azure-anthropic) |
| `LLM_WIKI_EMBEDDING_MODEL` | — | same | embedding model or Azure deployment |
| `LLM_WIKI_PARSER_PROVIDER` | — | parse, ingest of .pdf/.docx | dedicated document-parsing provider |
| `LLM_WIKI_PARSER_MODEL` | — | same | parser model or Azure deployment |

Providers: `openai`, `anthropic`, `gemini`, `azure-openai`, `azure-anthropic`, `ollama`, `litellm`, `mlx`.

## Provider credentials (vendor-canonical names)

| Provider | Variables |
|---|---|
| openai | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_ORG_ID` |
| anthropic | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` |
| gemini | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) |
| azure-openai | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| azure-anthropic | `AZURE_AI_INFERENCE_KEY`, `AZURE_AI_INFERENCE_ENDPOINT` |
| ollama | `OLLAMA_HOST` |
| litellm | `LITELLM_PROXY_URL`, `LITELLM_MASTER_KEY` |
| mlx | `OPENAI_BASE_URL` (OpenAI-compatible server) |

PDF handling: anthropic, azure-anthropic, gemini, openai, azure-openai and litellm parser providers read
PDFs natively (scanned pages included); ollama and mlx receive text extracted locally. DOCX is always
converted to HTML locally first.

## Overriding per command

```bash
llm-wiki --wiki work --provider anthropic --model claude-opus-5 query "..."
```

Agents must never print, echo or write API keys. Use `llm-wiki config` (masked) to check presence.
