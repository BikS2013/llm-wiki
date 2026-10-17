# Choosing the wiki (registry and selection rules)

## The registry

Named wikis are stored in `~/.tool-agents/llm-wiki/wikis.json` (mode 0600):
name, absolute root, optional description, registration date, and the *current* selection.
The registry holds no content. Removing an entry never deletes files.

Names: lowercase letters, digits, `.`, `_`, `-`; up to 64 characters; starting with a letter or digit.

## How a command picks its wiki (first match wins, nothing is guessed)

1. `--wiki <name>` / `LLM_WIKI_NAME`, or `--root <dir>` / `LLM_WIKI_ROOT`.
   Passing both `--wiki` and `--root` is an error. If a name and a root are set from different
   configuration tiers the higher tier wins; from the same tier is an error.
2. The current selection, set with `llm-wiki wikis use <name>`.
3. On an interactive terminal only: a numbered prompt (also forced by `--pick`).
4. Otherwise: configuration error (exit 2) listing the registered wikis.

Every wiki-bound command prints `wiki: <name> — <root>` on **stderr**, and most JSON outputs include a
`"wiki"` field (not `lint` and `log`; a multi-wiki `query` has `"wikis"`), so the choice can always be verified.

## Rules for agents

- Agents run without a TTY: the prompt never appears and `--pick` fails. **Always pass `--wiki <name>`**
  rather than relying on the current selection, which the user may change at any time.
- To decide *which* wiki to update or query, run `llm-wiki wikis list --json` and match the user's intent
  against each wiki's `name` and `description` (and `pages`, `lastActivity`). If two wikis are equally
  plausible, ask the user. Never create a new wiki unless asked.
- To look for information when the right wiki is unclear, search them all first:
  `llm-wiki search "<terms>" --all-wikis --json`, then query the wiki whose hits are best — or, when the
  answer needs several of them, `llm-wiki query "<q>" --wikis a,b --json`.
- Only `search` and `query` (with `--wikis` / `--all-wikis`) span several wikis. `ingest`, `parse`, `index`,
  `lint`, `log`, `convert` and `query --file` work on one.
- `llm-wiki wikis current` shows which wiki would be used and why (exit 1 when none).

## Registry commands at a glance

```bash
llm-wiki init ~/wikis/work --format markdown --name work --description "Work documentation"   # create + register
llm-wiki wikis add old ~/old-wiki --description "Archive"                    # register an existing wiki
llm-wiki wikis list --json
llm-wiki wikis use work            # default for commands that name no wiki
llm-wiki wikis unset               # no default: every command must name its wiki
llm-wiki wikis show work --json
llm-wiki wikis rename old archive
llm-wiki wikis describe archive "Pre-2025 project notes"
llm-wiki wikis remove archive      # unregister only
```
