# KLYPIX — Consolidated Plan (2026-05-14)

This doc supersedes the multiple `KLYPIX_Agent_Engine_v*.md` files, the
`HERMES_ARCHITECTURE.md` reservation, and the scattered design notes from prior
sessions. It is the single source of strategic truth.

## 1. Product thesis

**KLYPIX is the personal AI workspace that lives in one file you own.**

- Horizontal (every knowledge worker), not vertical (not pharma-only).
- Local-first. Cloud sync is opt-in per canvas, never required.
- The artifact is a single `.klypix` file on disk. You can email it, archive
  it, put it on a USB drive, hand it to a colleague. No vendor can lock you
  out, change pricing on you, or shut your data down.
- AI inside helps you organize, summarize, connect, and reason over what's on
  the canvas. The AI is an *executor* (does the work), not a *suggester*
  (asks what you want to do).
- Files dropped into the canvas live **inside** the `.klypix` AND
  round-trip edits transparently. Open a Word doc from inside the canvas →
  edit it in Word → save → the change is now in your `.klypix`. This is the
  feature that makes the "one file" promise actually mean something.

### Positioning vs. the obvious competitors

| | Their model | KLYPIX |
|---|---|---|
| Miro / FigJam / Mural | Cloud, team-first, no local file | Local, personal-first, file is the artifact |
| Heptabase / Scrintal | Cloud-synced canvas, no real agent | Local file, real execution agent |
| Notion / Obsidian | Text/markdown, not spatial | Spatial canvas + AI |
| Apple Freeform | Spatial, no AI, Apple-only | Spatial + AI, cross-platform aspiration |
| ChatGPT / Claude | Linear chat, ephemeral | Persistent workspace, work doesn't disappear |

Closest analog by philosophy is Obsidian — local files, plugin ecosystem,
prosumer pricing, ~3M users, profitable indie. Same playbook, different
artifact (canvas not notes).

## 2. What we are NOT doing

These are off-the-table decisions, not "later" decisions. Revisiting them
requires explicit re-planning.

- ❌ Vertical pivot (pharma, regulatory, etc.) — horizontal is decided
- *(Real-time multi-cursor co-edit moved to Phase 11-12, see roadmap. The
  Phase 6 cloud sync schema is designed CRDT-compatible from day one so
  Phase 11 is ~3-4 weeks of tldraw-sync integration, not a 6-week schema
  rebuild.)*
- ❌ Full web editor at feature parity with desktop — web is a viewer + share
  surface, the desktop app stays the hero
- ❌ Templates / plugins marketplace — community can build this later
- ❌ Replacing Claude as agent default — Claude stays primary; DeepSeek is
  opt-in for the right tasks; sandwich router is the eventual cost cut
- ❌ Mobile apps — desktop only for ≥12 months

### Team collab IS in scope (just spelled out clearly)

Earlier drafts of this doc said "no team collab" — that was sloppy. There
are four kinds of collab and three of them ship:

| Type | Position |
|---|---|
| Async file sharing (`.klypix` sent over email/Slack/USB) | ✅ Works today — that's the whole product |
| Share-by-URL viewing (read-only web view) | ✅ Planned Phase 9 |
| Comment threads on canvas items (async PDF-annotation style) | ✅ Phase 11+ |
| Real-time multi-cursor editing | ✅ Phase 11-12, via tldraw-sync; sync layer pre-designed CRDT-ready in Phase 6 |

The first three are real collaboration. Only the Figma-style live-cursor
experience is the deferred one.

## 3. The format: `.klypix` v2

The current `.any` (v3 internal schema) is a zip with one big `canvas.json`
plus an `assets/` folder. This breaks at scale (10GB workspaces) and doesn't
support per-item edits without full-file rewrite.

The new `.klypix` v2 format is:

```
<canvas-name>.klypix          (zip container — random-access reads supported)
├── manifest.json             — small index: format version, item count, asset list, sync metadata
├── canvas.json               — spatial state: positions, sizes, connections, viewport, settings
├── items/
│   ├── item_<id>.json        — one file per item: content + per-item metadata
│   └── ...
└── assets/
    ├── files/<sha>.bin       — embedded user files (Word, Excel, PDF, etc.) — content-addressed
    ├── images/<sha>.bin      — embedded images
    └── thumbs/<id>.png       — preview thumbnails for the dashboard
```

**Why per-item files**: open canvas → read manifest + canvas.json → render
positions → lazy-fetch items as they enter viewport. Save → rewrite only
changed items, never re-serialize the whole archive.

**Why content-addressed assets**: deduplication (same file dropped twice =
one copy), integrity checks (sha mismatch = corruption), simpler sync deltas
later.

**Backward compat**: `.any` is recognized as an alias and auto-upgraded to
`.klypix` v2 on first save. Existing files never lose data.

### Size: unlimited by design

There is no architectural cap on `.klypix` file size. The format scales
infinitely because:

- Zip64 mode supports archives up to 16 exabytes
- Random-access reads (zip central directory) mean opening a huge archive
  doesn't load it all into memory
- The per-item layout means a million-item canvas is a million small files
  inside the zip, lazy-loaded on demand
- Content-addressed assets dedupe automatically
- Incremental save means changing one item never re-writes the whole archive

**Real constraints are operational, not architectural:**

| Concern | Mitigation |
|---|---|
| Memory on open | Lazy-load items + assets — only viewport-visible content in RAM |
| First-open time | Read manifest (KB) + canvas.json (MB) → render positions → fetch item content as user pans. Target: multi-GB canvases open in 1-2s. |
| Save speed | Per-entry rewrite — editing one item doesn't touch the other 99,999 |
| Cloud sync cost | Tiered storage quotas (free 5GB, paid up) — a billing decision, not a file format cap |
| Cloud upload time | Content-addressed chunked uploads, resumable, dedupe across canvases |

