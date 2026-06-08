# KLYPIX — Strategy (the north star)

> Built 2026-06-08 from a 6-lens founder-grade analysis. This is the document
> every decision is checked against. If a feature doesn't serve this, don't build it.

## The one sentence (the whole strategy)
**When a foundation lab ships a canvas, what survives is the open, portable
`.klypix` file + its MCP read/write protocol — because a frontier lab is
structurally forbidden from building the one thing it would be: a context
capsule *any rival model* can own and drive, with no lab in the loop.**

## The bet
Bet everything on **`.klypix` as the agent-neutral context capsule**, delivered
as a **free, cross-platform, open MCP package** (`klypix-format` + `klypix-mcp`).
**The format + the open protocol ARE the product.** The Windows desktop app is
merely the best reference reader/editor — the thing you *sell later*, not the pitch.

## Positioning + ICP
> *"The file your AI can't forget and no company can take away — drop your whole
> messy multimodal project (PDFs, screenshots, audio, half-baked notes) into one
> portable file any agent reads and writes over MCP, offline, model-agnostic."*

**ICP:** the **Obsidian-＋-Cursor/Claude-Desktop power-user** — solo devs, indie
hackers, technical researchers who already pay for tools, use an MCP-capable
agent daily, and publicly complain their agent forgets context between sessions.

## The game (decided, not hedged)
**Indie / Obsidian path.** Local-first, you-own-the-file, agent-neutral, no
network effect, can't out-ship a lab — these are *fatal* VC objections and the
*entire pitch* in the indie game. Same product, opposite reception. Charge for
ownership/sync, not seats. Success = beloved paying owners, not feature parity.
TAM caps at "people paranoid enough about lab lock-in to pay" — tens of
thousands, not millions. **Make peace with that or pick the other fork.**
(The ~10 recent commits poured into collab for ~zero users were the VC game
leaking in and quietly killing the indie one.)

## The 4 north-star tests (run EVERY feature through these)
1. **Survives a lab?** When Claude/ChatGPT ships a spatial multimodal canvas in
   6 months, does this still matter? If a lab clones it in a sprint → don't build it.
2. **Agent-neutral?** Does it make a `.klypix` readable/writable/ownable by ANY
   model with no lab in the loop — or quietly create single-provider lock-in?
3. **Deepens *owned* data gravity?** Does it make users put MORE messy,
   cross-session, multimodal work into a file THEY own (raising switching cost)?
4. **Serves distribution or the wedge?** Measured in beloved paying owners, not
   impressiveness. Breadth-for-the-demo = the too-many-products trap → cut it.

## Kill / freeze list (do now)
- **FREEZE collab entirely** — biggest recent time-sink for ~zero users, carries
  a built-but-OFF unverified P0 channel hole, and a lab ships multiplayer free.
  Keep shipped features working, flag default-OFF, picker → Settings. Do NOT
  advance the roadmap or run more 2-PC tests until after the 30-day gate.
- **FREEZE bilingual EN/AR** at what shipped (table-stakes a lab gets free).
- **FREEZE doc-gen** (DOCX/XLSX/PPTX/PDF) maintenance-only; do NOT fix Arabic bidi.
- **FREEZE the Alt+Space overlay** as a *growth bet* — keep it only as a
  "drop-a-file → open canvas" entry point. Don't rip it out (churn, no upside).
- **KILL the query-per-day tier** (`authService.ts TIER_LIMITS`) — meters a
  zero-marginal-cost BYO-key action, renderer-bypassable, contradicts local-first.
- **KILL the day-one SaaS posture** — delete the Next.js admin dashboard +
  Supabase license/tier gates + OAuth complexity; keep auth ONLY for the future
  Sync endpoint.
- **KILL "ship final-28 installer" as the milestone** — another build is grading
  your own homework. The milestone is an external behavior: *a stranger returns
  in week 2.*

## Distribution FIRST (before any more app code)
Carve out a standalone **MIT public repo `klypix-format`**: `klypix-format.mjs` +
`klypix-mcp-server.mjs` + read/write tooling + a 1-page `FORMAT.md` + a README
whose **first line** is the agent-neutral wedge (not "Windows AI overlay").
Verified feasible today (format imports only jszip/fs/path; MCP adds zod +
@modelcontextprotocol/sdk and already runs `npx klypix-mcp --vault ./canvases`
with no desktop app). **The desktop app stays closed-source.**

**Channels, in order (your ICP lives here, NOT Product Hunt):**
1. MCP server directory / awesome-mcp-servers / Smithery — the curated shelf.
2. r/LocalLLaMA, r/ObsidianMD, Cursor/Claude/MCP Discords.
3. An X thread to the AI-builder scene.
4. **Only then** Show HN (it punishes empty cold launches).

