# llm-wiki skill — development notes

Material for the Claude skill that operates the `llm-wiki` CLI. Only skill-related documents live here.

## What and where

| Item | Location |
|---|---|
| Skill source (versioned with the tool) | `skills/llm-wiki/SKILL.md` |
| Installed skill (user level, every project) | `~/.claude/skills/llm-wiki` → symlink to `skills/llm-wiki/` in this repo |
| Source material | `llm-wiki guide` (topics in `guide/*.md`; `commands` is generated from the CLI) |

Install / remove:

```bash
pnpm skill:install     # ln -s <repo>/skills/llm-wiki ~/.claude/skills/llm-wiki (refuses to overwrite a non-symlink)
pnpm skill:uninstall   # removes the symlink only
```

## Design

- **Generated from the guide.** The skill follows the plan in `llm-wiki guide skill`: preconditions,
  choosing the wiki, recipes (decision table), reading results, errors, guardrails, MCP alternative,
  self-refresh. It stays short (~150 lines) and defers detail to `llm-wiki guide <topic>`, which is
  generated from the installed CLI and therefore never stale — the skill explicitly says the guide wins.
- **Symlink, not a copy.** The installed skill is a symlink into the repo, like the user's other
  third-party skills, so `git pull` + `pnpm build` keeps the CLI and the skill in step.
- **Agent safety.** Every example passes `--wiki` and `--json`; LLM-calling commands are marked with their
  cost; the guardrails mirror `guide/agent-rules.md`; no settings, keys or wiki roots are hard-coded.
- **Format awareness.** The skill knows wikis are markdown or HTML (`format` in `wikis list --json`), asks
  for the format on `init`, and treats `convert --to html` as a user-only decision with a dry run first.

## Maintenance checklist (run when the CLI changes)

1. Update `guide/*.md` (the source of truth) for new commands, options, JSON shapes or rules.
2. Update `skills/llm-wiki/SKILL.md`: the decision table (§3), JSON shapes (§4), guardrails (§6).
3. Check against the quality list in `llm-wiki guide skill`: `--wiki` on every wiki-bound example,
   `--json` everywhere output is parsed, no keys/roots/invented values, LLM cost flagged, no direct edits of
   `raw/`, the index or `.llm-wiki/`.
4. `tests/guide.test.ts` checks that the guide covers every command; extend it if the skill gains new claims.

## History

- 2026-10-17 — first version (llm-wiki 0.3.0): multi-wiki registry, markdown/HTML formats, `convert`,
  cross-wiki `query --wikis`.
- 2026-10-17 — revised after an independent review (plugin-dev skill-reviewer): corrected the output-shape
  claims (cross-wiki search keeps `file` root-relative with a separate `wiki` field; not every JSON has
  `wiki`; `root` added to the `wikis list` fields; DOCX converts to `.docx.md`), lint's exit 1 with valid JSON,
  the full convert procedure, semantic-search and parse follow-up recipes, common error messages, extra
  guardrails (`init --force`, size limits, `--force`/`--reparse`, the log), the full MCP tool list, and a
  third-person description with more trigger phrases. The guide's `selection` topic was corrected too.