**No soft limits, no warnings at arbitrary thresholds, no hard cap.** Your
canvas can be 500GB. It's your file.

## 4. The embed subsystem (the feature that makes the format meaningful)

When user drops a file or folder on the canvas:

1. KLYPIX copies the binary into `assets/files/<sha>.bin` inside the `.klypix`
2. Canvas shows a `FileItem` referencing the asset hash + original filename
3. User clicks "Open" → KLYPIX:
   - extracts the asset to `%LOCALAPPDATA%/klypix/working/<canvas-id>/<filename>`
   - launches the system default app (Word, Excel, etc.)
   - starts a `chokidar` file watcher on the extracted path
4. User edits and saves in the native app
5. File watcher fires (debounced 1-2s for atomic-write apps like Word)
6. KLYPIX re-packs the modified file into `assets/files/<new-sha>.bin`
7. Item updates to reference the new sha; old sha is GC'd if unreferenced
8. Canvas item shows `Synced ✓` for 2s

UX rules (non-negotiable):
- Per-item sync state always visible (idle / syncing / synced / conflict)
- Lazy extraction — never extract the whole `.klypix` on open
- Atomic re-pack — write `<canvas>.klypix.tmp`, rename on success, never
  corrupt the user's file mid-write
- Cleanup working dir on canvas close (or after N minutes idle)

Gotchas already accounted for: Word lock files, Office atomic-save patterns,
antivirus interference, two-windows-same-file conflict, orphaned working
dirs on crash.

## 5. Cloud sync (opt-in) — CRDT-ready from day one

After the format and embed work land, sync becomes meaningful.

- Per-canvas "Sync to my account" toggle
- Authoritative store: Supabase Postgres (`canvases` table)
- Assets in Supabase Storage (S3-compatible), content-addressed by sha — the
  same scheme used in the `.klypix` so dedupe is free
- Web viewer at `klypix.com/c/<share_token>` for shared canvases

**Critical architecture decision: state stored as a sequence of operations,
not as document snapshots.** This is the prep work that makes real-time
multi-cursor (Phase 11) cheap to add later:

```
Instead of:                       Use:
  canvases.state (jsonb           canvas_ops (timestamped ops)
    = full doc snapshot)            + canvases.snapshot
                                  (periodic compaction of ops into a snapshot)
```

This is the same pattern Yjs, Automerge, and tldraw-sync use internally.
Cost: ~1 extra week of design + slightly more complex sync code in Phase 6.
Saves ~6 weeks of schema rebuild when we add real-time in Phase 11.

Conflict handling stays simple in Phase 7-8 (no real-time yet): two
clients edit offline, both come back online, server merges ops in
timestamp order. Last-op-wins per item field. Backup of the local file is
saved if a non-trivial divergence is detected.

## 6. The agent work (still alive, but no longer the lead)

What we built and keeps shipping:
- Multi-provider adapter (Claude, Gemini, OpenAI, GLM, DeepSeek V4-Pro/Flash)
- Eval harness with 8 prompts (the Claude baseline: 6/8 passed, $1.67)
- Narrator layer (fire-and-forget Gemini Flash status between agent turns)
- Cost tracking with cache hit/miss telemetry
- Soft-budget yellow flags in eval results

What's deferred (still worth doing, just not blocking):
- Sandwich router (Plan→Execute→Synthesize with model per role)
- Anthropic prompt-restructure for cache_control markers (unlocks 80%+
  cache hit on Claude turns)
- Eval expansion (more prompts, more model-pair comparisons)

What changed: the agent is now in service of the canvas. New agent
investment goes into **canvas-native operations** — agent that arranges,
connects, summarizes, finds-related-items on the spatial workspace, not
agent that does file-system manipulation in a vacuum.

## 7. Roadmap (10 weeks)

| Week | Deliverable | Why |
|---|---|---|
| **W0 (today)** | Rebrand `.any` → `.klypix` + plan doc | Identity. Cheap. Sets up everything that follows. |
| W1 | `.klypix` format v2 spec + read/write codec | Foundational. Blocks embed subsystem. |
| W2 | Migration v3→v4 (`.any` → `.klypix` v2 layout) on first save | Existing user files keep working. |
| W3 | Embed subsystem: open file, watch, re-pack | The feature that makes the format meaningful. |
| W4 | Embed subsystem: folders, lazy extract, cleanup | Round-trips folder edits. |
| W5 | Local "canvases" dashboard view | Users think in canvases, not files. |
| W6 | Supabase canvases table + RPC + RLS | Cloud foundation. |
| W7 | Per-canvas sync toggle + push/pull engine | Sync works. |
| W8 | Conflict handling + asset upload | Sync survives multi-device usage. |
| W9 | Share URL + read-only web viewer at `klypix.com/c/<token>` | Sharing without files. |
| W10 | Polish, dogfood, ship public beta | First real users. |
| W11-12 | Real-time multi-cursor via tldraw-sync (or Yjs custom) | Live collab on shared canvases. Sync schema from W6 already CRDT-friendly. |

Sandwich router + canvas-agent quality + prompt caching land in parallel as
20-30% time investments, not blocking gates.

## 8. Today's first move

Phase 0a (this commit):
1. This doc as the immutable plan
2. Rebrand to `.klypix` — file extension, dialogs, defaults, titles
3. Keep `.any` recognized as a backward-compatible alias (no user file breaks)
4. File-association on Windows for both `.klypix` and `.any` extensions

Nothing in this Phase 0a touches data formats or storage layouts. Pure
rename + alias. Risk: ~zero. Bounce all confidence into the format-v2 work
starting tomorrow.
