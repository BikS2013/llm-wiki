import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WikiFormat } from '../wiki/format.js';

const MARKDOWN_PAGE_FORMAT = `Every wiki page is markdown with YAML frontmatter:
---
title: Exact Page Title
type: entity            # overview | entity | concept | source | synthesis
summary: One sentence used verbatim in index.md.
tags: [tag-one, tag-two]
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [raw/article.md]
aliases: [Alt Name]
---
# Exact Page Title
...body...

Rules: file ids are lowercase kebab-case slugs under sources/, entities/, concepts/, syntheses/ (or overview). Link other pages with [[slug]] wikilinks (or [[folder/slug|Alias]] when ambiguous) and link generously. Cite the raw source for every non-obvious claim. Flag contradictions with a "> **Contradiction:**" callout naming both sources instead of silently overwriting. Keep pages atomic — one entity or concept per page — and prefer updating an existing page over creating a near-duplicate.`;

const HTML_PAGE_FORMAT = `Every wiki page is a standalone HTML page that the tool builds from two parts you write: YAML frontmatter (the page metadata) followed by the page body as an HTML fragment:
---
title: Exact Page Title
type: entity            # overview | entity | concept | source | synthesis
summary: One sentence used verbatim in the index.
tags: [tag-one, tag-two]
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [raw/article.md]
aliases: [Alt Name]
---
<h1>Exact Page Title</h1>
<p>...body...</p>

Body rules: use semantic HTML only — h1–h4, p, ul/ol/li, table/thead/tbody/tr/th/td, blockquote, strong, em, code, pre, a, figure, img. No <html>, <head>, <body>, <main>, <script>, <style>, <iframe>, event-handler attributes or inline styles: the tool wraps the fragment in the page shell (metadata block, stylesheet, navigation). Existing pages are shown to you in this same two-part form.

Rules: file ids are lowercase kebab-case slugs under sources/, entities/, concepts/, syntheses/ (or overview). Link other wiki pages with [[slug]] wikilinks (or [[folder/slug|Alias]] when ambiguous) written inside the HTML, e.g. <p>Designed by [[ada-lovelace|Ada Lovelace]].</p> — the tool turns them into relative <a href> links. Relative <a href="...html"> links already present in an existing page are correct; keep them. Link raw files the same way, e.g. [[raw/report.pdf]]. External links are ordinary <a href="https://...">. Link generously. Cite the raw source for every non-obvious claim. Flag contradictions with <blockquote><p><strong>Contradiction:</strong> ...</p></blockquote> naming both sources instead of silently overwriting. Keep pages atomic — one entity or concept per page — and prefer updating an existing page over creating a near-duplicate.`;

/** How pages are written, as told to the model, for the wiki's format. */
export function pageFormatPrompt(format: WikiFormat): string {
  return format === 'html' ? HTML_PAGE_FORMAT : MARKDOWN_PAGE_FORMAT;
}

