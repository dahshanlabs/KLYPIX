# Phase 23 — Command Palette + Calculator + Clipboard (Best-in-Class)

**Status:** Plan only, no code yet. Reviewed and approved before any commit.
**Goal:** Ship a Raycast-class command palette that beats Raycast on Klypix-native data (canvas items, chat history, agent tools) — accessible from both Chat and Canvas modes via `Ctrl+K`.
**Scope:** Path A (palette skeleton + Calculator + Klypix Search + Clipboard) → Path B (snippets + cross-device sync + Apps + Files + Web + AI-augmented).
**Time budget:** ~37 hours, ~5 working days.
**Delivery model:** Bundle — one continuous A→B stream, single installer at the end.

---

## Why this beats Raycast in Klypix specifically

Raycast doesn't know what's inside your canvases, your chats, your pinned conversations, your agent tools, or your `.any` files. Phase 23 searches all of that natively, plus the calc/clipboard/launcher commodity features. Every result can flow into chat or canvas with one keystroke — Raycast's results dead-end at copy-to-clipboard.

The unique moat from Path B:
- **Cross-device clipboard sync via Supabase** — Raycast Pro syncs Mac↔Mac. You'd sync Windows↔Web canvas.
- **AI-augmented `?` prefix** — query becomes agent context with current canvas/chat baked in. No competitor does this.

---

## Architecture

### Single React component: `<CommandPalette />`

Mounted once in App.tsx at the root, controlled by a global hotkey listener. Visible in both Chat and Canvas modes (the route doesn't matter — it's a modal portal).

```
src/palette/
  CommandPalette.tsx        ← the modal UI
  paletteStore.ts           ← global open/close + query state + frecency tracker
  useGlobalHotkey.ts        ← Ctrl+K listener, debounced, with focus guards
  providers/
    types.ts                ← Provider interface (the contract every source implements)
    calculatorProvider.ts   ← mathjs-backed evaluator
    klypixSearchProvider.ts ← canvas items + chat history + pinned chats + agent tools
    clipboardProvider.ts    ← reads from new clipboard history store
    appsProvider.ts         ← Windows Start menu apps (Path B)
    filesProvider.ts        ← PowerShell Get-ChildItem (Path B)
    webProvider.ts          ← Google/DDG open + inline answer card (Path B)
    aiProvider.ts           ← `?` prefix → agent with canvas/chat context (Path B)
  frecency.ts               ← per-result {hits, lastUsed} sql.js persistence
  search.ts                 ← Fuse.js wrapper with score-based ranking
  keyboardModel.ts          ← arrow/tab/enter/shift-enter/cmd-* hotkey routing
```

### Provider contract (`providers/types.ts`)

```typescript
export interface PaletteResult {
  id: string;                  // stable per-source-per-item
  source: string;              // 'calc' | 'klypix' | 'clip' | 'apps' | ...
  title: string;               // rendered headline
  subtitle?: string;           // dimmer second line (e.g. "= 42" or "from chat 3d ago")
  icon?: React.ReactNode;
  primaryAction: {
    label: string;             // shown on Enter; "Open" / "Copy" / "Insert"
    handler: () => void | Promise<void>;
  };
  secondaryActions?: Array<{   // Tab cycles through these
    label: string;
    chord?: string;            // e.g. "Shift+Enter"
    handler: () => void | Promise<void>;
  }>;
  score?: number;              // 0-1 from fuzzy match; frecency multiplies
}

export interface PaletteProvider {
  id: string;                  // 'calc', 'klypix', ...
  /** Optional prefix that exclusively routes to this provider when typed
   *  (e.g. 'clip:' for clipboard, '?' for AI). */
  prefix?: string;
  /** Return results for the current query. May return synchronously OR
   *  yield via an AsyncIterable for slow sources (file system). */
  query(input: string, signal: AbortSignal): Promise<PaletteResult[]> | AsyncIterable<PaletteResult[]>;
  /** Optional empty-state results when input is blank (recents, pinned, etc). */
  emptyState?(): PaletteResult[];
}
```

### Frecency model (`frecency.ts`)

