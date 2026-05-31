---
name: write-klypix
description: Assemble a .klypix canvas FROM your output — turn a plan, breakdown, mind-map, or set of notes-and-arrows into a real KLYPIX spatial board the user opens and sees. Use whenever the user asks you to "make/build/turn this into a canvas / board / mind-map / .klypix", or when handing structured thinking (cards + connections) back as a spatial brief rather than plain prose. The reverse of read-klypix.
---

# Writing a `.klypix` file

`write-klypix` is the reverse of `read-klypix`: instead of reading a canvas,
you **build one**. You describe cards (text notes) and the connections between
them as a small JSON spec; the bundled script lays them out and produces a real
`.klypix` v4 file the user opens in KLYPIX (Canvas → Open) and sees as a
spatial board — sized cards, arrows, `[[wikilinks]]`, `#tags`, all intact.

This closes the loop: the user can drop a `.klypix` in for you to read, and you
can hand a `.klypix` back. One shared, multi-modal file is the common brain.

## When to use it

- "Turn this plan / breakdown / research into a canvas / mind-map / board."
- You've reasoned through something with clear pieces + relationships and a
  *spatial* hand-off beats a wall of prose.
- You read one `.klypix`, did work, and want to return the result as a canvas.

## How to write one

1. Author a JSON spec — cards + (optional) connections:

```json
{
  "title": "Launch Plan",
  "cards": [
    { "text": "Goal: ship v1", "heading": true },
    { "text": "Blocker: no 2nd PC for collab test", "color": "#ef4444" },
    { "text": "Idea: agent-brief loop #brainstorm" },
    { "text": "See [[Goal: ship v1]] for the north star" }
  ],
  "connections": [
    { "from": 1, "to": 0, "relationship": "blocks" },
    { "from": 2, "to": 0, "relationship": "supports" }
  ]
}
```

2. Run the writer:

```bash
node scripts/write-klypix.mjs spec.json --out "Launch Plan.klypix"
# or pipe: echo '<spec>' | node scripts/write-klypix.mjs --out board.klypix
```

3. Tell the user the path. They open it in KLYPIX, or you verify it round-trips:
   `node scripts/read-klypix.mjs "Launch Plan.klypix"`.

## Spec rules (keep it simple — the script does the layout)

- **`cards[]`** — each needs `text`. Optional: `heading: true` (bold title
  card), `color` (hex, e.g. `#ef4444` for a risk), `id` (else auto). The first
  line of `text` is the card's title.
- **`connections[]`** — `from`/`to` reference a card by **index** (number), by
  its **title** (first line of text), or by its `id`. Optional `relationship`:
  one of `leads_to · depends_on · relates_to · conflicts_with · supports ·
  questions · costs · blocks`, and an optional `label`.
- Use **`[[Card Title]]`** inside text to link cards by title (the canvas draws
  these too), and **`#tags`** to cluster them — both survive into the file.
- You do **not** set positions. The script sizes each card to its content and
  lays cards out on a tidy grid, BFS-ordered from the connection roots so
  linked cards land near each other. (You *may* pass `x`/`y`/`w` to pin a card,
  but rarely needed.)

## Good practice

- Prefer **short, titled cards** (one idea each) + connections over a few giant
  cards — that's what makes the board readable and the graph meaningful.
- Mark risks/blockers with a red `color`; make the north-star/goal a `heading`.
- Always verify with `read-klypix` after writing — a clean round-trip means it
  will open correctly in KLYPIX.