const SCHEMA_PARTS: Record<WikiFormat, Record<string, string>> = {
  markdown: {
    FORMAT_NAME: 'markdown',
    EXT: '.md',
    PAD: '      ',
    PAD_OV: '   ',
    EXTRA_LAYOUT: '',
    PAGE_FORMAT: `Every page is markdown with YAML frontmatter:

\`\`\`markdown
---
title: Exact Page Title
type: entity            # overview | entity | concept | source | synthesis | lint
summary: One sentence used verbatim in index.md.
tags: [tag-one, tag-two]
created: 2026-01-31
updated: 2026-02-14
sources: [raw/article.md, raw/paper.md]   # raw files this page draws on
aliases: [Alt Name]
---

# Exact Page Title

Body...
\`\`\``,
    LINK_CONVENTION: '- Link pages with wikilinks: `[[ada-lovelace]]` (basename) or `[[entities/ada-lovelace|Ada]]` when a basename is ambiguous. Link generously — the links are the product.',
    CONTRADICTION: '`> **Contradiction:**`',
    INDEX_EXTRA: '',
  },
  html: {
    FORMAT_NAME: 'HTML',
    EXT: '.html',
    PAD: '    ',
    PAD_OV: ' ',
    EXTRA_LAYOUT: '\n  wiki.css      the stylesheet every page links (edit freely; created when missing)',
    PAGE_FORMAT: `Every page is a standalone HTML document that opens directly in a browser. The page shell is fixed:
the metadata sits in a JSON block in \`<head>\`, the content inside \`<main>\`:

\`\`\`html
<!doctype html>
<html lang="en">
<head>
  ... charset, Content-Security-Policy (scripts disabled), <title>, <link rel="stylesheet" href="../wiki.css"> ...
  <script type="application/json" id="llm-wiki-meta">
  { "title": "Exact Page Title", "type": "entity", "summary": "One sentence used verbatim in the index.",
    "tags": ["tag-one"], "created": "2026-01-31", "updated": "2026-02-14",
    "sources": ["raw/article.md"], "aliases": ["Alt Name"] }
  </script>
</head>
<body>
<nav class="wiki-nav"><a href="../index.html">Index</a><a href="../log.html">Log</a></nav>
<main>
<h1>Exact Page Title</h1>
<p>Body...</p>
</main>
</body>
</html>
\`\`\`

Write pages through the tool whenever you can — \`wiki_write_page\` over MCP, or \`llm-wiki ingest\` / \`query --file\`.
They take the page as YAML frontmatter (same keys as the JSON block) followed by the body as an HTML fragment
(or markdown), and build the shell, the metadata block and the links for you. When you edit a file by hand,
change only the JSON block and what is inside \`<main>\`, use semantic HTML (no scripts, no inline styles), and
run \`llm-wiki index\` afterwards.`,
    LINK_CONVENTION: '- Link pages with relative links: `<a href="../entities/ada-lovelace.html">Ada</a>`. You may also write `[[ada-lovelace]]` or `[[entities/ada-lovelace|Ada]]` inside the HTML: the tool, and `llm-wiki index` for hand-edited files, turns them into relative `<a href>` links. Link generously — the links are the product.',
    CONTRADICTION: '`<blockquote><p><strong>Contradiction:</strong> …</p></blockquote>`',
    INDEX_EXTRA: '; converts leftover `[[wikilinks]]` in hand-edited pages',
  },
};

/** Loads the schema (CLAUDE.md) template shipped with the package, filled in for the wiki's format. */
export function schemaTemplate(format: WikiFormat): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '..', '..', 'templates', 'CLAUDE.md'), path.join(here, '..', 'templates', 'CLAUDE.md')]) {
    if (fs.existsSync(candidate)) {
      const parts = SCHEMA_PARTS[format];
      return fs.readFileSync(candidate, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => parts[key] ?? m);
    }
  }
  throw new Error('templates/CLAUDE.md is missing from the llm-wiki installation.');
}

export function ingestSystemPrompt(schema: string, format: WikiFormat): string {
  return `You are the disciplined maintainer of a personal LLM wiki. The wiki's schema follows; obey it exactly.

<schema>
${schema}
</schema>

${pageFormatPrompt(format)}

You will receive: the current index, the full text of existing pages that look related, and one new raw source. Your job is to compile the source into the wiki:
1. Write a summary page under sources/ — faithful, specific, with key claims, numbers, and notable quotes, plus a "Sources" line pointing at the raw file.
2. Create or update the entity and concept pages the source touches (typically 5–15). Reuse existing pages when the index or related pages show one exists; otherwise create a new page. When updating, return the COMPLETE new content of the page (op "replace"), or use op "append" to add a section to the end. Preserve existing information unless the source supersedes it; when it contradicts, add a Contradiction callout.
3. Cross-link: the summary page must link to every page it touches, and each touched page must link back to the summary page.
4. Update the overview page if the big picture changed (optional).

Respond with ONLY a JSON object (no prose, no code fences) of this shape:
{
  "title": "Human-readable title of the source",
  "takeaways": ["3-7 one-line key takeaways"],
  "summary_page": { "path": "sources/<slug>", "content": "<frontmatter + full ${format === 'html' ? 'HTML body' : 'markdown body'}>" },
  "pages": [ { "op": "create" | "replace" | "append", "path": "entities/<slug>", "content": "<frontmatter + ${format === 'html' ? 'HTML body' : 'markdown body'}>", "reason": "<why>" } ],
  "log_entry": "one or two sentences describing what was integrated"
}
Paths are relative to wiki/ without a file extension. Every "create"/"replace" content must start with complete frontmatter; "append" content is only the body to add. Escape the JSON correctly.`;
}

