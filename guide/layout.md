# Wiki layout and page format

A wiki root (created by `llm-wiki init <dir> --format markdown|html`) contains three layers plus tool state.
`<ext>` is `.md` in a markdown wiki and `.html` in an HTML wiki:

```
<root>/
  raw/            immutable source documents (md, txt, csv, json, html, rst, org, pdf, docx)
  raw/assets/     images and attachments belonging to sources
  wiki/           the compiled knowledge base, owned by the tool
    index<ext>    generated catalog of every page (never hand-edit; run `llm-wiki index`)
    log<ext>      append-only activity log: `[YYYY-MM-DD] kind | title` entries
    overview<ext> optional top-level synthesis
    wiki.css      HTML wikis only: the stylesheet every page links (edit freely)
    sources/      one summary page per ingested raw source
    entities/     people, organisations, products, places, projects, tools
    concepts/     ideas, methods, themes
    syntheses/    filed answers (`query --file`), comparisons, analyses
    lint/         dated health-check reports (`lint --report`)
  .llm-wiki/      tool state: wiki.json (the page format), search index, embeddings, ingest ledger (do not edit)
  CLAUDE.md       the wiki's schema/contract for agents (AGENTS.md is a copy)
```

## Page ids and paths

A page id is its path under `wiki/` without the extension, e.g. `entities/ada-lovelace`. Commands accept ids
with or without `.md`/`.html`. Command output and JSON use root-relative paths in the wiki's format, such as
`wiki/entities/ada-lovelace.md` or `wiki/entities/ada-lovelace.html`, and `raw/report.pdf`.

## Page formats

Each wiki has one page format, chosen at `init` with `--format markdown` or `--format html` (or
`LLM_WIKI_FORMAT`) and recorded in `.llm-wiki/wiki.json`. A markdown wiki can later be converted to HTML with
`llm-wiki convert --to html` (see the workflows); HTML → markdown is not available. Wikis created
before 0.3 have no `wiki.json` and are markdown. `llm-wiki wikis list` shows each wiki's format.

| | markdown | html |
|---|---|---|
| Page file | `wiki/<id>.md` | `wiki/<id>.html`, a standalone page that opens in a browser |
| Metadata | YAML frontmatter | JSON in `<script type="application/json" id="llm-wiki-meta">` in `<head>` |
| Body | markdown | HTML inside `<main>` |
| Links | `[[ada-lovelace]]`, `[[entities/ada-lovelace\|Ada]]` | relative `<a href="../entities/ada-lovelace.html">` |
| Best for | Obsidian, editors, agents reading files | reading and sharing in a browser |

Whatever the format, pages are **written** in the same two-part form — YAML frontmatter followed by the
body — by `ingest`, `query --file`, MCP `wiki_write_page`, and MCP `wiki_read_page` returns them that way.
In an HTML wiki the body may be an HTML fragment or markdown; the tool renders markdown to HTML, turns
`[[wikilinks]]` (also `[[raw/report.pdf]]`) into relative links, removes scripts, iframes and event handlers,
and wraps the result in the page shell (metadata block, stylesheet, Index/Log navigation, a
Content-Security-Policy that disables scripts). The LLM always sees the index in markdown form.

### Markdown page

```markdown
---
title: Exact Page Title
type: entity            # overview | entity | concept | source | synthesis | lint | other
summary: One sentence, used verbatim in index.md.
tags: [tag-one, tag-two]
created: 2026-01-31
updated: 2026-02-14
sources: [raw/article.md, raw/paper.pdf.md]
aliases: [Alt Name]
---

# Exact Page Title

Body text with wikilinks such as [[ada-lovelace]] or [[entities/ada-lovelace|Ada]].
```

### HTML page (as stored)

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; ...">
<title>Exact Page Title</title>
<link rel="stylesheet" href="../wiki.css">
<script type="application/json" id="llm-wiki-meta">
{ "title": "Exact Page Title", "type": "entity", "summary": "…", "tags": ["tag-one"],
  "created": "2026-01-31", "updated": "2026-02-14", "sources": ["raw/article.md"] }
</script>
</head>
<body>
<nav class="wiki-nav"><a href="../index.html">Index</a><a href="../log.html">Log</a></nav>
<main>
<h1>Exact Page Title</h1>
<p>Body text linking <a class="wikilink" href="../entities/ada-lovelace.html">Ada</a>.</p>
</main>
</body>
</html>
```

Hand edits to an HTML page change only the JSON block and the content of `<main>`. `[[wikilinks]]` typed
by hand are converted by `llm-wiki index` (and `lint --fix`, MCP `wiki_reindex`); until then `lint`
reports them as `unconverted-wikilink`. A `.md` file inside an HTML wiki (or `.html` in a markdown wiki) is
ignored and reported as `foreign-format-file`.

File names are lowercase kebab-case slugs of the title.

## Document and image originals (PDF, DOCX, PPTX, XLSX, images)

`ingest` or `parse` of `raw/report.pdf` writes `raw/report.pdf.md` (`raw/x.pptx` → `raw/x.pptx.md`,
`raw/photo.jpg` → `raw/photo.jpg.md`, …), which is then ingested like any markdown source. The markdown's
frontmatter records `original: raw/report.pdf`, `original_type`, the original's sha256, `parsed_by` (the
parser provider/model, or `llm-wiki/xlsx-reader`) and the date; the body starts with a link to the original.

| Original | How it is converted | Model needed |
|---|---|---|
| `.pdf` | sent to the parser model as a PDF (anthropic, gemini, openai, azure-openai, litellm); ollama/mlx get text extracted with pdf.js | parser |
| `.docx` | converted to HTML locally (mammoth), then to markdown by the parser model | parser |
| `.pptx` | slides read locally — titles, text in reading order, tables, chart data, picture alt text, speaker notes — and sent with the slides' pictures; the parser model writes one `## Slide N — title` section per slide and transcribes/describes each picture | parser (with vision for pictures) |
| `.xlsx` | converted **locally, no LLM**: one markdown table per sheet, cell values exactly as stored (formulas as their last calculated value, or as the formula when the file holds none; dates as ISO dates; percentages with `%`) | none |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` | sent to the parser model as an image: all visible text transcribed, charts given as data tables, diagrams and photos described | parser with vision |

Refused with a hint: `.doc` `.ppt` `.xls` (save as the `x` format), `.key` `.numbers` `.pages` (export),
`.heic` `.tif` `.bmp` `.svg` (convert to PNG/JPEG). Images in `raw/assets/` are attachments of other sources
and are never converted on their own.

PPTX limits: pictures below 4 KB (icons) are skipped; a picture used on several slides is sent once; at most
`--max-images` (default 40) pictures are sent, pictures over 5 MB and EMF/WMF/TIFF/SVG pictures are not —
everything not sent is listed in the conversion's provenance note ("Not converted: …"). SmartArt and
drawn shapes without text are not rendered. Image originals over 20 MB are refused.


The original is never modified. Conversions are cached by hash: unchanged originals are not re-parsed
unless `--force` (parse) or `--reparse` (ingest) is given.

Files outside `raw/` passed to `ingest`/`parse` are copied into `raw/` first. Paths may be given relative to
the current directory or relative to the wiki root (`raw/x.md`).