- Stored in sql.js (already a dep) — table `palette_frecency(result_id PK, hits INT, last_used INTEGER)`.
- On every primary action: `hits++`, `last_used = now()`.
- Ranking score: `fuseScore * frecencyBoost` where `frecencyBoost = 1 + log10(hits) * recencyDecay(last_used)`.
- Recency decay: 1.0 if used today, 0.5 if last 7 days, 0.2 if last 30 days, 0.05 otherwise.
- Stored per device. Cross-device sync is out of scope for v1.

### Keyboard model (`keyboardModel.ts`)

| Key | Action |
|---|---|
| `Ctrl+K` (anywhere) | Toggle palette open/close |
| `Escape` | Close |
| `Arrow Up/Down` | Move selection |
| `Tab` | Cycle through secondary actions of highlighted result |
| `Enter` | Run primary action |
| `Shift+Enter` | Run first secondary action (`Open in new way`) |
| `Ctrl+1..9` | Jump to nth result |
| `Ctrl+Enter` | Send result content to chat (provider-aware) |
| `Ctrl+Shift+Enter` | Send result content to current canvas |

Focus-guard: hotkey is suppressed when an `<input>` or `<textarea>` with `data-palette-ignore="1"` has focus. The chat input bar uses normal focus; pressing `Ctrl+K` IN it should open the palette (interrupts typing — same as Raycast).

---

## Path A — Days 1 to 3 (~21 hours)

### Day 1: Palette infrastructure (~6h)

**Files to create:**
- `src/palette/CommandPalette.tsx`
- `src/palette/paletteStore.ts` (Zustand-style external store via `useSyncExternalStore`)
- `src/palette/useGlobalHotkey.ts`
- `src/palette/providers/types.ts`
- `src/palette/search.ts`
- `src/palette/frecency.ts`
- `src/palette/keyboardModel.ts`

**Files to modify:**
- `src/App.tsx` — mount `<CommandPalette />` at the root (always rendered; visibility from store)
- `package.json` — add `fuse.js@^7.0.0`

**Acceptance:**
- `Ctrl+K` from chat OR canvas opens an empty modal with a search box + "No providers registered yet" placeholder.
- Modal lays out: search input on top, result list with selection highlight, footer hint strip (`↑↓ navigate · ↵ open · Tab actions · Esc close`).
- Closing with `Esc` or clicking outside dismisses.
- Store has `register(provider)` API; nothing breaks if zero providers are registered.
- Frecency table created in sql.js on first use; `recordHit(resultId)` + `getBoost(resultId)` work.

**Decisions pre-made:**
- Modal renders via `createPortal(document.body)` to escape canvas pointer-capture and chat overlays.
- Width 640px, max-height 60vh, centered top-third of viewport.
- Result rows are 44px tall with 16px icon, title 13px, subtitle 11px white/50.
- Bilingual (en + ar) — palette respects `useLocale()` for placeholders and footer.

---

### Day 2: Calculator + Klypix Search providers (~8h)

**Files to create:**
- `src/palette/providers/calculatorProvider.ts`
- `src/palette/providers/klypixSearchProvider.ts`

**Files to modify:**
- `src/palette/CommandPalette.tsx` — register both providers on mount
- `package.json` — add `mathjs@^14.0.0`

**Calculator provider (best-in-class):**
- Use `mathjs.evaluate(input, scope)` with a per-palette-session `scope` object so variables persist across queries within one palette open.
- Detect "math-ness": try evaluate, swallow ParseError, only surface a result if it parses AND result is a number/BigNumber/Unit/Date.
- Format result via `math.format(result, {precision: 14})`.
- Detect unit conversion (`50 mph to kph`) — mathjs handles natively.
- Currency: cache rates from `https://api.exchangerate.host/latest?base=USD` in localStorage with daily TTL. Pre-register USD/EUR/GBP/SAR/AED/JPY in scope as units. **Graceful fallback** when offline — show stale rate with "rates cached YYYY-MM-DD".
- Date math: register `today()`, `daysUntil(date)`, `daysSince(date)` as mathjs functions.
- Primary action: copy result to clipboard.
- Secondary actions:
  - `Ctrl+Enter`: send `expression = result` as a chat message
  - `Ctrl+Shift+Enter`: add a TextItem to current canvas with `expression\n= result`