**Hero asset:** a 60-second screen recording — ask Claude Desktop (via the MCP
server) to "turn this messy project into a board," show the `.klypix` appear,
open it in the desktop app, pan the spatial result, end on *"the file is yours,
works offline, any model can edit it."*
**Pre-flight gate:** `npx`-install on a CLEAN Mac/Linux box before any post. If
try-it-in-60-seconds breaks on contact, the funnel dies.

## Monetization (copy the Obsidian shape)
- **Free forever, no login:** desktop app + canvas + chat (BYO key) + offline
  OCR/STT + `.klypix` read/write + the MCP server. This makes local-first
  believable + earns word-of-mouth (your only channel).
- **One paid line — KLYPIX Sync** (~$8–10/mo or ~$80/yr): hosted, E2E-encrypted
  sync of your brain/`.klypix` across your machines AND to your agents over
  **MCP-over-cloud** ("your agent reaches your brain from anywhere"). Only thing
  with real marginal cost + recurring value + server-side enforceability (RLS on
  sync blob endpoints — the encryption/transport already exist). Sell the
  MCP-over-cloud reach, not file replication.
- **Secondary:** an Obsidian-style one-time "Commercial Use" honor license
  (~$25–50) — relationship revenue, not a business line.
- **NEVER** paywall agent/deep mode (BYO key = selling users their own compute).

## Validation (cheapest REAL signal, strictly before the moat build)
- **STAGE 0 (zero-build, 72h):** post the thesis as a *question* — "I made a
  portable file your AI reads+writes across sessions, model-agnostic, you own it
  — would you use this? Reply and I'll send the npx." Count genuine "yes, send
  it" replies vs silence. Can't earn one "send me that" → packaging unjustified.
- **STAGE 1 (30 days from npm publish):** ship the package + seed the channels +
  the 20s "Claude reads a `.klypix` then ADDS a card back" recording.
  **GO/NO-GO (pre-committed, don't move the line):** GO = **≥5 strangers install
  AND ≥2 invoke read/write on their OWN canvas in a SECOND week.** NO-GO =
  installs without return, or polite stars with zero tool calls. **Stars/nods
  explicitly don't count.** One 30-day extension allowed for a weak-but-nonzero
  signal; flat-zero-with-traffic = hard kill.

## The plan
**Next 2 weeks**
- STOP building app features. Checkpoint the collab branch; flag default-OFF; picker → Settings.
- Extract `klypix-format` standalone MIT repo + `FORMAT.md` + wedge-first README.
- Publish `klypix-format` + `klypix-mcp` to npm with a bin; **test `npx` on a clean Mac AND Linux** (non-negotiable gate).
- Fire **STAGE 0** (72h demand tweet asking the thesis as a question).
- Record the 60-second hero demo; polish ONLY the render moment it touches.

**Next 30 days**
- Submit to MCP directory / awesome-mcp-servers / Smithery day one.
- Seed r/LocalLLaMA, r/ObsidianMD, the Discords; reply to "my AI forgets" posts with the npx one-liner.
- Run **STAGE 1** to its explicit GO/NO-GO at day 30.
- Opt-in first-tool-call ping; watch npm cohorts + "I wired this in" posts.
- Hand-recruit the first ~10 named ICP buyers. THEN Show HN.
- Rip out `TIER_LIMITS`; free-forever + single "enter API key" UX; delete admin dashboard + tier gating.

**Next 90 days (only on a GO)**
- Package **KLYPIX Sync** (the one paid line), server-side RLS-enforced; lead with MCP-over-cloud.
- Position the desktop app as the premium spatial editor for a format people already use via MCP; start charging.
- Make `brain.klypix` first-class (default canvas on open; bootstrap drop-target).
- Lean into irreversible data gravity (messy, months-deep, cross-session work lives in `.klypix`).
- **Write a 12-month tripwire:** no ~50 paying owners or organic `.klypix`-sharing slope by month 12 → pivot to a pure open agent-memory standard or wind down. No 13th month on hope.
- Keep collab/bilingual/doc-gen/overlay frozen all quarter; **spend ~50% of every week on distribution, not code.**

## Biggest risk
**Data gravity is a race against a 6–12 month clock and you have ~zero
distribution.** The agent-neutral file is only a moat if user vaults are
*months-deep* BEFORE a lab ships its canvas. Start now → switching cost is real
when they arrive. Wait → their empty canvas and yours start even and they win on
polish. (Second-order: a funded competitor can embrace-and-extend the open
format — so you must move first AND be the beloved reference app. Open format +
no app love + no gravity = you handed competitors a free spec.)
