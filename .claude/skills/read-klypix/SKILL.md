---
name: read-klypix
description: Read and understand a .klypix (or legacy .any) canvas file — its cards/notes, the connection + [[wikilink]] graph, #tags, and embedded images/files. Use whenever the user references, drops, or asks about a .klypix/.any file, or wants you to act on a KLYPIX canvas (summarize it, build from it, answer questions about it, find what's missing).
---

# Reading a `.klypix` file

A `.klypix` (and the legacy `.any`) is KLYPIX's canvas format: **one file that
holds a whole spatial workspace** — text cards, images, embedded files (PDFs,
docs, code), drawings, the connections/arrows between cards, `[[wikilinks]]`,
and `#tags`. It's a ZIP container. Treat it as a portable, multi-modal brief
the user (or another agent) authored for you.

## How to read one

Run the bundled reader, which unzips the file and emits structured markdown
(cards + their text, the connection graph, links, tags, and an asset list):

```bash
node scripts/read-klypix.mjs "<path/to/file.klypix>"
```

If the canvas has **images or embedded files** and you need to actually see
them, extract the assets and then open the relevant ones with vision:

```bash
node scripts/read-klypix.mjs "<path/to/file.klypix>" --assets ./klypix-assets
```

Then `Read` the extracted image files in `./klypix-assets/` (the reader lists
their names under "Assets"). For machine processing, add `--json` to get a
structured object instead of markdown.

> The reader needs `jszip`. Inside a KLYPIX checkout it's already installed
> (`node_modules`). Elsewhere: `npm i jszip` in the working dir first. If the
> script path differs, the reader lives at `scripts/read-klypix.mjs` in the
> KLYPIX repo — copy it next to the file if needed.

## How to interpret the output

- **Cards** — each card's title (first line) + text. `file`/`image` cards show
  a name and appear under Assets; open those with vision when relevant.
- **Connection graph** — `A → B` (optionally `—(relationship)→`) is an arrow
  the author drew between cards. Follow it as intentional structure.
- **`[[wikilinks]]`** in a card's text point to another card *by title*; treat
  them as edges too (the canvas auto-draws them).
- **`#tags`** cluster related cards.

When the user asks you to *act* (build something, find gaps, answer a
question), read the whole structure first — the cards, the graph, AND any
images/files — then reason over it as one connected brief, not isolated notes.

## Scope

This skill READS a `.klypix`. Writing one (assembling a canvas from your
output) is the companion `write-klypix` skill — together they close the loop:
the user hands you a canvas, you hand one back.