**Klypix Search provider (best-in-class):**
- Sources walked, in this order:
  1. Current canvas items (state.items + state.connections + state.lines + state.strokes via `useCanvasStore.getState()`)
  2. All recent canvases (from cloudShareStore + recent canvases list) — title + assetIds
  3. Pinned chats (`localStorage['pinned_chats']`)
  4. Recent chat memory (`localStorage['alt_space_memory_v1']`)
  5. Agent tools (the 22-tool main registry + 7 sandbox tools) — title = tool name, subtitle = description
- All sources contribute to a single ranked list via Fuse.js with weights:
  - canvas item text: 1.0
  - canvas item title: 1.2
  - pinned chat preview: 1.0
  - agent tool name: 0.8
  - chat memory: 0.6
- Primary action per source:
  - canvas item: focus + zoom to item on current canvas (call `dispatch({type: 'ZOOM_TO_ITEM', id})` — add that action if missing)
  - pinned chat: load pinned chat into chat panel
  - agent tool: prefill chat input with `/use <tool_name>` hint
- Secondary actions:
  - canvas item: `Ctrl+Enter` → quote the item in chat
  - pinned chat: `Ctrl+Shift+Enter` → drop into current canvas as TextItem

**Acceptance:**
- Type `3 + 4 * 2` → top result is "11" with copy/send/insert actions.
- Type `50 mph to kph` → "80.4672 kph".
- Type `25 USD to EUR` → conversion using cached rates with date subtitle.
- Type the name of any item on the current canvas → result list shows it with "Canvas item" badge and zoom-to action.
- Type a pinned chat title → result list shows it with "Pinned chat" badge.
- Frecency: pick the same result twice; on next open with empty query, it appears in empty-state.

---

### Day 3: Clipboard provider (~7h)

**Files to create:**
- `electron/clipboardHistory.ts` — main-process clipboard poller + sql.js persistence
- `src/palette/providers/clipboardProvider.ts`
- IPC: `clipboard-history:list`, `clipboard-history:copy`, `clipboard-history:pin`, `clipboard-history:clear`, `clipboard-history:remove`

**Files to modify:**
- `electron/main.ts` — start the poller after app ready
- `electron/preload.ts` — expose `clipboard.history.*` bridge
- `src/types/electron.d.ts` (or wherever the bridge is typed)

**Storage:**
- Table `clipboard_history(id PK, kind, content_text, content_base64, content_paths, mime, source_app, source_window_title, pinned BOOLEAN, captured_at INTEGER)`.
- Cap at 200 unpinned items; oldest auto-pruned.
- Pinned items never auto-pruned.

**Poller (main process):**
- Setup: `setInterval(() => check(), 900)` after `app.whenReady()`.
- On each tick: read text, html, image, files from `clipboard.read*()`.
- Compute a digest of the current content (sha1 of text+mime). If unchanged → skip.
- If changed → capture `GetForegroundWindow()` for source attribution.
- Detect password patterns (entry from `keepass`, `bitwarden`, `1password`, `lastpass` foreground window title) — flag the row `skip=true` so it never surfaces.

**Provider:**
- Empty state: 20 most recent (pinned items first, then by `captured_at`).
- Search: substring on content_text, source_app, content_paths.
- Result row shows: kind icon (text/image/file), 60-char preview, source app badge, age.
- Primary action: copy to clipboard (writes back via `clipboard.write*()` matching the original kind).
- Secondary actions:
  - `Tab`: pin/unpin
  - `Shift+Tab`: remove from history
  - `Ctrl+Enter`: send content to chat (text only)
  - `Ctrl+Shift+Enter`: drop as TextItem (text) / Image (image) / File (file path → file item) on canvas
- Prefix `clip:` routes exclusively to this provider.

**Acceptance:**
- Copy text from any app → open palette → it appears at the top.
- Copy an image from VS Code → palette shows image with thumbnail + source app "Visual Studio Code".
- Pin a text item → close + reopen Klypix → still there.
- Clear all → empty state shows.
- Paste a password from a known password manager → does NOT appear in history.

---

## Path B — Days 4 to 5 (~16 hours)

### Day 4: Snippets + Clipboard sync + Apps provider (~7h)

