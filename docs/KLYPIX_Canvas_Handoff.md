# KLYPIX Canvas — Session Handoff

Last updated: 2026-05-02 (early AM). Spec: [`docs/CLAUDE-KLYPIX-CANVAS.md`](./CLAUDE-KLYPIX-CANVAS.md).
**This is the "pick up where we left off" doc.** Read me first.

---

## 2026-05-01/02 session — Excalidraw-inspired adoption batch (12 commits, 853b8ed4 → 73431f68)

Triggered by user asking what's worth taking from Excalidraw and whether it can help with cloud sync. Ended up shipping a 4-phase plan plus a multi-select bounding box, a Virgil font default, and a presentation-mode fix. **CRITICAL: half of this session's reducer + renderer changes are sitting in the user's pre-existing uncommitted WIP** in `state/canvasStore.tsx`, `CanvasRenderer.tsx`, `KlypixCanvas.tsx`, `interaction/useCanvasInteraction.ts`, `interaction/ResizeHandle.tsx`, `items/ContainerItem.tsx`, `items/types.ts`, `index.css`, `electron/main.ts`, `electron/preload.ts`. The clean-half commits ship in the master log; the matching mutations land when the user commits their WIP.

### Architectural decisions locked

**1. `.any` schema versioning is now framework-driven.** [`src/canvas/file/migrations.ts`](../src/canvas/file/migrations.ts) — exports `Migration` type and `runMigrations(doc, from, target)` runner. Migrations registry is append-only; never reorder or remove entries. Within-version normalization (legacy field aliases, idempotent fixups like `collapsed → userCollapsed` and `collapsedW` reseed) stays in [`anyFormat.ts`](../src/canvas/file/anyFormat.ts) `normalizeV3` — it runs every load regardless of version. CURRENT_VERSION is now **3**. Adding a v4: define `CanvasDocumentV4`, append `from: 3, to: 4` migration, bump CURRENT_VERSION, update `serialize`/`deserialize` return types.

**2. Items have a fractional `zKey` (v2 of file format).** Source of truth for z-order alongside the existing `state.order` array. New items get `zKey: generateKeyBetween(topZKey, null)` in the ADD_ITEM reducer — append-without-renumber. `state.order` stays maintained as the items array sorted by zKey. Numeric `zIndex` continues as the CSS render mirror (re-synced via `syncOrderKeys`).

**3. Drawings have a fractional `zKey` too (v3 of file format).** `DrawnLine` and `FreehandStroke` join the same z-order namespace as items. `REORDER_ITEMS` action accepts `lineIds?` and `strokeIds?` alongside `ids`, permutes existing zKeys among the new sibling order (never generates new keys → preserves the parent-child z-band invariant for free), and resorts `state.order` from item zKeys at the end. The `topZKeyForParent(items, lines, strokes, parentId)` helper considers all three at the same parent.

**4. `CanvasRenderer.renderList` interleaves items + drawings by zKey per parent.** Containers render first (depth-sorted as backdrop frames), then non-container items + lines + strokes are interleaved as a single sorted list before `ConnectionsLayer`. `<DrawingLayer>` removed; per-stroke `<StrokeView>` and `<LineView>` components render inline. **Trade-off accepted:** when a CONTAINER is reordered, its descendants' zKeys aren't updated to follow, so they may sort between unrelated siblings of the moved container — same blind spot the array-shuffle approach had pre-v3, no regression.

**5. Click hit-test resolves item/drawing collisions by zKey.** `useCanvasInteraction.ts` always hit-tests both items AND drawings now (was: only drawings if no item hit). `drawingZ >= itemZ → drawing wins`. Tie-break uses `>=` so legacy entities without zKeys still hand the click to drawings, matching `renderList`'s DOM order (drawings come after items, stable sort keeps them on top). This is the bug-fix for "click on stroke selects text underneath."

**6. Per-item ResizeHandle becomes inert during multi-select.** When `selectedIds + selectedLineIds + selectedStrokeIds >= 2`, the per-item handle's `onPointerDown` early-returns. The new outer `<MultiSelectionBox>` ([`interaction/MultiSelectionBox.tsx`](../src/canvas/interaction/MultiSelectionBox.tsx)) owns the drag — uniform scale on all 8 handles, snapshot-based math (capture all entity positions on pointer-down, dispatch UPDATE_* from snapshot × factor each move). DrawingResizeHandles already conditioned on single-drawing-selected, so no change there.

**7. Cloud sync architecture: client-side encrypt, server stores opaque blob.** AES-256-GCM via `crypto.subtle` ([`cloud/encryption.ts`](../src/canvas/cloud/encryption.ts)). Wire envelope format ([`cloud/syncBlob.ts`](../src/canvas/cloud/syncBlob.ts)) is `[KX][version][reserved][12-byte IV][ciphertext]`. Share-link format `klypix://canvas/<id>#<base64-key>` — fragment is never sent to server. `CloudTransport` interface ([`cloud/syncClient.ts`](../src/canvas/cloud/syncClient.ts)) is the seam between high-level sync ops and the actual transport — production wires it to electron-IPC ([`cloud/electronTransport.ts`](../src/canvas/cloud/electronTransport.ts) → `window.electron.cloud.*` → [`electron/cloudHandlers.ts`](../../electron/cloudHandlers.ts)). Tests can inject in-memory transport. Server (Supabase) NEVER sees plaintext or keys.

**8. Container vector-scale is zoom-decoupled.** [`ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx) — `state.view.zoom` REMOVED from the vector-scale effect's dep array. Header-height floor (`MIN_HEADER_SCREEN_PX / viewZoomSafe`) still computed inside the effect for rendering, but the effect no longer re-runs purely on zoom change. Stops zoom-dependent state writes from drifting child geometry between view zooms.

**9. Subpixel cushion on derived `authoredWidth`.** When the vector-scale patches a child text item's `authoredWidth`, it now adds `+2` world-px to absorb glyph-rendering rounding error: `nextAw = anchor.authoredWidth * scale + 2`. Without this, scaling a container down tipped single-line strings into wrap mode at certain ratios because text glyph widths don't scale perfectly linearly with fontSize.

**10. Virgil is the new canvas text default.** [`index.css`](../src/index.css) `@font-face` loads it from `/fonts/Virgil.woff2` (bundled at [`public/fonts/Virgil.woff2`](../public/fonts/Virgil.woff2), 60 KB). `TextItem.tsx` fallback chain is `'Virgil, Outfit, system-ui, sans-serif'` — items without explicit `fontFamily` now render in Virgil. Outfit stays in the picker. App UI chrome (buttons, menus) stays Outfit via the body font in `index.css`.

**11. Perfect-freehand for ink-quality strokes.** [`drawing/DrawingLayer.tsx`](../src/canvas/drawing/DrawingLayer.tsx) — replaced naive quadratic-bezier `strokePath` with `getStroke()` rendered as a filled outline. `FreehandStroke.points` extended with optional `pressure?: number` (preserved through container reparent / resize / scale / duplicate via spread). `simulatePressure: true` derives velocity-based pressure for mouse strokes; stylus pressure flows through directly.

**12. Presentation slide pool captures once on open.** [`layout/PresentationMode.tsx`](../src/canvas/layout/PresentationMode.tsx) — `slideIds` are snapshotted into state via `useEffect` keyed only on `open`, read through a `stateRef`. The per-slide effect's `dispatch SELECT [s.id]` was collapsing the multi-selection back down to 1, which then re-derived the slide pool to 1. Decoupling from `state.selectedIds` fixes "select 2 items, hit Present, see 1/1."

### Files touched (clean commits — separate from WIP)

- **New:** [`migrations.ts`](../src/canvas/file/migrations.ts), [`cloud/encryption.ts`](../src/canvas/cloud/encryption.ts), [`cloud/syncBlob.ts`](../src/canvas/cloud/syncBlob.ts), [`cloud/syncClient.ts`](../src/canvas/cloud/syncClient.ts), [`cloud/electronTransport.ts`](../src/canvas/cloud/electronTransport.ts), [`electron/cloudHandlers.ts`](../../electron/cloudHandlers.ts), [`interaction/MultiSelectionBox.tsx`](../src/canvas/interaction/MultiSelectionBox.tsx), [`supabase/migrations/20260430000000_canvas_blobs.sql`](../../supabase/migrations/20260430000000_canvas_blobs.sql), [`public/fonts/Virgil.woff2`](../../public/fonts/Virgil.woff2)
- **Refactored cleanly:** [`anyFormat.ts`](../src/canvas/file/anyFormat.ts), [`useAnyFile.ts`](../src/canvas/file/useAnyFile.ts), [`VersionHistoryPanel.tsx`](../src/canvas/layout/VersionHistoryPanel.tsx), [`drawing/DrawingLayer.tsx`](../src/canvas/drawing/DrawingLayer.tsx), [`PresentationMode.tsx`](../src/canvas/layout/PresentationMode.tsx), [`interaction/TextPanel.tsx`](../src/canvas/interaction/TextPanel.tsx), [`items/TextItem.tsx`](../src/canvas/items/TextItem.tsx)

### Files touched (WIP-mixed — committed when user commits their branch)

- [`state/canvasStore.tsx`](../src/canvas/state/canvasStore.tsx) — `topZKey` / `topZKeyForParent` / `syncOrderKeys` / `ensureZKeys` helpers, ADD_ITEM/ADD_LINE/ADD_STROKE zKey assignment, DUPLICATE_ITEMS fan-out keys, REORDER_ITEMS unified reducer with defensive backfill, LOAD_FILE backfill
- [`interaction/useCanvasInteraction.ts`](../src/canvas/interaction/useCanvasInteraction.ts) — pen-tool pressure capture, click priority via zKey
- [`interaction/ResizeHandle.tsx`](../src/canvas/interaction/ResizeHandle.tsx) — inert-when-multi check
- [`items/ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx) — pressure preservation through anchor + scale, view.zoom removed from vector-scale dep, +2px subpixel cushion on authoredWidth
- [`items/types.ts`](../src/canvas/items/types.ts) — zKey on BaseItem / DrawnLine / FreehandStroke (all optional), `pressure?: number` on stroke points
- [`KlypixCanvas.tsx`](../src/canvas/KlypixCanvas.tsx) — onArrange forwards selectedLineIds + selectedStrokeIds
- [`CanvasRenderer.tsx`](../src/canvas/CanvasRenderer.tsx) — `renderList` useMemo with interleaved entries, `<MultiSelectionBox>` mount, drawing kind-dispatch in render loop, `<DrawingLayer>` removed
- [`index.css`](../src/index.css) — `@font-face` for Virgil
- [`electron/main.ts`](../../electron/main.ts) — `import + registerCloudHandlers(ipcMain)` (~2 lines)
- [`electron/preload.ts`](../../electron/preload.ts) — `cloud:` namespace on contextBridge (~9 lines)