export function querySystemPrompt(schema: string): string {
  return `You answer questions strictly from a personal LLM wiki. The wiki's schema follows for context.

<schema>
${schema}
</schema>

You will receive the index, the search hits, and the full text of the most relevant pages. Answer in well-structured markdown. Every factual statement must cite the page it comes from using a wikilink like [[slug]] (use [[folder/slug]] when the basename is ambiguous). If the wiki lacks the information, say exactly what is missing and which sources would fill the gap; do not invent facts. When helpful, use tables or bullet lists. Finish with a "Sources" section listing the pages you relied on.`;
}

export function crossQuerySystemPrompt(): string {
  return `You answer questions strictly from several personal LLM wikis at once. Each wiki is a separate knowledge base on its own subject; the <wikis> block names and describes them.

You will receive search hits and the full text of the most relevant pages; each page carries the wiki it belongs to. Answer in well-structured markdown. Every factual statement must cite its page as [[<wiki>:<page-id>]], e.g. [[work:entities/deploy-pipeline]] — always with the wiki name, because the same page id can exist in several wikis. When wikis disagree or cover different periods, say so and attribute each side. If the wikis lack the information, say exactly what is missing and which sources would fill the gap; do not invent facts. Finish with a "Sources" section listing the pages you relied on, grouped by wiki.`;
}

export function lintSystemPrompt(schema: string): string {
  return `You are auditing the health of a personal LLM wiki. The wiki's schema follows.

<schema>
${schema}
</schema>

You will receive the index and the content of wiki pages. Look for: contradictions between pages; stale claims that newer sources supersede; important entities or concepts mentioned repeatedly but lacking their own page; missing cross-references between pages that clearly relate; data gaps a web search or a new source could fill; and good next questions to investigate.

Respond with ONLY a JSON object (no prose, no code fences):
{
  "contradictions": [ { "pages": ["slug-a", "slug-b"], "description": "..." } ],
  "stale_claims": [ { "page": "slug", "claim": "...", "superseded_by": "slug-or-source" } ],
  "missing_pages": [ { "name": "...", "mentioned_in": ["slug"], "why": "..." } ],
  "missing_links": [ { "from": "slug", "to": "slug", "why": "..." } ],
  "data_gaps": [ "..." ],
  "suggested_questions": [ "..." ],
  "suggested_sources": [ "..." ]
}
Use empty arrays when there is nothing to report. Reference pages by their id (e.g. entities/ada-lovelace).`;
}

export function parseSystemPrompt(): string {
  return `You convert documents into clean, faithful markdown for a personal knowledge wiki. Preserve the document's structure and all of its content: headings (as #/##/###), paragraphs, bullet and numbered lists, tables (as markdown tables), emphasis, block quotes, footnotes, and code. Keep every number, date, name and figure exactly as written; never summarise, paraphrase, reorder or omit content. Transcribe figures, charts and images as a short bracketed description of what they show, e.g. [Figure 2: bar chart of revenue by quarter, Q3 highest]. Drop page headers/footers, page numbers and repeated boilerplate. Do not add commentary or a preamble. Output markdown only.`;
}

export function parseInstruction(filename: string, mimeType: string): string {
  return `Convert the attached document "${filename}" (${mimeType}) into markdown following the rules. Start with a level-1 heading holding the document's title. Reply with the markdown only.`;
}
