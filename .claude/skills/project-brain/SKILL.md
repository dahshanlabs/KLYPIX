---
name: project-brain
description: Read and update this project's living "brain" canvas (brain.klypix) — a spatial, connected memory of the project's areas, decisions, and open questions that persists across sessions. Use at the START of substantial work to recall where things stand, and AFTER making a real decision / finishing a meaningful piece / discovering something important, to append it as a connected card. Also use when the user asks "what's the state", "update the brain", "what did we decide", or "show the project as a canvas".
---

# The project brain (`brain.klypix`)

`brain.klypix` at the repo root is this project's **living memory as a canvas** —
not a log, a *brain*: titled cards for areas/decisions/open-questions, wired
together with arrows, that both Claude Code and the human read and grow over
time. It's the spatial, multimodal version of an Obsidian vault: persistent
across sessions, and the human can open it in KLYPIX to *see* the whole project.

It complements the text memory (`CLAUDE.md`, `memory/`): the brain is the
shared, visual, connected picture; the text memory is the index. Keep the brain
**curated** — meaningful decisions and structure, never an action-by-action dump.

## Read it (do this when starting substantial work)

```bash
node scripts/read-klypix.mjs brain.klypix
```

You get every card, the connection graph, `[[links]]`, and `#tags`. Reason over
it as the current state before planning new work — it tells you what's shipped,
what's pending, what was decided and why.

## Update it (after a real decision / shipped piece / discovery)

Append new cards — connected to what's already there — with the CLI (twin of the
MCP `add_to_canvas`; preserves existing positions):

```bash
echo '{
  "cards": [
    { "text": "Decision: X over Y\nbecause …", "heading": true },
    { "text": "Open question: …", "color": "#f59e0b" }
  ],
  "connections": [
    { "from": "Decision: X over Y", "to": "<existing card title>", "relationship": "relates_to" }
  ]
}' | node scripts/append-klypix.mjs brain.klypix
```

`from`/`to` reference a NEW card (by index in this addition, or its title) or an
EXISTING card already on the canvas (by its title — read first to get exact
titles). **Read before appending** so you connect to existing cards and don't
duplicate.

## Conventions (keep it a brain, not a pile)

- **Short, titled cards** — one idea each; first line is the title.
- **`heading: true`** for areas / north-star / key decisions.
- **`"color": "#ef4444"`** (red) for blockers; **`"#f59e0b"`** (amber) for open
  questions / pending items.
- **Always connect** a new card to at least one existing card so the graph stays
  whole. Relationships: `leads_to · depends_on · relates_to · supports ·
  blocks · questions · costs`.
- Append **decisions, shipped milestones, open questions, and architecture** —
  not routine edits. If it wouldn't matter to a future session, don't add it.

## Scope

This reads/appends the `.klypix` file directly (same engine as read-klypix /
write-klypix / the MCP server). Reopen `brain.klypix` in KLYPIX to see changes.
It does not auto-fire — updating the brain is a deliberate, curated act.