### Key constants (don't re-litigate)

- **`MultiSelectionBox` handle size:** `HANDLE_SCREEN_SIZE = 9` px, counter-zoomed. Frame padding `FRAME_PADDING_WORLD = 4`.
- **Subpixel cushion on container-derived `authoredWidth`:** `+2` world-px. Below visible threshold at any realistic zoom.
- **Cloud envelope wire version:** `1`. Magic bytes `0x4B, 0x58` ('K', 'X'). Header is 4 bytes + 12-byte IV + ciphertext.
- **AES-GCM IV length:** 12 bytes (standard). Generated fresh per encrypt() — never reuse a (key, IV) pair.
- **`CURRENT_VERSION` (.any file):** 3.

### Known watchouts / edge cases

- **Container reorder limitation.** When a CONTAINER's zKey moves via REORDER_ITEMS, descendants' zKeys aren't pulled along — they keep their original keys, which may now sort between unrelated siblings of the moved container. Pre-v3 had the same blind spot via array-shuffle. Fix when it becomes a real-world problem (would require recursive descendant zKey regeneration into the parent's new z-band).
- **HMR + `useReducer` capture.** React captures the reducer function at `useReducer` mount. Hot-reloading `canvasStore.tsx` doesn't update the running reducer. The defensive `missing` backfill in REORDER_ITEMS handles in-memory state from before the reducer changes, but truly correct testing of new reducer logic requires `Ctrl+R` reload (or `npm run dev` restart).
- **`StrokeView` / `LineView` sized 100000×100000.** With CSS `overflow: visible`, an SVG viewport must be non-zero — sizes of 0 clip all path content even with `overflow: visible`. The original batched `DrawingLayer` used the same trick. Empty SVG regions don't allocate raster memory until painted, so the cost matches the pre-split version.
- **Virgil's per-character widths > Outfit's.** Defaulting existing text to Virgil shifts apparent column widths. Combined with the vector-scale subpixel issue, this was the trigger for the `+2` cushion fix in #9 above.
- **Cloud RLS does not yet support anonymous share-link reads.** SQL migration intentionally restricts `canvas_blobs` to owner-only. Implementing share-link reads will need a `canvas_share_tokens` table with scoped read RLS — see comment in [`20260430000000_canvas_blobs.sql`](../../supabase/migrations/20260430000000_canvas_blobs.sql).
- **`generateKeyBetween(null, null)` collision.** Two consecutive `topZKey`/`topZKeyForParent` calls with empty state both return `null`, and `generateKeyBetween(null, null)` always produces `"a0"` — so two simultaneous adds to a fresh canvas/parent could clash on key. Practically impossible in single-user dispatch flow (each add updates state before the next reads it), but worth knowing if you ever batch ADD operations.

### What NOT to re-touch

- **`MultiSelectionBox` is uniform-scale only by design.** User explicitly chose corners-AND-edges-both-scale over the Figma corners-scale-edges-stretch model. Don't add a stretch mode without checking.
- **`@font-face` URL is `/fonts/Virgil.woff2`** (relative to public/). Vite serves `public/` at root. Don't change to a CDN — local bundling is the deliberate choice.
- **AES-GCM IV is generated fresh per encrypt() call.** Do not seed it from anything — random or bust. The wire format mandates the IV ride alongside the ciphertext.
- **The `>=` tie-break in click hit-test** is intentional. Drawings beat items on tie because the pre-v3 render order put drawings on top. Switching to `>` would surface the legacy click-priority bug.

### Still open / deferred