**Snippets (text expansion):**
- Reuse clipboard_history table with a `snippet_trigger` column (e.g. `;sig`, `;date`).
- Background renderer-level keystroke watcher (using `keydown` on `window`) that buffers the last 16 chars and looks for trigger matches followed by space/tab/enter.
- On match → replace via `document.execCommand('insertText')` or input-value splice. Trigger is consumed.
- Manage in palette: type `snippet:` to list/create/edit.

**Cross-device clipboard sync (the unique moat):**
- New Supabase table `clipboard_sync(id PK, user_id, content_text, mime, pinned, captured_at, expires_at)`.
- RLS: insert/select your own only.
- Renderer pushes pinned items only (privacy: never auto-push everything) — 5min debounce.
- Other devices poll every 60s when palette opens, merge into local sql.js.
- Settings toggle: "Sync pinned clipboard items across devices" — default OFF.

**Apps provider (Windows Start menu):**
- One-time scan via PowerShell `Get-StartApps | ConvertTo-Json` cached for 1 hour.
- Returns name, AppID. Launch via `start shell:AppsFolder\<AppID>`.
- Fuzzy match name; primary action launches the app.

### Day 5: Files + Web + AI provider (~6h)

**Files provider:**
- Lazy — only fires when input length ≥ 3.
- PowerShell `Get-ChildItem -Recurse -Depth 3` on common roots (Desktop, Documents, Downloads), with allow-list controllable from Settings.
- Result row: filename, parent dir, modified date.
- Primary action: open with default app.
- Secondary: reveal in Explorer, copy path, drop on canvas as FileItem.

**Web provider:**
- If query is a URL → primary action opens in browser.
- Otherwise → secondary action "Search the web for X" opens Google.
- Inline answer card: hit a free API (Wikipedia summary on the query first token if it looks like a noun) — cache 7 days.

**AI provider (`?` prefix):**
- Query stripped of `?` becomes the agent prompt.
- Current context auto-injected:
  - Chat mode: last 5 messages + active document content
  - Canvas mode: current selection (if any) + visible viewport items
- Streams response into a result row that grows in place.
- Primary action: copy answer; secondary: send full answer to chat / drop on canvas.

### Day 5 buffer (~3h)
- Testing across all providers with the 12-step script from the memory note (extended).
- Bug fixing.
- i18n catalog additions (~30 new keys, en + ar).
- Final installer build.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| mathjs is 150KB → bundle bloat | Lazy-import via `await import('mathjs')` inside calculator provider — only loaded when palette opens. |
| PowerShell calls block UI | All file/app provider calls go through the existing persistent PowerShell child process pattern (`electron/main.ts`). |
| Clipboard poller drains battery | Skip poll when window is hidden/minimized — listen for `browser-window-blur` and reduce to 5s cadence. |
| sql.js write contention with existing canvas autosave | Use separate sql.js instance for palette data (different file). |
| Cross-device clipboard leaks passwords | Pinned-only sync + per-device opt-in setting + skip flag on password-manager pastes (already in Day 3). |
| Fuzzy search drowns exact matches | Boost exact substring matches with `+0.5` flat score above fuzzy. |

---

## Decision points to confirm before Day 1

These are pre-decided above; flag tomorrow only if you want to flip:

1. **Bundle delivery** (one installer at end of Day 5, no mid-installs) — confirmed
2. **Frecency local-only** — no cross-device sync of usage stats — confirmed
3. **Currency API: exchangerate.host** — free, no auth, daily updates — confirmed (swap to another if blocked in your region)
4. **Default cross-device sync: OFF** — user must opt in via Settings — confirmed
5. **AI `?` provider uses current canvas/chat context implicitly** — no manual context picking in v1 — confirmed

---

## Stop conditions / when to abort

If any of these turn out true during Day 1, pause and re-plan:

- `Ctrl+K` collides with an unfound binding inside React-only contexts (focused contenteditable, etc.)
- Fuse.js doesn't handle Arabic correctly out of the box (would need a normalizer pass)
- Frecency-in-sql.js conflicts with existing canvas autosave handler

All three were checked in the survey — none expected.

---

## Final deliverables (end of Day 5)

- Single installer `Klypix Setup 1.1.0-palette.exe` (version bump from `1.1.0-collab-test-4`)
- All providers working end-to-end
- ~50 new i18n keys for en + ar
- Updated CLAUDE.md "Mode 4: Command Palette" section
- Memory note for next session