- **Cloud UI.** The transport stack works end-to-end once the SQL migration is applied and WIP lands. No "Save to Cloud" / "Open from Cloud" buttons yet, no share-link copy/paste UX, no sync indicator. Touches App.tsx and canvas chrome — heavy WIP territory currently.
- **Apply the SQL migration.** `supabase db push` from project root or paste [`20260430000000_canvas_blobs.sql`](../../supabase/migrations/20260430000000_canvas_blobs.sql) into the Supabase SQL editor. Until done, all cloud-handler dispatches will fail at the Supabase call.
- **Anonymous share-link reads** (separate `canvas_share_tokens` table — see #5 above).
- **Conflict resolution for cloud sync.** Two devices editing the same blob = last-write-wins. Real collab needs CRDT or OT.
- **Reducer hot-reloadability.** Could refactor `useReducer` to dispatch through a ref so HMR actually updates behavior without page reload. ~5 lines, clean win, but explicitly deferred when offered.
- **High-zoom group text wrap edge case** is mitigated by the `+2` subpixel cushion but not 100% gone — the cushion helps the common case; very specific glyph + scale combinations can still tip wrap. Real fix would measure-then-clamp at render time.
- **Text item creation default → Virgil.** Right now Virgil is default via the CSS fallback chain. Setting `fontFamily: 'Virgil'` explicitly at item-creation time would make legacy users who deliberately wanted "no fontFamily = Outfit" upgrade more controlled. Not done; user wanted Virgil universally.

---

## 2026-04-18 session — drawings-as-first-class, groups, and chrome polish

Massive batch across many conversation turns. 5 bug-list documents processed, plus ad-hoc fixes. Compressed as "what's shipped, what's the invariant, what to watch for."

### Architectural decisions locked

**1. Drawings (lines + strokes) are first-class selectable canvas objects.** Added `selectedLineIds` / `selectedStrokeIds` to CanvasState, `SELECT_LINES` / `SELECT_STROKES` actions, geometric hit-test in [`useCanvasInteraction.ts`](../src/canvas/interaction/useCanvasInteraction.ts) (fat hit radius = `max(width/2 + 6px, 8px)` world-px). Click to select, Delete/Backspace to remove, marquee includes them via bbox intersect, unified move drag handles items+drawings together. DrawingLayer stays purely visual — no SVG event wiring.

**2. Drawings have `parentId` + `authoredInParent`.** `DrawnLine` and `FreehandStroke` extended with optional `parentId` and vector-scale anchor. Anchor for lines: `{x1, y1, x2, y2, width}` relative to container's authored origin. For strokes: `{points: [{x,y}], width}` relative. Container vector-scale effect in [`ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx) now iterates `state.lines` and `state.strokes` alongside items — drawings stretch/shrink with the group like everything else.

**3. Stroke renders on top of container frame, below header.** Render order in [`CanvasRenderer.tsx`](../src/canvas/CanvasRenderer.tsx): connections → items & frames → **drawings** → container headers. Solves "stroke parented to group was painted over by the group's semi-transparent body".

**4. Cut deletes descendants.** `Ctrl+X` handler expands `selectedIds` via a fixed-point parentId walk before dispatching `DELETE_ITEMS`. Otherwise reducer's orphan-rescue keeps children alive at top level — broke the "cut group → paste whole group" flow for a while. Copy already walked descendants into clipboard via `performCanvasCopy`; cut now matches.

**5. Agent response position is anchored at execution time, not LLM-snapshot time.** New `resolveAgentCardPosition(state, proposedX, proposedY, w, h)` helper in [`canvasToolExecutor.ts`](../src/canvas/agent/canvasToolExecutor.ts). Priority: current selection bbox (+24 gap to the right) → LLM's x/y if visible in viewport → viewport center. Fixes "cut group + paste elsewhere then ask agent → answer appears at old location."

**6. Universal double-click → "open" dispatch.** New [`itemOpen.ts`](../src/canvas/items/itemOpen.ts) with `tryOpenItem(item)`. File/image/video/audio open externally (originalPath → asset bytes → temp), link opens URL, canvas-link spawns new tab, code enters edit mode. Text/box/container keep their existing dblclick semantics.

**7. Tools create inside focused group; click-outside doesn't exit focus.** Removed `if (focusedId && !hit) exit` block from `onPointerDown`. Box/line/pen/connect tools now set `parentId: focusedId ?? null`. T-tool always parents to focused group (previously only if click was inside bounds). Exit focus = Escape OR header LogOut button ONLY.

**8. `Ctrl+G` / `Ctrl+Shift+G`.** Group shortcut was being stolen by the pre-existing "Ctrl+G jump to last agent item" handler. Guard: agent-jump now only fires when selection is empty. `groupSelection()` in [`KlypixCanvas.tsx`](../src/canvas/KlypixCanvas.tsx) creates container from item + line + stroke selection buckets, sets `parentId` via UPDATE_LINE/UPDATE_STROKE. New `UNGROUP_CONTAINER` action reparents children to grandparent before deleting the container.

**9. Empty-group auto-delete.** Reducer helper `expandDoomedWithEmptiedContainers(state, doomedItems, doomedLines, doomedStrokes)` wired into DELETE_ITEMS / DELETE_LINES / DELETE_STROKES. Fixed-point walk marks any container whose entire child population (items + drawings) is in the doomed set — transitively deletes nested empty groups too. Plus `CanvasSurface` has a useEffect sweeper with a 2s grace window that catches empties left by UPDATE_ITEM parentId changes.

**10. Group auto-expands on child drag-end.** onPointerUp in `useCanvasInteraction` collects `affectedParentIds` from drag.ids + drag.lineIds + drag.strokeIds. For each affected parent container, computes bbox across items + lines + strokes. If any child extends past bounds → grow container + re-seed authoredInParent for EVERY child (items AND drawings) at scale=1. `suppressContainerResizeScaling(id)` skips the next vector-scale pass.

**11. Counter always reflects items + drawings.** `countChildren(containerId, items, lines, strokes)` in [`ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx). Header badge, sub-group menu counts, outline sidebar, minimap all use this.

**12. Collapsed-container transitive hide.** `hiddenByCollapse` in CanvasRenderer — fixed-point walk finds every item whose ancestor chain passes through a tab-mode container. Paired `tabModeContainers` set for the direct-child case (drawings parented to the collapsed container itself). `visibleLines` / `visibleStrokes` filter drawings via both sets. Minimap replicates the same walk.

**13. Proportional capsule scaling on collapsed tabs.** Replaced threshold hiding. `capsuleScale = min(1, tabScreenW / naturalScreenW)`; font/icon/gap/padding/header-height all scale together with screen-px floors (`Math.max(7, 13*scale)` etc.) when `tabMode`. Expanded headers still use the legacy `titleScale` floor. SubGroupMenu takes `iconSize` prop.

**14. Dynamic collapsed-width floor by zoom.** `getCollapsedMinScreenWidth(viewZoom)` in [`ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx): 150 screen-px at zoom ≥ 0.1, linearly lerps to 60 at zoom → 0.01. Prevents collapsed tabs from dominating overview zoom.

**15. Nested-group visual depth.** `containerDepth(item, items)` walks parent chain. Background darkens (`0.92 − 0.06×depth × 0.3`) and dashed-border alpha strengthens with depth. Border width floored at 2 world-px.

**16. Sub-group dropdown in container header.** New `SubGroupMenu` component in [`ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx) — shown only when container has direct child containers. Click icon → popover lists sub-groups with names + counts. Click a sub-group → `SET_FOCUSED_CONTAINER`.

**17. Persistent group auto-naming.** `nextGroupNumber: number` added to CanvasState, initial 1, monotonic (never decrements on rename/delete). `INCREMENT_GROUP_COUNTER` action. Persisted via [`anyFormat.ts`](../src/canvas/file/anyFormat.ts). `LOAD_FILE` deserializes and falls back to `max(existing "Group N") + 1` on legacy files.

**18. Window bounds persistence.** [`electron/main.ts`](../electron/main.ts) now writes bounds to `userData/window-bounds.json` on `moved`/`resize` (400ms throttled), loads on `createWindow`, and clamps via `clampBoundsToDisplay` before applying to catch off-screen saves (e.g. unplugged monitor).

**19. Editable zoom percentage + Fit + 1:1 buttons in status bar.** New `ZoomControl` component in [`KlypixCanvas.tsx`](../src/canvas/KlypixCanvas.tsx). Zoom wheel sensitivity reduced from `0.0015` → `0.0008` (~8% per tick vs. the old 14%) — finer control, more scrolls for big traversals.

**20. Proportional scaling corner handles on drawings.** New [`DrawingResizeHandles.tsx`](../src/canvas/interaction/DrawingResizeHandles.tsx). 8 handles; edge drag = one-axis stretch, corner = proportional scale from opposite anchor (stroke width scales with max(scaleX,scaleY)), Shift+corner = free stretch. Rendered only when exactly one drawing and no items are selected.

**21. Outline sidebar includes drawings.** Synthetic `DrawingEntry` type; `topLevelDrawings` + `drawingsByParent` aggregations. OutlineRow child-count badge shows `items + drawings`. New DrawingRow renders lines (Minus icon) and strokes (PenTool icon) with click-to-jump via SELECT_LINES / SELECT_STROKES + fitToViewport.

**22. Minimap collapse-hide + drawings + tab-mode rendering.** Minimap transitively hides items/drawings under collapsed containers (same walk as CanvasRenderer). Draws lines/strokes as small bbox rects. Containers in tab-mode render at their collapsed dimensions (tab width × TITLE_BAR_HEIGHT) matching on-canvas visuals.

### Files touched heavily

- [`src/canvas/state/canvasStore.tsx`](../src/canvas/state/canvasStore.tsx) — SELECT_LINES/STROKES, UNGROUP_CONTAINER, INCREMENT_GROUP_COUNTER, `expandDoomedWithEmptiedContainers`, nextGroupNumber, LOAD_FILE migrations.
- [`src/canvas/items/types.ts`](../src/canvas/items/types.ts) — DrawnLine/FreehandStroke gained `parentId` + `authoredInParent`.
- [`src/canvas/items/ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx) — vector-scale extended to drawings, capsule scaling, depth-based contrast, SubGroupMenu, `getCollapsedMinScreenWidth`, countChildren signature.
- [`src/canvas/interaction/useCanvasInteraction.ts`](../src/canvas/interaction/useCanvasInteraction.ts) — hitTestLine/Stroke/Bounds helpers, unified move drag (items+lines+strokes+originals), marquee includes drawings, drawing parent in drag, focus-mode filter, auto-expand walks drawings, pen/line tools set focusedId as parent, tryOpenItem dblclick dispatch.
- [`src/canvas/interaction/useKeyboardShortcuts.ts`](../src/canvas/interaction/useKeyboardShortcuts.ts) — Ctrl+G gate on selection, Ctrl+G/Ctrl+Shift+G group/ungroup, Cut expands to descendants, Delete covers all selection buckets.
- [`src/canvas/CanvasRenderer.tsx`](../src/canvas/CanvasRenderer.tsx) — tabModeContainers set, drawings render order (after items, before headers), visibleLines/Strokes filter, DrawingResizeHandles mount.
- [`src/canvas/interaction/DrawingResizeHandles.tsx`](../src/canvas/interaction/DrawingResizeHandles.tsx) — NEW, 8-handle scale-from-anchor component.
- [`src/canvas/items/itemOpen.ts`](../src/canvas/items/itemOpen.ts) — NEW, universal dblclick "open" dispatcher.
- [`src/canvas/items/FileItem.tsx`](../src/canvas/items/FileItem.tsx) — `openFileExternally` exported.
- [`src/canvas/items/CanvasLinkItem.tsx`](../src/canvas/items/CanvasLinkItem.tsx) — new `openCanvasLink(filePath)` imperative export.
- [`src/canvas/interaction/ContextMenu.tsx`](../src/canvas/interaction/ContextMenu.tsx) — Ungroup menu entry, `hasSelection` covers all buckets.
- [`src/canvas/KlypixCanvas.tsx`](../src/canvas/KlypixCanvas.tsx) — groupSelection/ungroupSelection, empty-container sweeper, ZoomControl status bar, delete routes all four buckets.
- [`src/canvas/layout/OutlineSidebar.tsx`](../src/canvas/layout/OutlineSidebar.tsx) — DrawingEntry synthetic rows, DrawingRow, drawingsByParent.
- [`src/canvas/layout/Minimap.tsx`](../src/canvas/layout/Minimap.tsx) — transitive hide walk, drawings render, tab-mode dimensions.
- [`src/canvas/file/anyFormat.ts`](../src/canvas/file/anyFormat.ts) + [`src/canvas/file/useAnyFile.ts`](../src/canvas/file/useAnyFile.ts) — nextGroupNumber serialize/deserialize.
- [`src/canvas/agent/canvasToolExecutor.ts`](../src/canvas/agent/canvasToolExecutor.ts) — resolveAgentCardPosition + wiring into canvas_create_card / canvas_create_text.
- [`electron/main.ts`](../electron/main.ts) — loadWindowBoundsFromDisk / saveWindowBoundsToDisk / clampBoundsToDisplay.

### Key constants (tune without re-litigating)

```
Zoom wheel coefficient            = 0.0008   // ~8% per mouse tick (was 0.0015)
MIN_COLLAPSED_SCREEN_PX           = 150      // legacy, still exported
MIN_COLLAPSED_SCREEN_PX_EXTREME   = 60       // floor at zoom → 0.01
MIN_COLLAPSED_SCREEN_PX_BREAKPOINT= 0.1      // lerp starts below this zoom
EMPTY_CONTAINER_GRACE_MS          = 2000     // sweeper protection for fresh groups
ZOOM_MIN_PCT / ZOOM_MAX_PCT       = 2 / 400  // editable percentage clamp
capsule font floor / natural size = max(7, 13*s) / max(6, 11*s) / max(6, 12*s)
                                             // tab-mode header font/count/icon
Window bounds throttle            = 400ms
```

### Known watchouts / edge cases

- **B2 header overlap at extreme zoom** — clamp approach is partial. The full body-relative coordinate rewrite + `.any` migration is still deferred. Comment in code flags it.
- **Agent position override** — ignores the LLM's x/y when a selection exists. If agent wants to create a structured layout with specific positions (e.g. diagram), this will anchor everything next to the selection. Revisit if agent tool output degrades.
- **Drawings vector-scale is first-resize-seed.** A drawing that enters a container but never triggers a resize has no `authoredInParent`. The effect seeds on first resize — positions are preserved, but until then a drag-end reseed is the only trigger.
- **onPointerUp container-drag now pulls drawings along.** Works via `ancestorIsDragged` walk. Cycle-defense `seen` set guards against corrupted circular parentIds.
- **Capsule scaling applies only in tab mode.** Expanded headers still use titleScale floor. If a narrow expanded container shows cramped chrome, revisit.
- **Drawing `authoredInParent` seed uses current world coords × invScale on first run.** If container has scaled very far from authoredW/H already, the seed is correct but children may jump slightly on FIRST resize as the anchor gets set.
- **Nested group navigation submenu** — sub-group menu only shows direct child containers. No breadcrumb integration; Breadcrumbs component still handles up-navigation.

### What NOT to re-touch

- Don't revert drawings' `parentId` — the whole group-contains-drawings story depends on it.
- Don't change Ctrl+G priority order: selection-check first, agent-jump is the fallback.
- Don't change `hiddenByCollapse` / `tabModeContainers` split in CanvasRenderer — direct-child drawing hide depends on the two sets being separate.
- Don't pass bare `state.selectedIds` to DELETE_ITEMS for cut — always expand descendants first.
- Don't collapse the capsule-scale and titleScale paths into one. Tab mode explicitly overrides with capsule; expanded explicitly uses titleScale floor.
- Don't bypass `resolveAgentCardPosition` in agent create-card / create-text tools — stale LLM coords will strand responses off-screen.
- Don't change `MIN_COLLAPSED_SCREEN_PX` constant name/export — still referenced by legacy code paths.

### Still open / deferred

- **B2 full coordinate-system rewrite** — body-relative positioning with `.any` migration. Current clamp holds common cases.
- **Corner handle tuning on drawings** — not tested under runtime; drag math preserved here may need polish.
- **Drawings vector-scale under heavy resize churn** — the seed-on-first-run path hasn't been exercised at extreme scales. Watch for stroke-point drift after many cycles.
- **Agent position when no selection + LLM x/y is on-screen** — falls through to LLM coords. Could argue for always-viewport-center; left as LLM-respecting for now.

---

## 2026-04-17 session — container/zoom/paste overhaul (22 commits, 6ebf7674 → 5f2a691f)

Big session. Compressed as "what's locked in now, don't re-litigate."

### Architectural decisions locked

**1. Container collapse data model.** `w` and `h` on a ContainerItem ALWAYS represent the expanded dimensions; they are NEVER mutated while collapsed. Tab width is cosmetic, stored on `collapsedW?: number` — independent. Expand is a pure `collapsed: false` flag flip; no restore math because nothing was lost.

- First collapse seeds `collapsedW = max(MIN_COLLAPSED_W, w)`. Subsequent collapses preserve user's tab width.
- `MIN_COLLAPSED_W = 150` world-px floor + `MIN_COLLAPSED_SCREEN_PX = 150` screen-px floor via `getCollapsedRenderW(item, zoom)` — tab never renders below 150 screen-px.
- `ResizeHandle` gained a `widthField?: 'w' | 'collapsedW'` prop. Collapsed tab drags route to `collapsedW`; expanded drags route to `w`. With `lockHeight: true` for collapsed, `h` is never touched either.

**2. Render mode = f(state, zoom).** New `getContainerRenderMode(item, zoom): 'expanded' | 'collapsed' | 'collapsed-visual'` in [`ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx). `collapsed-visual` = "state is expanded but body screen-h < `BODY_VISIBILITY_THRESHOLD` (40 px), render as tab without mutating state." Zooming back in flips mode to `expanded` automatically; lossless round-trip. Children are hidden in both tab modes. Every render path (frame, header, chevron, resize handle, selection ring, rename hit-test, hiddenByCollapse) routes through the mode helper.

- Chevron click is mode-aware: `expanded`→collapse, `collapsed`→expand, `collapsed-visual`→`animateView` to reveal body (state stays untouched).

**3. Vector-scale anchors include stroke properties.** `authoredInParent` now stores `borderWidth` for boxes (alongside `fontSize`/`authoredWidth` for text). Backfilled on legacy containers via a migration branch. Children scale uniformly via `scale = min(scaleW, scaleH)` — prevents non-uniform container aspects from pushing children outside the frame.

**4. Selection ring = screen-space overlay.** Rendered outside the pan/zoom transform, constant 1-px dashed + 2-px emerald shadow at every zoom. Collapsed containers' rings use `getCollapsedRenderW` for width and the floored title-bar height for height. Editing items skip the ring (the textarea's own cursor is the indicator).

**5. Header readability floor.** `computeContainerScales(item, zoom)` returns two scales: `groupScale` (pure vector, drives the frame) and `titleScale` (groupScale floored at 28 screen-px minimum, drives header height/font/padding/chevron). Body stays proportional; header chrome stays readable at low zoom.

**6. Counter-zoom authoring, capped `[0.5, 40]`.** `getAuthoringCounterZoom(zoom)` in ContainerItem. Applied at CREATION TIME to:
- Text `fontSize` and default `w` (T-tool click, box-to-text conversion, OS text paste)
- Box `borderWidth`
- Line `width`
- Pen stroke `width`
- Connect/arrow `width`

At 100% zoom the cap is 1 (unchanged baseline). At 2% zoom the cap hits 40, producing 640 world-px fontSize that renders at ~13 screen-px. At 250%+ the floor of 0.5 kicks in. Text inside a focused container multiplies `counterZoom × groupScale` so new siblings match existing ones.

**7. Paste = viewport-center + target-screen-px, view never changes.** `RULE 1` paste at viewport center. `RULE 2` scale entire source bounding box so its width renders at `TARGET_PASTE_SCREEN_W = 300` screen-px. `RULE 3` zoom+pan never change during paste — removed the earlier `autoZoomForAuthoring` call.
- **Acceptable-range short-circuit**: if the source bounding box's current rendered width is in `[100, 600]` screen-px, paste 1:1 (no scaling). Normal zoom → comfortable source = pure duplicate.
- Repeat-paste stagger: `20 / zoom` world-px offset per repeat, resets after 2 s idle.
- ID remap for parents + connections. Intra-selection connections survive; boundary-crossing ones drop.
- Containers re-seed `authoredW/H` on scaled pastes; preserve source baseline on 1:1 pastes.

**8. No automatic zoom changes on user actions.** `autoZoomForAuthoring` is effectively dead — removed from T-tool click, box/line/pen pointer-down, paste. The `viewAnimate.ts` infra stays for the one deliberate gesture that still uses it: chevron click on `collapsed-visual` containers (user asked to reveal body). Any active tween is cancelled on any `onPointerDown` / `onWheel` — user input always wins.

**9. `overflow: clip` on App wrappers.** Replaced `overflow-hidden` in [`App.tsx`](../src/App.tsx) — `hidden` is still scrollable via `scrollIntoView` which was pushing the whole app sideways when a canvas textarea caret grew past viewport. `clip` doesn't create a scroll container at all. Also added a window-level scroll-reset listener as a safety net.

**10. Screen-space resize floor.** `ResizeHandle` enforces `minScreenPx = 20` at any zoom (via `minW` being floored at `20/zoom`). Plus proportional content scaling on corner drags: `fontSize` (text) and `borderWidth` (box) scale with `nw/d.w` on corner drags so content tracks the frame. Edge drags stay reflow-only.

**11. Title dblclick rename bulletproof.** Span's own `onPointerDown` tracks a manual dblclick timer (450 ms) with `stopPropagation` + `preventDefault` on the second click. Native `onDoubleClick` stays as fallback. Surface hit-test uses `titleScale × TITLE_BAR_HEIGHT` (not constant 28) so the title area accepts dblclicks at any zoom. In tab mode (collapsed / collapsed-visual) the whole tab is the title area.

**12. Tab-mode hit priority.** A pre-pass in `onPointerDown` iterates containers in reverse z-order and returns the first whose RENDERED tab rectangle contains the click. Fixes "can't drag the tab at 2% zoom because a hidden child overlaps it." Only runs outside focus mode.

**13. First-launch keyboard focus.** Canvas surface has `tabIndex={0}` + `overflow:'none'`, plus a mount-time `requestAnimationFrame(() => surface.focus())`, plus `onPointerDown` re-focus on every click. Fixes the cold-start "typing does nothing until you click a real input first" case.

**14. Copy captures connections.** `performCanvasCopy` now also snapshots intra-selection connections into `canvasClipboard.connections`. Paste remaps both endpoints.

**15. Canvas clipboard ownership flag.** `canvas:claim-clipboard` IPC + main-side `canvasOwnsClipboard` flag absorbs one self-change (our own `writeText`) and flips on external change. Paste reads the flag instead of racing the 400 ms poll. Prevents stale screenshots from hijacking canvas-item duplicate paste.

**16. PDF card small-size dot mode.** FileItem switches to a centered extension pill when rendered width OR height < 50 screen-px. `onError` fallback on the PDF preview `<img>` drops back to the baseline `previewDataUrl` if hi-res decode fails.

**17. Text editing UX.** `fieldSizing: 'content'` on the textarea; `ResizeObserver` during edit syncs `item.w/h` from the live textarea so blur commits the typed width. Removed the 800 px maxWidth cap on plain text — text stays as typed unless user resizes after. Selection ring hidden while editing.

**18. Font size uncapped.** `scaleField.max` on plain text was 200. Raised to 100000 (effectively uncapped) so banners / headings can grow freely.

### Files touched heavily

- [`src/canvas/items/ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx) — render mode, compute scales, counter-zoom helpers, frame + header split.
- [`src/canvas/interaction/ResizeHandle.tsx`](../src/canvas/interaction/ResizeHandle.tsx) — lockHeight, widthField, screen-space floor, content scaling.
- [`src/canvas/interaction/useCanvasInteraction.ts`](../src/canvas/interaction/useCanvasInteraction.ts) — tab-mode hit priority, counter-zoom on creation, dblclick rename, cancel animation on input.
- [`src/canvas/interaction/useKeyboardShortcuts.ts`](../src/canvas/interaction/useKeyboardShortcuts.ts) — paste rewrite, connections copy, ownership flag.
- [`src/canvas/CanvasRenderer.tsx`](../src/canvas/CanvasRenderer.tsx) — screen-space selection ring, mode-based render, header top-layer.
- [`src/canvas/interaction/viewAnimate.ts`](../src/canvas/interaction/viewAnimate.ts) — new helper, cancel-on-input.
- [`src/canvas/items/FileItem.tsx`](../src/canvas/items/FileItem.tsx) — dot mode, PDF onError fallback.
- [`src/canvas/items/TextItem.tsx`](../src/canvas/items/TextItem.tsx) — textarea ResizeObserver, no maxWidth cap.
- [`electron/main.ts`](../electron/main.ts) + [`electron/preload.ts`](../electron/preload.ts) + [`electron/canvas/anyFileHandler.ts`](../electron/canvas/anyFileHandler.ts) — clipboard ownership + L1 lazy-asset IPC.
- [`src/App.tsx`](../src/App.tsx) — `overflow: clip`, scroll-reset.

### Key constants (tune without re-litigating the design)

```
BODY_VISIBILITY_THRESHOLD      = 40   // screen-px, collapsed-visual trigger
MIN_COLLAPSED_W                = 150  // world-px, tab state minimum
MIN_COLLAPSED_SCREEN_PX        = 150  // screen-px, tab render minimum
AUTHORING_MIN_COUNTER_ZOOM     = 0.5  // counter-zoom floor
AUTHORING_MAX_COUNTER_ZOOM     = 40   // counter-zoom ceiling (was 16, bumped for readability)
TARGET_PASTE_SCREEN_W          = 300  // screen-px, paste target when out of range
PASTE_ACCEPTABLE_MIN           = 100  // screen-px, below this the paste rescales
PASTE_ACCEPTABLE_MAX           = 600  // screen-px, above this the paste rescales
PASTE_OFFSET_SCREEN_PX         = 20   // screen-px, repeat-paste stagger
MIN_SCREEN_PX                  = 20   // ResizeHandle: item can't shrink below this
```

### Still open (not this session)

- **Priority 2 slice B** — migrate `ImageItem` / `VideoItem` / `AudioItem` / `FileItem` to use `readLazyAsset` (scaffolding shipped in `c46a11ef`; items still eager-hydrate).
- **L1 metadata-only load path** — `loadAnyFile` still extracts all `assets/*` bytes eagerly; needs a flag to return paths + mime + size without bytes.
- **L4 viewport-driven extract + evict** (LRU over the registry).
- **Save-side pass-through** for unchanged assets when renderer hasn't hydrated them.
- **Save-side sha1 manifest** already shipped earlier (`2026-04-16` L11 delta). Lazy load stack continues from there.

### What NOT to re-touch

- Don't re-add `autoZoomForAuthoring` anywhere except the `collapsed-visual` chevron reveal.
- Don't make paste change view (Rule 3 is load-bearing).
- Don't put the rename dblclick back on the native `onDoubleClick` alone — the pointer-capture race is real; keep the manual span detector.
- Don't couple `collapsedW` to `w` again — they're independent by contract.
- Don't touch `authoredInParent` field order or rename — the vector-scale effect depends on it being stable across saves.

---

## 2026-04-17 delta — L1 lazy-asset foundation

Main-side groundwork for spec §23 L1 ("lazy open — don't eager-hydrate every asset byte on `canvas:open`"). **Foundation only — item components still use eager hydration; subsequent slices will migrate them one-by-one to read lazily.** Shipping the infra now so the big-file scenarios have a path that doesn't require refactoring every consumer in one go.

What landed:

- **`readAssetBytes(filePath, assetPath)`** in [`electron/canvas/anyFileHandler.ts`](../electron/canvas/anyFileHandler.ts). Module-level `anyZipCache` keyed by filePath + mtime retains the parsed JSZip so repeat reads skip the parse cost. Cache invalidates on save (mtime changes) and can be explicitly evicted via `evictZipCache(filePath)` when a tab closes.
- **IPC `canvas:read-asset`** (main) and `window.electron.canvas.readAsset({ filePath, assetPath })` (preload). Returns `{ ok, base64, mime, size }` — size so future L10 budget logic can bail on very large ones. Path guard: rejects anything not under `assets/`.
- **IPC `canvas:evict-asset-cache`** for tab-close cleanup.
- **`readLazyAsset({ id, filePath, assetPath, fileName })`** helper in [`src/canvas/file/assetRegistry.ts`](../src/canvas/file/assetRegistry.ts). Short-circuits on already-hydrated entries; otherwise pulls bytes via IPC and `registerAsset()`s them. Item components call this when they need bytes on-demand.
- `loadAnyFile` now seeds the cache as a side effect so the first post-open lazy read has a warm ZIP.

Not done yet (each a follow-on slice):
- **Load path returning metadata-only** for lazy items. Today `loadAnyFile` still eager-extracts all `assets/*` bytes. To unlock the open-time win, the load path needs a "metadata-only" mode that returns paths + mime + size but not base64. ImageItem/VideoItem/AudioItem then use `readLazyAsset` when they actually mount.
- **L4 viewport-driven extract + evict.** LRU over the registry, keyed by last-viewed time.
- **Save-side pass-through.** When an asset is unchanged (sha1 matches manifest) AND not hydrated in the renderer, save should copy the entry from the source ZIP directly instead of demanding bytes from the renderer. Requires renderer→main coordination on "which ids are still unchanged".

The handoff's "recommended execution order" slides one step: L1 scaffolding → L1 item migration → L4 LRU → import paths.

---

## 2026-04-17 delta — container/group system rewrite

Five interconnected bugs in the container/group rendering + clipboard layer, fixed in one coordinated pass. Each had accumulated its own patch; the patches had started fighting each other. Summary of what changed and why:

- **Selection ring moved to a screen-space overlay.** `CanvasRenderer.tsx` used to draw a universal ring *inside* the pan/zoom transform with a counter-zoom (`ceil(1/zoom)`) border width. At extreme zooms the math produced thick world-px borders whose dash pattern, border-radius, and SVG AA looked wrong relative to normal zoom. Now there's a second sibling layer outside the transform — `selRects` is computed each render from `worldToScreen(item)` — drawing a constant 1-px dashed border + 2-px emerald shadow at all zoom levels. Individual items' own in-body selection CSS (FileItem/LinkItem/etc. `boxShadow`) is left alone; only TextItem's world-px ring was dropped because it was the specific case the user called out. See [`src/canvas/CanvasRenderer.tsx`](../src/canvas/CanvasRenderer.tsx) and [`src/canvas/items/TextItem.tsx`](../src/canvas/items/TextItem.tsx).

- **Canvas copy/paste ownership via main-process flag.** The paste handler in `useKeyboardShortcuts.ts` used to pick `lastFormat` ('text' | 'image') from the 400ms clipboard poll. Ctrl+C on canvas items would write text via `navigator.clipboard.writeText` but that's async, so a fast Ctrl+V could read stale `lastFormat: 'image'` and paste the previous screenshot instead of duplicating the canvas items. Fixed with `canvas:claim-clipboard` IPC in [`electron/main.ts`](../electron/main.ts): renderer calls it before writing, main sets `canvasOwnsClipboard = true`, `pollClipboard` absorbs one self-change and flips the flag off on subsequent external changes. The paste handler just checks `res.canvasOwnsClipboard` — no sequence-number math, no race. See [`src/canvas/interaction/useKeyboardShortcuts.ts`](../src/canvas/interaction/useKeyboardShortcuts.ts) — `performCanvasCopy` and `duplicateFromCanvasClipboard`.

- **Collapsed group now has all 8 resize handles, corners only affect width.** Previously only e/w. User wanted corner reach. New `lockHeight?: boolean` prop on `ResizeHandle`: when true, dispatch forces `ny = cur.y, nh = cur.h` from the store state after the drag math, regardless of which handle dragged or whether aspect-lock would have changed h. Collapsed containers pass `lockHeight: true` + `handles` = all 8. See [`src/canvas/interaction/ResizeHandle.tsx`](../src/canvas/interaction/ResizeHandle.tsx).

- **Scale → collapse → expand cycle now restores the full pre-collapse layout.** Root cause: `expandedW` was saved on collapse but `expandedH` wasn't. ResizeHandle's captured `d.h` at pointerdown on a collapsed container was the *visual* `titleBarH`, so dragging the tab would dispatch `h = titleBarH` — clobbering the real expanded-state h. On re-expand, w was restored but h was the stale titleBarH, so the vector-scale effect re-derived children against a nonsense scale. Fix is dual: (1) `ContainerItem` type gains `expandedH?: number`, saved on collapse and restored on expand; (2) the collapsed resize uses `lockHeight: true` so h never gets clobbered in the first place. Belt + suspenders. See [`src/canvas/items/types.ts`](../src/canvas/items/types.ts) and [`src/canvas/items/ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx).

- **Group header split from the frame, rendered in a top-layer after items.** `ContainerItemView` was one component that rendered both the background-frame AND the title bar. Title bar lived inside the frame div, which rendered *before* child items, so children with y-coords near the top of the container could visually cover the title bar. Solution: split into `ContainerItemView` (frame only) and `ContainerHeaderView` (title bar + resize handles). `CanvasRenderer` renders all items first, then a second pass maps visible containers to `ContainerHeaderView` — always on top. Two chrome scales: `groupScale` (no screen-px floor, used for frame border/radius — shrinks with the group) and `titleScale` (with min-screen-px floor for readability, used for header only). This matches the spec's intent: header is "chrome on top"; frame is "part of the picture". See [`src/canvas/items/ContainerItem.tsx`](../src/canvas/items/ContainerItem.tsx).

No spec behavior changed — only internal structure + correctness. The vector-scale `authoredInParent` model is untouched; all the fixes live in the chrome/clipboard/ring layers on top.

---

## Full spec audit — what's still unbuilt (2026-04-16)

After 14 shipped slices, ~65% of `docs/CLAUDE-KLYPIX-CANVAS.md` is implemented. Below is the authoritative punch list of everything still missing, grouped by priority. Items marked `[spec §N]` point to the section of CLAUDE-KLYPIX-CANVAS.md that defines them.

### A. Missing media item types (unlocks Phase 3 of the spec)
- ~~**VideoItem**~~ **DONE 2026-04-16** — inline HTML5 `<video>` card with poster frame captured at drop (~10% duration), play/pause + scrub bar, mute toggle, `currentTimeSec` persisted on scrub. Streams via blob URL from asset registry; bytes live in the .any ZIP's assets/ folder. 500 MB cap — over that it falls through to generic FileItem.
- ~~**AudioItem**~~ **DONE 2026-04-16** — player card with WebAudio-decoded waveform (~200 peaks), click-to-seek, resume position. Same streaming + asset storage strategy as VideoItem.
- ~~**CodeItem**~~ **DONE 2026-04-16** — inline editable code card. Regex-based syntax highlighter (js/ts/py/bash/sql/go/rust + json), Copy/Edit/Run in header. Run button dispatches sandbox execute for python/bash/js and pins stdout/stderr back onto the card. Pencil toggles between highlighted view and raw textarea. 256 KB cap; above that the file stays a FileItem.
- **PPTX live card** (spec §21) — slide navigator. Rendering requires LibreOffice in sandbox (slide → image). MPP Gantt, Visio, MSG/EML cards — each its own dedicated item type per §21.

### B. Missing agent commands (Phase 4 / §20B / §24)
- ~~`/compile into PDF | DOCX | PPTX | ZIP`~~ **DONE 2026-04-16**: new `canvas_compile` tool. Items sorted spatially (row-buckets by y, then x), mapped to format-specific specs (PDF via markdown → existing pdfGenerator; DOCX → sections; PPTX → layout slides), ZIP built renderer-side with JSZip. Result pinned as a FileItem with its bytes in the .any asset registry. IPC: `canvas:compile-bytes` (main-process bridge to existing docx/pptx/pdf generators, returns raw bytes — no save dialog). Email format deferred (needs SMTP/mailto flow).
- ~~`/organize by type | tag | status | date | connection`~~ **DONE 2026-04-16**: `canvas_organize` tool buckets items, wraps each bucket in a container with an auto-generated title, grids items inside, and rows containers left-to-right. Reparents items.
- ~~`/cleanup` / `/find orphans / untagged`~~ **DONE 2026-04-16**: `canvas_find_issues` tool returns structural issue categories (orphans, untagged, exact-content duplicates, near-alignments within 8 world px) without mutating. Agent can follow up with tag/connect/position fixes. "near X" / "path from A to B" spatial search still deferred.
- `/show progress` / `/update status` / `/critical path` / `/show dependencies` (§24K, §24L) — work off status + relationship-type fields (both already present in state).

### C. Unbuilt multi-axis polish (Phase 5/6)
- **Export canvas → PDF / PNG** (Phase 5 finale). Distinct from presentation mode.
- **Screen recording** (§22A) via `desktopCapturer`.
- ~~**Snap & alignment guides** (§20Q)~~ **DONE 2026-04-16** — per-edge + per-center snap during move drags, 6-world-pixel threshold scaled by zoom, magenta dashed guide lines. See [`snapGuides.ts`](../src/canvas/interaction/snapGuides.ts).
- ~~**Breadcrumbs for nested containers** (§22B)~~ **DONE 2026-04-16** — top-center trail when focused-into a container, click any segment to hop focus, click Root to exit.
- **Outline sidebar drag-reorder** (§22B) — data model supports it; sidebar doesn't yet. (Still deferred — needs drop-zone UI + parent reassignment + z-index recompute.)
- ~~**Hierarchy view toggle** (Ctrl+H, §24J)~~ **DONE 2026-04-16** — Ctrl+H toggles OutlineSidebar. Sidebar already shows an indented tree; "two-way sync" is implicit (clicking a row jumps + selects, changes in the canvas re-render the tree on next render).
- **Favorites bar** (§24F) — pin items, always visible, max 10.
- **TOC card** (§24E) — auto-generated from containers + headings, live-updating.
- **Stacks** (§24B) — multiple items same position, tab through. Right-click "Stack these".
- **Change tracking + @mentions** (§22D) — detect modifications across sessions, highlight changed items, `@name` autocomplete in comments.
- **Light theme** — color tokens exist (`src/index.css`); needs a systematic sweep.
- **Full Arabic RTL pass** (§20M) — `dir="auto"` is set but no proper Noto Sans Arabic font, no UI-language switch, no Arabic voice setting toggle.

### D. Relationship-type visual + color-coding system (§24H, §24L)
- ~~ConnectionsLayer reads `relationship`~~ **DONE 2026-04-16** — per-type color + optional dash + midpoint glyph icon (`→ ⇠ ∼ ⚡ ✓ ? $ ✕`). Each type gets its own arrowhead marker to match. Explicit `c.color` still wins if the user has customized an individual arrow.
- ~~User-customizable status color meanings~~ **DONE 2026-04-16** — `src/canvas/items/statusColors.ts` provides `getStatusColor/setStatusColor` backed by localStorage (`klpx.canvas.statusColors.v1`). ItemBadges reads via getStatusColor. Settings UI to edit the palette is a follow-up (the plumbing is in place; just needs the picker).

### E. Import paths (§20R)
- Notion HTML/MD import
- Miro JSON import
- Folder import (each file → card)
- Clipboard/browser-tab → web embed
- Screenshot paste → auto-image

### F. Perf layers still missing (§23)
- **L1 Lazy open** — currently hydrates *all* asset bytes on `canvas:open`. Needs a lazy-extract IPC (`canvas:read-asset(filePath, assetPath)`) plus an in-main cache keyed by filePath. Critical for 5GB-file target.
- **L4 Lazy ZIP extract** — same as L1 but ongoing (evict + reload on viewport changes).
- **L7 Canvas2D text** — for 500+ text items, batch via fillText.
- **L10 Memory budget** — 500MB cap, evict least-recently-accessed full assets.
- ~~**L11 Incremental save**~~ **DONE 2026-04-16** — `saveAnyFile` now `loadAsync`-es the existing ZIP, keeps cached compressed entries for assets whose sha1 matches `_manifest.json`, and only replaces `canvas.json` + changed/new/removed assets + the new version entry. Text-only autosaves on files with lots of untouched image assets no longer re-compress them.
- **L12 Predictive preload** — background-prefetch assets for items just outside the viewport.

### G. Advanced / infrastructure (Phase 7+, explicitly deferred)
Each needs its own design pass; none are trivial:
- **Scheduled task cards** (§20O) — recurring jobs that produce cards.
- **Web monitor cards** (§20O) — watches a URL for changes.
- **Canvas zones** (auto-processing areas) — drop in zone → agent auto-runs.
- **Drag-file-onto-card = action trigger**.
- **Agent skill learning from canvas work**.
- **Two-way MS Office sync** — fs.watch on extracted temp files.
- **Plugin / extension system** — third-party item types + tools.
- **3D viewers** (§22E) — Three.js ModelItem for STL/OBJ/GLTF.
- **Replay system** (§22A) — event-log JSON inside `.any` + scrubber UI.
- **Split view** (§20S) — architectural: two viewports sharing one CanvasStoreProvider.
- **Encryption** (§20N) — JSZip AES-256, per-container locks.

### Recommended execution order for a fresh session

1. ~~**Media items** (A): VideoItem + AudioItem + CodeItem.~~ **DONE 2026-04-16.** Remaining under A: PPTX/MPP/Visio/MSG cards (each its own sandbox-rendering slice).
2. ~~**`/compile` command** (B)~~ **DONE 2026-04-16** — canvas_compile tool + canvas:compile-bytes IPC. Email format still deferred.
3. ~~**Relationship-type rendering + color-coding** (D)~~ **DONE 2026-04-16.**
4. ~~**Perf Layer 11 (incremental save)** (F)~~ **DONE 2026-04-16** — sha1-manifest-based per-entry skip.
5. **Polish pass** (C) — ~~breadcrumbs, snap guides, hierarchy Ctrl+H toggle~~ **3-of-4 DONE 2026-04-16**. Remaining: outline drag-reorder.
6. ~~`/organize` + `/cleanup` agent commands~~ **DONE 2026-04-16**. PPTX live card still open (needs LibreOffice sandbox).
7. **Remaining perf layers** (L1, L4, L10, L12).
8. **Import paths** (E).
9. **Deferred infra slices** (G) — one per session from here.

**Latest delta (2026-04-16):** Completed 8 more slices in one session:
- **Auto-tagging on drop** (§24C) — Flash suggests 1–3 tags from filename + content sample.
- **Comments panel** (§22D) — click the amber badge → thread view with add/delete.
- **Follow-up nesting** (spec §6) — thread messages render inline below bordered text cards.
- **Version history** (§20F) — per-save snapshot into `versions/` in the ZIP, sidebar to preview/restore. Cap 20.
- **Templates / stamps** (§20H, §24I) — "Save as template…" from right-click, sidebar to stamp at viewport center. localStorage.
- **Thumbnails** — per-image downscaled JPEG, swapped in at low zoom (<360px effective width).
- **Smart collections** (§24D) — tag+status aggregation sidebar, click → select + fit-to-viewport.
- **Canvas-to-canvas links** (§20E) — new `canvas-link` item type; "Link to canvas" opens a file picker, click a card spawns a tab loaded with that file.

**Still deferred** (too large for one-session slices; each needs its own design pass):
- **3D viewers** (§22E) — needs Three.js integration + new ModelItem.
- **Replay system** (§22A) — event-log infrastructure across all actions.
- **Split view** (§20S) — architectural change: two viewports sharing one store.
- **Encryption** (§20N) — security-sensitive; needs a proper key-management design.
- **MS Office native** (PPTX / MPP / Visio / MSG/EML from §21) — each requires a sandbox-side renderer. DOCX landed via mammoth; XLSX full edit, PPTX, and MPP still defer.

**Previous session deltas (2026-04-15):**
- Slice 1 (assets/ migration) landed. Image + file bytes now live in the `.any` ZIP's `assets/` folder, not as data URLs in `canvas.json`. Renderer-side registry: [`src/canvas/file/assetRegistry.ts`](../src/canvas/file/assetRegistry.ts). Hydrated eagerly on load. Old `.any` files still open (legacy `ImageItem.src` data URL is the fallback). Thumbnails still deferred.
- `canvas_read_file` agent tool now actually extracts text: PDF (pdfjs), DOCX (mammoth raw text), XLSX/CSV (CSV dump of every sheet), any text-like extension (UTF-8 decode). Cap 40K chars. `executeToolCall` is now async.
- FileItem "Open externally" has a bytes-fallback: if `originalPath` is missing or fails, extract asset bytes to `%TEMP%\klypix-canvas-assets\` and `shell.openPath` that. New IPC `canvas:open-asset-bytes`.
- Slice 2 (DOCX live render) landed. Dropping a `.docx` now produces a preview card with mammoth-rendered HTML (sanitized, capped at 80K chars) + word count. Mammoth is in its own lazy Vite chunk.
- Slice 3 (per-item chat threads) landed. Right-click any item → "Open chat thread" → floating panel anchored beside it. Streaming Gemini Flash chat, no tools, scoped to ONLY that item (file content auto-included from preview / asset bytes). Thread persists in the item's `thread?: ThreadMessage[]` field, serialized inline in `canvas.json`. Badge in [`ItemBadges.tsx`](../src/canvas/items/ItemBadges.tsx) shows turn count. New: [`canvasThread.ts`](../src/canvas/agent/canvasThread.ts), [`ChatThread.tsx`](../src/canvas/interaction/ChatThread.tsx).
- Slice 4 (multi-canvas tabs) landed. Entry [`KlypixCanvas.tsx`](../src/canvas/KlypixCanvas.tsx) now mounts one `CanvasStoreProvider` per tab; inactive tabs stay mounted (display:none) so state survives switching. New [`TabBar.tsx`](../src/canvas/tabs/TabBar.tsx) with +/×/middle-click-close, dirty dots, close-prompt. Keyboard shortcuts + file-open IPC + autosave-restore prompt gated on `tabActive`. Asset registry gains `clearAssetsForIds()` so NEW_FILE / LOAD_FILE on one tab no longer wipes another tab's blob URLs.
- Slice 5 (sandbox agent tools, 3-of-4) landed. Three new Gemini function declarations: `canvas_run_code` (py/bash/node, 30s timeout, pins source+output card), `canvas_pin_file` (reads sandbox file → FileItem with asset bytes; preserves PDF/DOCX/XLSX rich previews when the item later re-renders — though note the preview is generated on DROP, not on pin, so agent-pinned PDFs show icon only until a future slice adds on-pin preview generation), `canvas_pin_image` (png/jpg/etc → ImageItem with natural dims). New IPC `canvas:read-sandbox-file-bytes` in [`electron/main.ts`](../electron/main.ts) bridges sandbox → Windows temp → base64.
- Slice 6 (`canvas_create_approval`) landed. New ApprovalItem type, [`ApprovalItem.tsx`](../src/canvas/items/ApprovalItem.tsx) with tone-aware buttons (Approve/Yes→emerald, Deny/No→red, other→neutral). [`approvalRegistry.ts`](../src/canvas/agent/approvalRegistry.ts) bridges the button click to the agent's awaiting Promise; tool blocks up to `timeout_seconds` (15–900, default 180) and returns `{ decision, status: 'resolved' | 'timeout' | 'cancelled' }`. Resolved cards stay on canvas with a "Chose X" footer. This closes the handoff's sandbox-tools slice (was "3-of-4" → **4-of-4**).

---

## 1. What's built (directory map)

All canvas code lives under `src/canvas/` (renderer) and `electron/canvas/` (main).

```
src/canvas/
├── KlypixCanvas.tsx                    # entry point, mounts provider + all panels
├── CanvasEngine.ts                     # pure: screen↔world math, hitTest, itemsBounds, fitToViewport
├── CanvasRenderer.tsx                  # transform layer, viewport culling, hidden-layer filter
├── items/
│   ├── types.ts                        # CanvasItem union + Connection + DrawnLine + FreehandStroke + Comment
│   ├── TextItem.tsx                    # controlled textarea; dir="auto" for RTL; Ctrl+B/I
│   ├── BoxItem.tsx                     # rect/circle/triangle/diamond via SVG; double-click → container
│   ├── ImageItem.tsx                   # inline <img> with ResizeHandle (aspect preserved)
│   ├── FileItem.tsx                    # generic card + PDF preview + XLSX table + Open-externally
│   ├── ContainerItem.tsx               # titled frame, collapse, scopeLock, drags children
│   └── ItemBadges.tsx                  # status dot / tag pills / comment count (world-coords overlay)
├── drawing/
│   ├── ConnectionsLayer.tsx            # one <svg> for all connection bezier paths
│   └── DrawingLayer.tsx                # user lines + freehand strokes (quadratic smoothing)
├── file/
│   ├── anyFormat.ts                    # CanvasDocumentV1 serialize/deserialize (additive fields)
│   ├── dropHandler.ts                  # File→Item: images, PDF first-page (pdfjs-dist), XLSX (xlsx)
│   └── useAnyFile.ts                   # new/open/save/saveAs, 30s autosave, crash-recovery mount
├── state/
│   └── canvasStore.tsx                 # useReducer + React context; undo/redo w/ pushSnapshot/popLastSnapshot
├── interaction/
│   ├── useCanvasInteraction.ts         # pointer/wheel handlers; drag kinds: pan|move|draw-box|draw-line|draw-stroke|marquee
│   ├── useKeyboardShortcuts.ts         # all hotkeys; takes onOpenSearch/onVoice callbacks
│   ├── Toolbar.tsx                     # left pill: T/V/B/L/P/C/E + shape + colors + widths + style popover + undo/redo
│   ├── CommandBar.tsx                  # `/` agent bar with progress + onProgress/onError callbacks
│   ├── ContextMenu.tsx                 # right-click: ask agent / duplicate / border / tag / status ▸ / comment / group / delete
│   ├── ResizeHandle.tsx                # 8-handle, zoom-aware (screen→world scale)
│   ├── SearchPanel.tsx                 # Ctrl+F
│   ├── CanvasEyes.tsx                  # KLYPIX Eyes (idle/thinking/reading/working/success/error/waiting/sleeping)
│   └── voiceInput.ts                   # Web Speech API wrapper
├── layout/
│   ├── Minimap.tsx                     # dot-per-item + viewport rect + click-to-jump
│   ├── OutlineSidebar.tsx              # tree view of items w/ filter
│   ├── LayersPanel.tsx                 # visibility + lock per layerId (content/agent/drawings/custom)
│   └── PresentationMode.tsx            # slideshow through selected items
└── agent/
    ├── canvasScopeResolver.ts          # selected → container → nearby → full_canvas; respects scopeLocked
    ├── canvasTools.ts                  # 18 Gemini function declarations
    ├── canvasToolExecutor.ts           # tool name → store dispatch; SVG chart renderer for pin_chart
    └── canvasAgent.ts                  # multi-turn tool-calling loop (max 12 turns, Gemini Flash)

electron/
├── canvas/anyFileHandler.ts            # saveAnyFile / loadAnyFile (JSZip)
├── main.ts  (see end for new IPCs)     # canvas:save / save-as / open / open-by-path / open-path / autosave / check-autosave / clear-autosave / set-fullscreen / is-fullscreen
└── preload.ts                          # window.electron.canvas.{save, saveAs, open, openByPath, openPath, autosave, checkAutosave, clearAutosave, setFullscreen, isFullscreen, onFileOpened}
```

App integration: [`src/App.tsx`](../src/App.tsx) has a `ModeTabs` in the title bar switching between Chat and Canvas. Canvas renders as a full overlay (`z-[70]`) above chat when active. Title-bar maximize button does true fullscreen on Canvas tab, normal 750×980 cap on Chat tab.

---

## 2. Spec coverage (honest)

| Spec Phase | % | Gaps |
|---|---|---|
| Phase 1 (core canvas) | ~95% | — follow-up nesting on cards, draw-box→dbl-click→container done only for rects |
| Phase 2 (persistence + files) | ~70% | — assets/ bytes still embed as data URLs in canvas.json; no thumbnails/ folder; no DOCX/PPTX/MPP/Visio live render; no multi-canvas tabs |
| Phase 3 (media + navigation) | ~70% | — no chat threads per item; no video/audio item types |
| Phase 4 (agent) | ~70% | — 5 tools missing (pin_file, pin_image, run_code, create_approval, get_connections done); no follow-up nesting |
| Phase 5–8 | ~30% | — templates, version history, replay, 3D, split-view, encryption, two-way MS Office sync, plugin system |

**Perf layers (§23):** 2 of 12 fully done (Layer 2 viewport culling, Layer 9 GPU compositing). Partial L8 (single `<svg>` but individual paths).

---

## 3. Deferred — each its own slice

Ordered by recommended priority. Each is self-contained; no blocker dependencies except where noted.

1. ~~**assets/ folder migration + thumbnails** (infra).~~ **DONE 2026-04-15** for assets/ (thumbnails deferred). Remaining work for this area:
   - **Thumbnails** — `thumbnails/<assetId>.jpg` folder in the ZIP, used for off-screen low-zoom rendering. Not critical since viewport culling already skips off-screen items.
   - **Lazy extraction** — today we eagerly load all asset bytes on open. Perf Layer 4 would add an IPC like `canvas:read-asset(filePath, assetPath)` and only extract on-demand. Needs an in-memory cache in main keyed by filePath.
   - **Migrate-on-save for legacy data-URL images** — old .any files with `image.src = "data:..."` continue to load but never move to assetId. A one-shot sweep on load (detect data URL → register asset → set assetId, clear src) would shrink them on next save.
2. ~~**Follow-up nesting + chat threads**~~ **Chat threads DONE 2026-04-15** (spec §7). Remaining: **follow-up nesting** (spec §6) — a right-click "Ask follow-up" inside an existing agent card that creates a nested card *inside* the parent. Today's threads stand alone per-item; nesting would build a tree inside agent_response-type cards.
3. ~~**Multi-canvas tabs**~~ **DONE 2026-04-15.** Remaining polish (each small):
   - **Open-in-new-tab** for OS file-association drops. Today the launched path loads into the active tab, discarding its contents if dirty (same as pre-tabs behavior). Ideal UX is a new tab.
   - **Per-tab crash-recovery autosave**. All untitled tabs currently write to the same `%APPDATA%/klypix/autosave/untitled.any` — last writer wins. Fix: include tab id in the filename.
   - **Drag-reorder tabs** / detach-tab-to-window.
   - **Canvas-to-canvas links** (§20E) now becomes possible.
4. **Live MS Office rendering** (§21): ~~DOCX (mammoth)~~ **DONE 2026-04-15 (preview render + agent text extraction)**; XLSX full edit (ag-grid-ish), PPTX (LibreOffice sandbox), MSG/EML (mailparser), MPP (mpxj Java). PPTX/MPP/Visio need sandbox.
5. ~~**Missing agent tools** requiring sandbox~~ **DONE 2026-04-15** (all 4 tools).
6. ~~**Version history** (spec §20F)~~ **DONE 2026-04-16**: snapshot per save into `versions/`, sidebar to preview + restore, cap 20.
7. ~~**Comments panel** (spec §22D)~~ **DONE 2026-04-16**: badge click opens thread view with add / delete.
8. ~~**Templates / stamps** (§20H, §24I)~~ **DONE 2026-04-16**: right-click "Save as template…", Stamp sidebar to drop at viewport center (localStorage-backed, max 100).
9. **3D viewers** (§22E). Three.js inside a new `ModelItem` type for STL/OBJ/GLTF. **Deferred — needs own design pass.**
10. **Replay system** (§22A). Event-log record per session into `.any` `replay/` folder; scrubber UI. **Deferred — infrastructure-heavy.**
11. **Split view** (§20S). Two viewports of the same canvas or two files. **Deferred — architectural change to the store/provider model.**
12. **Encryption** (§20N). JSZip with AES-256 password. **Deferred — needs proper key-management design.**
13. **Perf layers 3, 4, 6, 7, 8 full, 10, 11, 12** — each a small addition once assets/ lands. Layer-level thumbnails landed 2026-04-16.
14. ~~**Auto-tagging on drop** (§24C)~~ **DONE 2026-04-16**: Flash call on drop, 1–3 short tags populated on item.
15. ~~**Smart collections UI** (§24D)~~ **DONE 2026-04-16**: aggregation sidebar with click-to-select + fit-to-viewport.
16. ~~**Canvas-to-canvas links** (§20E)~~ **DONE 2026-04-16**: new `canvas-link` item type; clicking spawns a tab preloaded with the target .any.

---

## 4. Key architectural decisions (don't re-litigate)

- **State management**: `useReducer` + React context in [`canvasStore.tsx`](../src/canvas/state/canvasStore.tsx). Not Zustand. Works fine with React.memo on item components; drag cost is O(1) per frame.
- **Undo model**: `commit()` wraps dispatch with a pre-mutation snapshot. `pushSnapshot()` captures manually before drag bursts. `popLastSnapshot()` discards a stale snapshot if the mutation turned out to be a no-op. Ctrl+Z always wins over textarea native undo (spec §14 called this a tradeoff).
- **Coords**: Items live in world coords. Transform layer applies `translate(panX, panY) scale(zoom)`. `screenToWorld` / `worldToScreen` for conversion. `ResizeHandle` divides screen deltas by `zoom` to get world deltas.
- **Viewport culling**: [`CanvasRenderer.tsx`](../src/canvas/CanvasRenderer.tsx) computes visible rect with 200px padding + 50ms debounce. Items offscreen are skipped from the map. `editingId` is always pinned so the textarea never unmounts mid-edit.
- **Agent loop**: [`canvasAgent.ts`](../src/canvas/agent/canvasAgent.ts) is provider-isolated (direct `GoogleGenerativeAI` SDK use, not the existing `ModelAdapter` chain). Reason: the existing `claudeAgent.ts` is tightly coupled to Chat-mode permissions; canvas tools need a simpler path. Multi-model routing (Claude/GLM/OpenAI) deferred.
- **File association**: `.any` registered in `package.json` `build.win.fileAssociations`. On launch with a path, main sends `canvas:file-opened` IPC; `useAnyFile` listens and opens.
- **Empty text cleanup**: sweeper in `CanvasSurface` removes any text item with empty content that isn't being edited — reliable under unmount races. Don't chase onBlur.
- **Drop handler** uses `webUtils.getPathForFile` via preload → FileItem.originalPath → "Open externally" button via `shell.openPath`.
- **Title-bar maximize button** is tab-aware: normal maximize on Chat (750×980 cap), fullscreen on Canvas (lifts cap via `setMaximumSize(0, 0)`). Auto-exits fullscreen on tab switch and on window hide so re-toggle doesn't strand the window top-left.
- **KLYPIX Eyes on canvas** is a brand-new component ([`CanvasEyes.tsx`](../src/canvas/interaction/CanvasEyes.tsx)), not the existing `src/components/KlypixEyes.tsx`. Different purpose (character on canvas vs. header mascot); keep them separate.

---

## 5. Known rough edges

1. **Image bytes as data URLs** bloat `.any` files with many images. Fix comes with assets/ migration (slice 1 above).
2. **Box→container conversion** works only for rectangular boxes (not circle/triangle/diamond). Arguably correct but the title says "Convert to container" only on rects.
3. **Voice input** auto-switches to `ar-SA` if `navigator.language` starts with `ar`. No UI to toggle mid-session.
4. **Presentation mode** doesn't animate the transition — it just jumps to each item via `SET_VIEW`. Smooth animation is spec §20G but requires tween math.
5. **Chart rendering** (`canvas_pin_chart`) is a basic hand-rolled SVG, not Chart.js. Bar/line/pie only. Legend positioning for pie is minimal.
6. **`responseClassifier.ts` was deleted** in the catch-up audit — Slice 7's tool loop bypasses it. Don't restore.
7. **Bidirectional scope-lock**: outside can't see into a locked container, but agent _inside_ a selected locked container still only sees its children — so "locked" is effectively one-way isolation for the outside case. Matches UX intent but full spec reads as bidirectional.
8. **Dirty flag after empty-placeholder sweep**: sweeper's DELETE runs through the dirty-tracking reducer, so the file shows `•` even though net state is clean. Minor.

---

## 6. Smoke test (verify before claiming things work)

```
1. Toggle to Canvas tab (top-center pill). No console errors. Empty state hint shows.
2. Click empty canvas, type "hello", press V. See text item. Drag it around.
3. B → drag a box. E → drag over pen/line strokes to erase. P → scribble. L → line. C → click A then B to connect.
4. Select items, right-click → "Group into container". Drag the container — children follow.
5. Double-click a plain rectangle → converts to container.
6. Drop a PDF from Explorer → first page renders. Drop an XLSX → table preview. Both with "Open externally" button.
7. Press / → "summarize these" with 3 text items selected → agent should call canvas_get_items → canvas_create_card → canvas_connect_items → canvas_done. Step counter visible. Eyes animate.
8. Ctrl+S → native dialog → save as test.any. Close app. Reopen. Double-click test.any in Explorer → KLYPIX opens with it loaded. (requires built installer for association to register.)
9. Ctrl+F → search. Ctrl+G → jump to last agent output. Ctrl+1 (Shift) save bookmark → Ctrl+1 jump back.
10. Bottom-left bar: Outline sidebar (expand container), Layers (toggle 'agent' off → agent items vanish), Present (arrow keys cycle slides).
```

Any failure here points to either a real regression or an environment problem (Gemini API key, Electron restart after main.ts change, etc.).

---

## 7. Next session — recommended order

1. **Start here: assets/ migration + thumbnails** (1 session). Unblocks the 3 next biggest items (PDF text extraction, DOCX live render, perf layers 3/4/6).
2. **DOCX live render** via mammoth → innerHTML in a DOCX preview card. ~half session.
3. **Follow-up nesting + chat threads** (spec §6–7). 1 session.
4. **Multi-canvas tabs**. 1 session, touches many files.
5. **Sandbox agent tools** (pin_file / pin_image / run_code / create_approval). 1 session once sandbox IPC is confirmed working.

After that the long-tail items (version history, replay, 3D, encryption, etc.) can each be tackled as a single slice in any order.

---

## 8. What NOT to do

- Don't re-add `responseClassifier.ts` — dead code from pre-tool-loop design.
- Don't touch the existing `src/components/KlypixEyes.tsx` when adding canvas Eyes features; they're intentionally separate.
- Don't route the canvas agent through the existing `ModelAdapter` chain (claude/gemini/glm/openai adapters under `src/core/agent/`) — it adds complexity the canvas doesn't need yet.
- Don't try to store binary bytes in `canvas.json` — they go in the ZIP's `assets/` folder once the migration lands.
- Don't skip full `npm run dev` restart when editing `electron/main.ts` or `electron/preload.ts` — HMR doesn't pick up either.
- Don't remove the empty-text sweeper in `CanvasSurface` — onBlur is unreliable under unmount.
