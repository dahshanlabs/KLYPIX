import React, { createContext, useContext, useMemo, useReducer, useRef, useCallback } from 'react';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import {
    type CanvasItem,
    type Connection,
    type DrawnLine,
    type FreehandStroke,
    type ViewState,
    type CanvasTool,
    type ThreadMessage,
    type ItemStatus,
    DEFAULT_VIEW,
} from '../items/types';

// --- zKey helpers (fractional indexing) ---

// Walk `order` from top down to find the topmost zKey. Used as the lower
// bound when generating a key for a new "place on top" item. Returns null
// when no item has a zKey yet (fresh canvas / pre-migration runtime add).
function topZKey(items: Record<string, CanvasItem>, order: string[]): string | null {
    for (let i = order.length - 1; i >= 0; i--) {
        const it = items[order[i]];
        if (it?.zKey) return it.zKey;
    }
    return null;
}

// Top zKey across items + lines + strokes at a given parent. Used when
// adding a drawing so the new stroke/line stacks above whatever's already
// at that parent level — items included, since v3 unifies their z-order.
function topZKeyForParent(
    items: Record<string, CanvasItem>,
    lines: Record<string, DrawnLine>,
    strokes: Record<string, FreehandStroke>,
    parentId: string | null,
): string | null {
    let max: string | null = null;
    const consider = (zk: string | undefined) => {
        if (!zk) return;
        if (max === null || zk > max) max = zk;
    };
    for (const it of Object.values(items)) {
        if ((it.parentId ?? null) === parentId) consider(it.zKey);
    }
    for (const ln of Object.values(lines)) {
        if ((ln.parentId ?? null) === parentId) consider(ln.zKey);
    }
    for (const st of Object.values(strokes)) {
        if ((st.parentId ?? null) === parentId) consider(st.zKey);
    }
    return max;
}

// Backfill zKeys for any items missing them, in order-array order. Used by
// LOAD_FILE to harden against pre-v2 files that slipped past the migration
// (hand-edited canvas.json, bugs in the loader, etc.). Items that already
// have a zKey keep theirs untouched — this is NOT a re-sort, just a fill.
function ensureZKeys(
    items: Record<string, CanvasItem>,
    order: string[],
): Record<string, CanvasItem> {
    const missingIndexes: number[] = [];
    for (let i = 0; i < order.length; i++) {
        const it = items[order[i]];
        if (it && !it.zKey) missingIndexes.push(i);
    }
    if (missingIndexes.length === 0) return items;
    // For each gap, find the keys of the nearest items before/after that
    // already have a zKey, and generate a key in between. Walking outward
    // from each gap costs O(n) total in the worst case (every item missing).
    const out = { ...items };
    for (const i of missingIndexes) {
        let beforeKey: string | null = null;
        for (let j = i - 1; j >= 0; j--) {
            const k = out[order[j]]?.zKey;
            if (k) { beforeKey = k; break; }
        }
        let afterKey: string | null = null;
        for (let j = i + 1; j < order.length; j++) {
            const k = out[order[j]]?.zKey;
            if (k) { afterKey = k; break; }
        }
        const it = out[order[i]];
        if (it) out[order[i]] = { ...it, zKey: generateKeyBetween(beforeKey, afterKey) };
    }
    return out;
}

// Re-sync zIndex AND zKey to match `nextOrder` array position. zIndex is the
// CSS render mirror (numeric, must match array index). zKey is regenerated
// across the whole array via generateNKeysBetween — simple and correct;
// future optimization can update only the moved items.
function syncOrderKeys(
    items: Record<string, CanvasItem>,
    nextOrder: string[],
): Record<string, CanvasItem> {
    if (nextOrder.length === 0) return items;
    const newKeys = generateNKeysBetween(null, null, nextOrder.length);
    const out = { ...items };
    for (let i = 0; i < nextOrder.length; i++) {
        const id = nextOrder[i];
        const it = out[id];
        if (!it) continue;
        if (it.zIndex !== i || it.zKey !== newKeys[i]) {
            out[id] = { ...it, zIndex: i, zKey: newKeys[i] };
        }
    }
    return out;
}

// --- State shape ---

export interface CanvasState {
    items: Record<string, CanvasItem>;          // id -> item
    order: string[];                            // z-order bottom → top
    connections: Record<string, Connection>;    // id -> connection (Slice 6)
    lines: Record<string, DrawnLine>;           // straight-line strokes
    strokes: Record<string, FreehandStroke>;    // freehand pen strokes
    view: ViewState;
    tool: CanvasTool;
    selectedIds: string[];
    editingId: string | null;                   // item currently in text-edit mode
    drawingId: string | null;                   // box being drawn in-flight
    color: string;                              // active color for new items
    strokeWidth: number;
    shape: 'rect' | 'circle' | 'triangle' | 'diamond';  // active shape for box tool
    lineStyle: 'solid' | 'dashed' | 'dotted';           // active line style
    opacity: number;                              // 0-1, applied to new drawings / boxes
    fillEnabled: boolean;                         // box tool: filled or outlined
    fillColor: string;                            // box tool: the solid fill color when fillEnabled
    strokeEnabled: boolean;                       // box tool: show border on new boxes (false → borderColor transparent)
    // Next-create text defaults. Used when the T-tool creates fresh text
    // so choices made in the Text panel (color, bold, font, etc.) carry
    // over instead of resetting to hard-coded defaults. Applied once at
    // creation; existing text items aren't retroactively updated.
    textDefaults: {
        fontFamily?: string;
        // Undefined means "no explicit choice" — creation sites fall back to
        // the theme-aware default (dark canvas → near-white, light canvas →
        // near-black). Set only when the user picks a color in the Text panel.
        color?: string;
        // Undefined means "use the readability-rescued default" (16 × zoom
        // floor in useCanvasInteraction). Set only when the user picks a
        // size in the Text panel before typing — lets users dial in a
        // banner-sized text and click to drop it.
        fontSize?: number;
        bold: boolean;
        italic: boolean;
        underline: boolean;
        strikethrough: boolean;
        alignH: 'left' | 'center' | 'right';
        alignV: 'top' | 'middle' | 'bottom';
    };
    // --- File state (Slice 3) ---
    filePath: string | null;                    // on-disk path, null until first save
    title: string;                              // display title (from filename or user-set)
    isDirty: boolean;                           // unsaved changes since last save/load
    bookmarks: Record<number, ViewState>;       // slots 1-9 → saved view state
    hiddenLayers: string[];                     // layer ids whose items are hidden
    lockedLayers: string[];                     // layer ids whose items can't be selected
    selectedConnectionIds: string[];            // connections selected for keyboard delete
    // Selected pen strokes / straight lines. Drawings are first-class
    // selectable now — click to select, marquee-select, Delete to remove,
    // drag to move. Kept in dedicated arrays (not folded into selectedIds)
    // because the reducer's item-shaped actions would mis-apply to them.
    selectedLineIds: string[];
    selectedStrokeIds: string[];
    // When set, the canvas is in "enter group" focus mode: only items whose
    // parentId chain leads to this container are fully interactive;
    // everything else is dimmed and click-to-exit. Escape or click-outside
    // clears.
    focusedContainerId: string | null;
    // Container whose title is currently being renamed via inline input.
    // Set by double-click on the title bar (useCanvasInteraction manual
    // dblclick detection), cleared by blur / Escape / Enter.
    renamingContainerId: string | null;
    // Monotonic counter used by groupSelection() to auto-name new groups
    // "Group 1", "Group 2", … The counter NEVER decrements — renaming a
    // group or deleting one doesn't free its number (spec Issue 5).
    // Persisted in the .any file so numbering is stable across sessions.
    // Migrated from existing group titles on LOAD_FILE when missing.
    nextGroupNumber: number;
    // Semantic zoom — transient, never persisted. Computed by a
    // zoom-watcher effect per container based on content readability
    // thresholds (spec: Group Semantic Zoom — Auto-Collapse at Low Zoom).
    // zoomCollapsedIds: container is currently below its re-expand
    // threshold → renders as a capsule with a magnifier icon.
    // userOverrideExpandedIds: user clicked the magnifier to force-expand
    // despite zoom → bypasses zoomCollapsed until zoom rises past the
    // re-expand threshold OR user explicitly collapses via chevron.
    zoomCollapsedIds: Record<string, boolean>;
    userOverrideExpandedIds: Record<string, boolean>;
    // Floating text-format capsule anchor. Set ONLY by a right-click on a
    // text item (top-level or inside a container); cleared on selection
    // change, click-outside, Escape, edit-mode entry, tool switch, or
    // deletion of the anchor item. Decoupled from selectedIds so the
    // capsule never appears just because a text happens to be selected
    // (e.g. as a descendant of a pasted group).
    textCapsuleAnchorId: string | null;
    // Status filter — visibility toggles for items by their status badge.
    // Statuses listed here are HIDDEN from the canvas surface (renderer
    // skips them). Empty array = show everything (default). Items with no
    // status (status === 'none' or unset) are never filtered out — only
    // items with an explicit status are subject to this. Transient view
    // state, not persisted to .any files.
    statusFilterHidden: ItemStatus[];
}

const INITIAL_STATE: CanvasState = {
    items: {},
    order: [],
    connections: {},
    lines: {},
    strokes: {},
    view: DEFAULT_VIEW,
    tool: 'type',
    selectedIds: [],
    editingId: null,
    drawingId: null,
    color: '#10b981',
    strokeWidth: 2,
    shape: 'rect',
    lineStyle: 'solid',
    opacity: 1,
    fillEnabled: false,
    fillColor: '#10b981',
    strokeEnabled: true,
    textDefaults: {
        fontFamily: undefined,
        color: undefined,
        fontSize: undefined,
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        alignH: 'left',
        alignV: 'top',
    },
    zoomCollapsedIds: {},
    userOverrideExpandedIds: {},
    filePath: null,
    title: 'Untitled',
    isDirty: false,
    bookmarks: {},
    hiddenLayers: [],
    lockedLayers: [],
    selectedConnectionIds: [],
    selectedLineIds: [],
    selectedStrokeIds: [],
    focusedContainerId: null,
    renamingContainerId: null,
    nextGroupNumber: 1,
    textCapsuleAnchorId: null,
    statusFilterHidden: [],
};

// --- Actions ---

export type CanvasAction =
    | { type: 'SET_TOOL'; tool: CanvasTool }
    | { type: 'SET_VIEW'; view: ViewState }
    | { type: 'PAN'; dx: number; dy: number }
    | { type: 'ZOOM'; factor: number; cx: number; cy: number } // cx/cy in SCREEN-space canvas coords
    | { type: 'ADD_ITEM'; item: CanvasItem }
    | { type: 'UPDATE_ITEM'; id: string; patch: Partial<CanvasItem> }
    | { type: 'DELETE_ITEMS'; ids: string[] }
    | { type: 'SELECT'; ids: string[]; additive?: boolean }
    | { type: 'CLEAR_SELECTION' }
    | { type: 'SET_EDITING'; id: string | null }
    | { type: 'SET_DRAWING'; id: string | null }
    | { type: 'SET_COLOR'; color: string }
    | { type: 'SET_STROKE_WIDTH'; width: number }
    | { type: 'SET_SHAPE'; shape: 'rect' | 'circle' | 'triangle' | 'diamond' }
    | { type: 'SET_LINE_STYLE'; style: 'solid' | 'dashed' | 'dotted' }
    | { type: 'SET_OPACITY'; opacity: number }
    | { type: 'SET_FILL_ENABLED'; enabled: boolean }
    | { type: 'SET_FILL_COLOR'; color: string }
    | { type: 'SET_STROKE_ENABLED'; enabled: boolean }
    | { type: 'SET_TEXT_DEFAULTS'; patch: Partial<CanvasState['textDefaults']> }
    | { type: 'SET_ZOOM_COLLAPSED'; id: string; collapsed: boolean }
    | { type: 'SET_OVERRIDE_EXPANDED'; id: string; overridden: boolean }
    | { type: 'RESTORE'; snapshot: StateSnapshot }
    // --- File ops ---
    | { type: 'LOAD_FILE'; items: Record<string, CanvasItem>; order: string[]; connections: Record<string, Connection>; lines?: Record<string, DrawnLine>; strokes?: Record<string, FreehandStroke>; view: ViewState; filePath: string | null; title: string; nextGroupNumber?: number }
    | { type: 'NEW_FILE' }
    | { type: 'SET_FILE_PATH'; filePath: string | null; title: string }
    | { type: 'SET_DIRTY'; dirty: boolean }
    // --- Connections (Slice 6) ---
    | { type: 'ADD_CONNECTION'; connection: Connection }
    | { type: 'UPDATE_CONNECTION'; id: string; patch: Partial<Connection> }
    | { type: 'DELETE_CONNECTIONS'; ids: string[] }
    | { type: 'SELECT_CONNECTIONS'; ids: string[]; additive?: boolean }
    // --- Lines & strokes (catch-up slice) ---
    | { type: 'ADD_LINE'; line: DrawnLine }
    | { type: 'UPDATE_LINE'; id: string; patch: Partial<DrawnLine> }
    | { type: 'DELETE_LINES'; ids: string[] }
    | { type: 'ADD_STROKE'; stroke: FreehandStroke }
    | { type: 'UPDATE_STROKE'; id: string; patch: Partial<FreehandStroke> }
    | { type: 'DELETE_STROKES'; ids: string[] }
    | { type: 'SELECT_LINES'; ids: string[]; additive?: boolean }
    | { type: 'SELECT_STROKES'; ids: string[]; additive?: boolean }
    | { type: 'UNGROUP_CONTAINER'; id: string }
    | { type: 'INCREMENT_GROUP_COUNTER' }
    // Reorder selected items along the z-axis. Operates per-parent: items
    // are reshuffled among siblings sharing the same parentId only, so a
    // child of a group can never visually escape its parent's frame.
    // 'front'/'back' jump to the extreme of the sibling band; 'forward'/
    // 'backward' shift one step relative to non-selected siblings.
    | { type: 'REORDER_ITEMS'; ids: string[]; lineIds?: string[]; strokeIds?: string[]; mode: 'front' | 'back' | 'forward' | 'backward' }
    // View fit: caller precomputes the target view from content bounds.
    | { type: 'DUPLICATE_ITEMS'; ids: string[]; offset: { dx: number; dy: number } }
    | { type: 'SET_BOOKMARK'; slot: number; view: ViewState }
    | { type: 'CLEAR_BOOKMARK'; slot: number }
    | { type: 'TOGGLE_LAYER_HIDDEN'; layerId: string }
    | { type: 'TOGGLE_LAYER_LOCKED'; layerId: string }
    | { type: 'SET_FOCUSED_CONTAINER'; id: string | null }
    | { type: 'SET_RENAMING_CONTAINER'; id: string | null }
    | { type: 'SET_TEXT_CAPSULE_ANCHOR'; id: string | null }
    | { type: 'SET_STATUS_FILTER_HIDDEN'; statuses: ItemStatus[] }
    // --- Chat threads (Slice: follow-up threads) ---
    | { type: 'ADD_THREAD_MESSAGE'; itemId: string; message: ThreadMessage }
    | { type: 'UPDATE_THREAD_MESSAGE'; itemId: string; messageId: string; patch: Partial<ThreadMessage> }
    | { type: 'CLEAR_THREAD'; itemId: string };

// Snapshot used by undo/redo. We snapshot only the parts an undoable mutation
// can affect (items + order + selection). View/tool/color are NOT undoable.
export interface StateSnapshot {
    items: Record<string, CanvasItem>;
    order: string[];
    connections: Record<string, Connection>;
    lines: Record<string, DrawnLine>;
    strokes: Record<string, FreehandStroke>;
    selectedIds: string[];
    selectedLineIds: string[];
    selectedStrokeIds: string[];
}

function snapshot(s: CanvasState): StateSnapshot {
    return {
        items: s.items,
        order: s.order,
        connections: s.connections,
        lines: s.lines,
        strokes: s.strokes,
        selectedIds: s.selectedIds,
        selectedLineIds: s.selectedLineIds,
        selectedStrokeIds: s.selectedStrokeIds,
    };
}

// Which actions should mark the file as dirty (i.e. change user-visible content).
// View/tool/selection/editing flags are excluded — moving the viewport or
// clicking doesn't make a file unsaved.
const DIRTYING_ACTIONS = new Set<CanvasAction['type']>([
    'ADD_ITEM',
    'UPDATE_ITEM',
    'DELETE_ITEMS',
    'RESTORE',
    'ADD_CONNECTION',
    'UPDATE_CONNECTION',
    'DELETE_CONNECTIONS',
    'ADD_LINE',
    'UPDATE_LINE',
    'DELETE_LINES',
    'ADD_STROKE',
    'UPDATE_STROKE',
    'DELETE_STROKES',
    'DUPLICATE_ITEMS',
    'UNGROUP_CONTAINER',
    'REORDER_ITEMS',
    'ADD_THREAD_MESSAGE',
    'UPDATE_THREAD_MESSAGE',
    'CLEAR_THREAD',
]);

function reducer(state: CanvasState, action: CanvasAction): CanvasState {
    const next = reducerImpl(state, action);
    if (next !== state && DIRTYING_ACTIONS.has(action.type) && !next.isDirty) {
        return { ...next, isDirty: true };
    }
    return next;
}

/** Expand `doomed` to transitively include any container that would be left
 *  with zero children (items OR drawings) once the initial `doomed` set
 *  disappears. Used by DELETE_ITEMS / DELETE_LINES / DELETE_STROKES to
 *  auto-delete groups the user just emptied (spec: "empty groups delete").
 *  Operates on the PRE-delete state — the caller applies the resulting
 *  union. Iterates to a fixed point so nested empty groups cascade.
 *  Containers that never had children (freshly-created empty groups) are
 *  NOT added — we only delete groups that JUST lost their last child in
 *  this operation, detected by checking that the container currently has
 *  only-doomed children in the pre-delete state. */
function expandDoomedWithEmptiedContainers(
    state: CanvasState,
    initialDoomedItems: Set<string>,
    doomedLines: Set<string>,
    doomedStrokes: Set<string>,
): Set<string> {
    const doomed = new Set(initialDoomedItems);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [cid, c] of Object.entries(state.items)) {
            if (!c || c.type !== 'container') continue;
            if (doomed.has(cid)) continue;
            // Count surviving children of any kind.
            let hadChild = false;
            let allDoomed = true;
            for (const it of Object.values(state.items)) {
                if (it.parentId !== cid) continue;
                hadChild = true;
                if (!doomed.has(it.id)) { allDoomed = false; break; }
            }
            if (allDoomed) {
                for (const ln of Object.values(state.lines)) {
                    if (ln.parentId !== cid) continue;
                    hadChild = true;
                    if (!doomedLines.has(ln.id)) { allDoomed = false; break; }
                }
            }
            if (allDoomed) {
                for (const st of Object.values(state.strokes)) {
                    if (st.parentId !== cid) continue;
                    hadChild = true;
                    if (!doomedStrokes.has(st.id)) { allDoomed = false; break; }
                }
            }
            if (hadChild && allDoomed) {
                doomed.add(cid);
                changed = true;
            }
        }
    }
    return doomed;
}

function reducerImpl(state: CanvasState, action: CanvasAction): CanvasState {
    switch (action.type) {
        case 'SET_TOOL':
            // Switching tools clears every selection bucket so the old
            // highlight doesn't linger through the next interaction
            // (user expects "pick a new tool = fresh start"). Short-
            // circuit when the tool didn't actually change so a no-op
            // SET_TOOL from the UI doesn't wipe an intentional
            // selection the user just made.
            if (action.tool === state.tool) return state;
            return {
                ...state,
                tool: action.tool,
                editingId: null,
                selectedIds: [],
                selectedLineIds: [],
                selectedStrokeIds: [],
                selectedConnectionIds: [],
                textCapsuleAnchorId: null,
            };

        case 'SET_VIEW':
            return { ...state, view: action.view };

        case 'PAN':
            return {
                ...state,
                view: {
                    ...state.view,
                    panX: state.view.panX + action.dx,
                    panY: state.view.panY + action.dy,
                },
            };

        case 'ZOOM': {
            // 2% min so a massive canvas (thousands of items, or a group
            // stretched huge) can be seen in one shot. 400% max is plenty
            // for fine-grained editing; beyond that layouts get unusable.
            const MIN = 0.02;
            const MAX = 4;
            const nextZoom = Math.max(MIN, Math.min(MAX, state.view.zoom * action.factor));
            const actual = nextZoom / state.view.zoom;
            // Zoom toward cursor: world point under (cx, cy) stays fixed.
            // screen = world * zoom + pan  =>  pan' = cx - (cx - pan) * actual
            const panX = action.cx - (action.cx - state.view.panX) * actual;
            const panY = action.cy - (action.cy - state.view.panY) * actual;
            return { ...state, view: { panX, panY, zoom: nextZoom } };
        }

        case 'ADD_ITEM': {
            // Fill in zKey if the caller didn't supply one. Most creation
            // sites pass items with `zIndex: state.order.length` and rely on
            // the reducer for the fractional key — keeps zKey concerns out
            // of the ~15 item-construction sites.
            const itemWithKey = action.item.zKey
                ? action.item
                : { ...action.item, zKey: generateKeyBetween(topZKey(state.items, state.order), null) };
            return {
                ...state,
                items: { ...state.items, [itemWithKey.id]: itemWithKey },
                order: [...state.order, itemWithKey.id],
            };
        }

        case 'UPDATE_ITEM': {
            const existing = state.items[action.id];
            if (!existing) return state;
            return {
                ...state,
                items: { ...state.items, [action.id]: { ...existing, ...action.patch } as CanvasItem },
            };
        }

        case 'DELETE_ITEMS': {
            if (action.ids.length === 0) return state;
            // Expand doomed set to include any container that would be
            // left with zero children once these items go. Runs before
            // we mutate items/lines/strokes so the traversal sees the
            // actual pre-delete parent/child graph.
            const doomed = expandDoomedWithEmptiedContainers(
                state,
                new Set(action.ids),
                new Set(),
                new Set(),
            );
            const nextItems = { ...state.items };
            for (const id of doomed) delete nextItems[id];
            // Orphans: any surviving item whose parent was deleted becomes top-level.
            // Also clear authoredInParent — it was tied to the vanished container.
            for (const [id, it] of Object.entries(nextItems)) {
                if (it.parentId && doomed.has(it.parentId)) {
                    nextItems[id] = { ...it, parentId: null, authoredInParent: undefined } as CanvasItem;
                }
            }
            // Drawings whose parent was deleted: orphan them to top-level.
            // Without this, a line inside a deleted group keeps pointing at a
            // gone container and disappears under focus-mode filters.
            const nextLines: Record<string, DrawnLine> = { ...state.lines };
            let linesChanged = false;
            for (const [id, ln] of Object.entries(nextLines)) {
                if (ln.parentId && doomed.has(ln.parentId)) {
                    nextLines[id] = { ...ln, parentId: null };
                    linesChanged = true;
                }
            }
            const nextStrokes: Record<string, FreehandStroke> = { ...state.strokes };
            let strokesChanged = false;
            for (const [id, st] of Object.entries(nextStrokes)) {
                if (st.parentId && doomed.has(st.parentId)) {
                    nextStrokes[id] = { ...st, parentId: null };
                    strokesChanged = true;
                }
            }
            // Cascade: drop any connection that references a deleted item.
            const nextConnections: Record<string, Connection> = {};
            for (const [cid, c] of Object.entries(state.connections)) {
                if (!doomed.has(c.fromId) && !doomed.has(c.toId)) nextConnections[cid] = c;
            }
            return {
                ...state,
                items: nextItems,
                order: state.order.filter(id => !doomed.has(id)),
                connections: nextConnections,
                lines: linesChanged ? nextLines : state.lines,
                strokes: strokesChanged ? nextStrokes : state.strokes,
                selectedIds: state.selectedIds.filter(id => !doomed.has(id)),
                editingId: doomed.has(state.editingId ?? '') ? null : state.editingId,
                // Clear focus/rename if they point at a deleted item —
                // a stale focusedContainerId would cause every visible
                // item to fail the inFocusSet check and render at 25%
                // opacity (the "everything faded" symptom).
                focusedContainerId: doomed.has(state.focusedContainerId ?? '') ? null : state.focusedContainerId,
                renamingContainerId: doomed.has(state.renamingContainerId ?? '') ? null : state.renamingContainerId,
                textCapsuleAnchorId: doomed.has(state.textCapsuleAnchorId ?? '') ? null : state.textCapsuleAnchorId,
                // Drop any zoom-collapse / override entries tied to
                // deleted containers so the transient maps don't hold
                // orphan ids indefinitely.
                zoomCollapsedIds: (() => {
                    const next: Record<string, boolean> = {};
                    for (const [id, v] of Object.entries(state.zoomCollapsedIds)) {
                        if (!doomed.has(id)) next[id] = v;
                    }
                    return next;
                })(),
                userOverrideExpandedIds: (() => {
                    const next: Record<string, boolean> = {};
                    for (const [id, v] of Object.entries(state.userOverrideExpandedIds)) {
                        if (!doomed.has(id)) next[id] = v;
                    }
                    return next;
                })(),
            };
        }

        case 'SELECT': {
            const nextSelected = action.additive
                ? Array.from(new Set([...state.selectedIds, ...action.ids]))
                : action.ids;
            // Drop the capsule anchor whenever the new selection no longer
            // contains it — selection is the implicit signal that the user
            // moved on. (Additive SELECT keeps it as long as the anchor is
            // still in the merged set.)
            const keepCapsule =
                state.textCapsuleAnchorId != null
                && nextSelected.includes(state.textCapsuleAnchorId);
            return {
                ...state,
                selectedIds: nextSelected,
                // Selecting items clears every other selection bucket so
                // keyboard Delete / drag / copy have one unambiguous target.
                // Additive SELECT still clears drawings/connections — mixed
                // selection (item + stroke) is arrived at from marquee, which
                // issues SELECT_LINES / SELECT_STROKES additively after.
                selectedConnectionIds: action.ids.length > 0 ? [] : state.selectedConnectionIds,
                selectedLineIds: action.ids.length > 0 && !action.additive ? [] : state.selectedLineIds,
                selectedStrokeIds: action.ids.length > 0 && !action.additive ? [] : state.selectedStrokeIds,
                textCapsuleAnchorId: keepCapsule ? state.textCapsuleAnchorId : null,
            };
        }

        case 'CLEAR_SELECTION':
            return {
                ...state,
                selectedIds: [],
                selectedConnectionIds: [],
                selectedLineIds: [],
                selectedStrokeIds: [],
                editingId: null,
                textCapsuleAnchorId: null,
            };

        case 'SET_EDITING':
            return {
                ...state,
                editingId: action.id,
                // Entering edit mode hides the capsule — the inline editor
                // owns the surface and the capsule would just compete for
                // pointer events.
                textCapsuleAnchorId: action.id != null ? null : state.textCapsuleAnchorId,
            };

        case 'SET_TEXT_CAPSULE_ANCHOR': {
            if (state.textCapsuleAnchorId === action.id) return state;
            return { ...state, textCapsuleAnchorId: action.id };
        }

        case 'SET_DRAWING':
            return { ...state, drawingId: action.id };

        case 'SET_COLOR':
            return { ...state, color: action.color };

        case 'SET_STROKE_WIDTH':
            return { ...state, strokeWidth: action.width };

        case 'SET_SHAPE':
            return { ...state, shape: action.shape };
        case 'SET_LINE_STYLE':
            return { ...state, lineStyle: action.style };
        case 'SET_OPACITY':
            return { ...state, opacity: Math.max(0.1, Math.min(1, action.opacity)) };
        case 'SET_FILL_ENABLED':
            return { ...state, fillEnabled: action.enabled };

        case 'SET_FILL_COLOR':
            return { ...state, fillColor: action.color };

        case 'SET_STROKE_ENABLED':
            return { ...state, strokeEnabled: action.enabled };

        case 'SET_TEXT_DEFAULTS':
            return { ...state, textDefaults: { ...state.textDefaults, ...action.patch } };

        case 'SET_ZOOM_COLLAPSED': {
            const prev = !!state.zoomCollapsedIds[action.id];
            if (prev === action.collapsed) return state;
            const next = { ...state.zoomCollapsedIds };
            if (action.collapsed) next[action.id] = true;
            else delete next[action.id];
            return { ...state, zoomCollapsedIds: next };
        }

        case 'SET_OVERRIDE_EXPANDED': {
            const prev = !!state.userOverrideExpandedIds[action.id];
            if (prev === action.overridden) return state;
            const next = { ...state.userOverrideExpandedIds };
            if (action.overridden) next[action.id] = true;
            else delete next[action.id];
            return { ...state, userOverrideExpandedIds: next };
        }

        case 'RESTORE':
            return {
                ...state,
                items: action.snapshot.items,
                order: action.snapshot.order,
                connections: action.snapshot.connections,
                lines: action.snapshot.lines,
                strokes: action.snapshot.strokes,
                selectedIds: action.snapshot.selectedIds,
                selectedLineIds: action.snapshot.selectedLineIds ?? [],
                selectedStrokeIds: action.snapshot.selectedStrokeIds ?? [],
                editingId: null,
                drawingId: null,
                textCapsuleAnchorId: null,
            };

        case 'LOAD_FILE':
            return {
                ...state,
                // Defensive backfill: ensure every loaded item has a zKey, even
                // if the migration didn't run (e.g. items injected at runtime
                // before save/load). Idempotent — items with valid keys keep
                // them; only missing/invalid entries are regenerated.
                items: ensureZKeys(action.items, action.order),
                order: action.order,
                connections: action.connections,
                lines: action.lines ?? {},
                strokes: action.strokes ?? {},
                view: action.view,
                selectedIds: [],
                selectedConnectionIds: [],
                selectedLineIds: [],
                selectedStrokeIds: [],
                editingId: null,
                drawingId: null,
                // Clear any stale focus/rename state from the previous
                // document — these refer to items that may not exist in
                // the freshly-loaded one, and a stale focus dims every
                // visible item to 25% opacity.
                focusedContainerId: null,
                renamingContainerId: null,
                textCapsuleAnchorId: null,
                // Transient semantic-zoom state isn't serialized — the
                // spec says derive on load. Always start with empty
                // maps; the zoom-watcher effect in ContainerItem will
                // re-populate zoomCollapsedIds once the first render
                // computes thresholds against the loaded zoom.
                zoomCollapsedIds: {},
                userOverrideExpandedIds: {},
                filePath: action.filePath,
                title: action.title,
                isDirty: false,
                // Preserve counter across loads. When the .any file didn't
                // store one (old format), derive from existing "Group N"
                // titles so subsequent auto-names don't collide.
                nextGroupNumber: action.nextGroupNumber ?? (() => {
                    let maxN = 0;
                    for (const it of Object.values(action.items)) {
                        if (it.type !== 'container') continue;
                        const m = /^Group (\d+)$/.exec(it.title || '');
                        if (m) {
                            const n = parseInt(m[1], 10);
                            if (n > maxN) maxN = n;
                        }
                    }
                    return maxN + 1;
                })(),
            };

        case 'NEW_FILE':
            return {
                ...INITIAL_STATE,
                // Preserve ephemeral tool preferences across new-file.
                tool: state.tool,
                color: state.color,
                strokeWidth: state.strokeWidth,
            };

        case 'SET_FILE_PATH':
            return { ...state, filePath: action.filePath, title: action.title };

        case 'SET_DIRTY':
            return { ...state, isDirty: action.dirty };

        case 'ADD_CONNECTION':
            return {
                ...state,
                connections: { ...state.connections, [action.connection.id]: action.connection },
            };

        case 'UPDATE_CONNECTION': {
            const existing = state.connections[action.id];
            if (!existing) return state;
            return {
                ...state,
                connections: { ...state.connections, [action.id]: { ...existing, ...action.patch } },
            };
        }

        case 'DELETE_CONNECTIONS': {
            if (action.ids.length === 0) return state;
            const next = { ...state.connections };
            for (const id of action.ids) delete next[id];
            // Also drop any selected-connection ids that just disappeared.
            const nextSelConn = state.selectedConnectionIds.filter(id => !action.ids.includes(id));
            return {
                ...state,
                connections: next,
                selectedConnectionIds: nextSelConn.length === state.selectedConnectionIds.length
                    ? state.selectedConnectionIds
                    : nextSelConn,
            };
        }

        case 'SELECT_CONNECTIONS': {
            if (action.additive) {
                const set = new Set([...state.selectedConnectionIds, ...action.ids]);
                return { ...state, selectedConnectionIds: Array.from(set), selectedIds: [] };
            }
            // Selecting connections clears item + drawing selection so the
            // Delete key is unambiguous.
            return { ...state, selectedConnectionIds: action.ids, selectedIds: [], selectedLineIds: [], selectedStrokeIds: [] };
        }

        case 'SELECT_LINES': {
            const next = action.additive
                ? Array.from(new Set([...state.selectedLineIds, ...action.ids]))
                : action.ids;
            return {
                ...state,
                selectedLineIds: next,
                // Clear the OTHER non-drawing selections on a fresh (non-
                // additive) stroke/line selection so Delete targets only
                // drawings. Additive SELECT is used by marquee for mixed
                // items+drawings — don't clear anything in that case.
                selectedConnectionIds: action.additive ? state.selectedConnectionIds : [],
                selectedIds: action.additive ? state.selectedIds : [],
            };
        }

        case 'SELECT_STROKES': {
            const next = action.additive
                ? Array.from(new Set([...state.selectedStrokeIds, ...action.ids]))
                : action.ids;
            return {
                ...state,
                selectedStrokeIds: next,
                selectedConnectionIds: action.additive ? state.selectedConnectionIds : [],
                selectedIds: action.additive ? state.selectedIds : [],
            };
        }

        case 'ADD_LINE': {
            // Assign zKey if missing — places the new line above whatever
            // is already at the same parent (items included, since v3
            // shares the z-order namespace).
            const lineWithKey = action.line.zKey
                ? action.line
                : {
                    ...action.line,
                    zKey: generateKeyBetween(
                        topZKeyForParent(state.items, state.lines, state.strokes, action.line.parentId ?? null),
                        null,
                    ),
                };
            return { ...state, lines: { ...state.lines, [lineWithKey.id]: lineWithKey } };
        }
        case 'UPDATE_LINE': {
            const existing = state.lines[action.id];
            if (!existing) return state;
            return { ...state, lines: { ...state.lines, [action.id]: { ...existing, ...action.patch } } };
        }
        case 'DELETE_LINES': {
            if (action.ids.length === 0) return state;
            const doomedLines = new Set(action.ids);
            const doomedItems = expandDoomedWithEmptiedContainers(state, new Set(), doomedLines, new Set());
            const next = { ...state.lines };
            for (const id of doomedLines) delete next[id];
            const nextSel = state.selectedLineIds.filter(id => !doomedLines.has(id));
            if (doomedItems.size === 0) {
                return {
                    ...state,
                    lines: next,
                    selectedLineIds: nextSel.length === state.selectedLineIds.length ? state.selectedLineIds : nextSel,
                };
            }
            // Containers became empty and are being auto-deleted alongside
            // these line deletions. Route through the DELETE_ITEMS path so
            // cascade logic (connections, orphans, focus clear) runs.
            const intermediate: CanvasState = {
                ...state,
                lines: next,
                selectedLineIds: nextSel.length === state.selectedLineIds.length ? state.selectedLineIds : nextSel,
            };
            return reducerImpl(intermediate, { type: 'DELETE_ITEMS', ids: Array.from(doomedItems) });
        }

        case 'ADD_STROKE': {
            const strokeWithKey = action.stroke.zKey
                ? action.stroke
                : {
                    ...action.stroke,
                    zKey: generateKeyBetween(
                        topZKeyForParent(state.items, state.lines, state.strokes, action.stroke.parentId ?? null),
                        null,
                    ),
                };
            return { ...state, strokes: { ...state.strokes, [strokeWithKey.id]: strokeWithKey } };
        }
        case 'UPDATE_STROKE': {
            const existing = state.strokes[action.id];
            if (!existing) return state;
            return { ...state, strokes: { ...state.strokes, [action.id]: { ...existing, ...action.patch } } };
        }
        case 'DELETE_STROKES': {
            if (action.ids.length === 0) return state;
            const doomedStrokes = new Set(action.ids);
            const doomedItems = expandDoomedWithEmptiedContainers(state, new Set(), new Set(), doomedStrokes);
            const next = { ...state.strokes };
            for (const id of doomedStrokes) delete next[id];
            const nextSel = state.selectedStrokeIds.filter(id => !doomedStrokes.has(id));
            if (doomedItems.size === 0) {
                return {
                    ...state,
                    strokes: next,
                    selectedStrokeIds: nextSel.length === state.selectedStrokeIds.length ? state.selectedStrokeIds : nextSel,
                };
            }
            const intermediate: CanvasState = {
                ...state,
                strokes: next,
                selectedStrokeIds: nextSel.length === state.selectedStrokeIds.length ? state.selectedStrokeIds : nextSel,
            };
            return reducerImpl(intermediate, { type: 'DELETE_ITEMS', ids: Array.from(doomedItems) });
        }

        case 'SET_BOOKMARK':
            return { ...state, bookmarks: { ...state.bookmarks, [action.slot]: action.view } };
        case 'CLEAR_BOOKMARK': {
            const next = { ...state.bookmarks };
            delete next[action.slot];
            return { ...state, bookmarks: next };
        }

        case 'TOGGLE_LAYER_HIDDEN': {
            const has = state.hiddenLayers.includes(action.layerId);
            return { ...state, hiddenLayers: has ? state.hiddenLayers.filter(l => l !== action.layerId) : [...state.hiddenLayers, action.layerId] };
        }
        case 'TOGGLE_LAYER_LOCKED': {
            const has = state.lockedLayers.includes(action.layerId);
            return { ...state, lockedLayers: has ? state.lockedLayers.filter(l => l !== action.layerId) : [...state.lockedLayers, action.layerId] };
        }

        case 'SET_FOCUSED_CONTAINER':
            // Entering a group also clears stale selection outside it;
            // exiting clears any leftover selection too for a clean slate.
            return { ...state, focusedContainerId: action.id, selectedIds: [], selectedConnectionIds: [] };

        case 'SET_RENAMING_CONTAINER':
            return { ...state, renamingContainerId: action.id };

        case 'SET_STATUS_FILTER_HIDDEN':
            return { ...state, statusFilterHidden: action.statuses };

        case 'ADD_THREAD_MESSAGE': {
            const item = state.items[action.itemId];
            if (!item) return state;
            const thread = [...(item.thread || []), action.message];
            return { ...state, items: { ...state.items, [action.itemId]: { ...item, thread } as CanvasItem } };
        }
        case 'UPDATE_THREAD_MESSAGE': {
            const item = state.items[action.itemId];
            if (!item || !item.thread) return state;
            const thread = item.thread.map(m => m.id === action.messageId ? { ...m, ...action.patch } : m);
            return { ...state, items: { ...state.items, [action.itemId]: { ...item, thread } as CanvasItem } };
        }
        case 'CLEAR_THREAD': {
            const item = state.items[action.itemId];
            if (!item) return state;
            const { thread, ...rest } = item as any;
            void thread;
            return { ...state, items: { ...state.items, [action.itemId]: rest as CanvasItem } };
        }

        case 'INCREMENT_GROUP_COUNTER':
            return { ...state, nextGroupNumber: (state.nextGroupNumber || 1) + 1 };

        case 'UNGROUP_CONTAINER': {
            // Reparent all direct children (items + drawings) to the
            // container's own parent (or top-level) and delete the
            // container. Preserves children's world positions since
            // reparent doesn't touch x/y — the vector-scale anchor
            // (authoredInParent) is cleared because it was tied to the
            // now-gone container. Only affects DIRECT children; any
            // nested sub-group stays intact as its own unit.
            const container = state.items[action.id];
            if (!container || container.type !== 'container') return state;
            const grandparentId = container.parentId ?? null;
            const nextItems = { ...state.items };
            let itemsChanged = false;
            for (const [id, it] of Object.entries(nextItems)) {
                if (it.parentId !== action.id) continue;
                nextItems[id] = { ...it, parentId: grandparentId, authoredInParent: undefined } as CanvasItem;
                itemsChanged = true;
            }
            const nextLines = { ...state.lines };
            let linesChanged = false;
            for (const [id, ln] of Object.entries(nextLines)) {
                if (ln.parentId !== action.id) continue;
                nextLines[id] = { ...ln, parentId: grandparentId };
                linesChanged = true;
            }
            const nextStrokes = { ...state.strokes };
            let strokesChanged = false;
            for (const [id, st] of Object.entries(nextStrokes)) {
                if (st.parentId !== action.id) continue;
                nextStrokes[id] = { ...st, parentId: grandparentId };
                strokesChanged = true;
            }
            // Delete the container itself via cascade into DELETE_ITEMS so
            // connections/focus/selection stay consistent. Runs on the
            // intermediate state with children already reparented so the
            // empty-parent auto-delete doesn't recurse into the container's
            // former children.
            const intermediate: CanvasState = {
                ...state,
                items: itemsChanged ? nextItems : state.items,
                lines: linesChanged ? nextLines : state.lines,
                strokes: strokesChanged ? nextStrokes : state.strokes,
            };
            return reducerImpl(intermediate, { type: 'DELETE_ITEMS', ids: [action.id] });
        }

        case 'DUPLICATE_ITEMS': {
            if (action.ids.length === 0) return state;
            // Produce new items with fresh ids, offset positions, appended to order.
            // IDs generated here using timestamp+index so the reducer stays pure-ish.
            const now = Date.now();
            const newItems: Record<string, CanvasItem> = { ...state.items };
            const newOrder = [...state.order];
            const newIds: string[] = [];
            // Allocate one zKey per clone, evenly spaced above the current top
            // in source order. generateNKeysBetween reserves room between each
            // so a later insert between two clones stays cheap.
            const validCount = action.ids.reduce((n, id) => state.items[id] ? n + 1 : n, 0);
            const fanKeys = validCount > 0
                ? generateNKeysBetween(topZKey(state.items, state.order), null, validCount)
                : [];
            let keyIdx = 0;
            for (let i = 0; i < action.ids.length; i++) {
                const src = state.items[action.ids[i]];
                if (!src) continue;
                const id = `dup_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`;
                const clone = {
                    ...src,
                    id,
                    x: src.x + action.offset.dx,
                    y: src.y + action.offset.dy,
                    zIndex: state.order.length + i,
                    zKey: fanKeys[keyIdx++],
                    createdAt: now,
                } as CanvasItem;
                newItems[id] = clone;
                newOrder.push(id);
                newIds.push(id);
            }
            return { ...state, items: newItems, order: newOrder, selectedIds: newIds };
        }

        case 'REORDER_ITEMS': {
            // Unified reorder for items + lines + strokes. All three live in
            // the same zKey namespace per parent, so an arrange operation
            // permutes their existing zKeys among the new sibling order
            // rather than generating fresh ones — that preserves the
            // invariant "child zKey stays inside parent's z-band" for free,
            // because we never write a key outside the original sibling
            // range.
            const itemIds = action.ids ?? [];
            const lineIds = action.lineIds ?? [];
            const strokeIds = action.strokeIds ?? [];
            if (itemIds.length === 0 && lineIds.length === 0 && strokeIds.length === 0) return state;

            type Kind = 'item' | 'line' | 'stroke';
            interface Entry { kind: Kind; id: string; zKey: string }

            // Defensive backfill: fill in missing zKeys before reordering.
            // Catches in-memory state from before the v3 reducer landed
            // (Vite HMR scenario — reducer code reloads but existing items
            // / strokes in state weren't migrated). Without this, the
            // reorder gathers zero siblings and silently does nothing.
            let workItems = state.items;
            let workLines = state.lines;
            let workStrokes = state.strokes;
            const missing: Array<{ kind: Kind; id: string; parentId: string | null }> = [];
            for (const [id, it] of Object.entries(state.items)) if (!it.zKey) missing.push({ kind: 'item', id, parentId: it.parentId ?? null });
            for (const [id, ln] of Object.entries(state.lines)) if (!ln.zKey) missing.push({ kind: 'line', id, parentId: ln.parentId ?? null });
            for (const [id, st] of Object.entries(state.strokes)) if (!st.zKey) missing.push({ kind: 'stroke', id, parentId: st.parentId ?? null });
            if (missing.length > 0) {
                workItems = { ...state.items };
                workLines = { ...state.lines };
                workStrokes = { ...state.strokes };
                // Group by parent so we generate keys above each parent's
                // existing top, preserving the expected "newer entity sits
                // higher" stacking that ADD_* would have produced.
                const missingByParent = new Map<string | null, Array<{ kind: Kind; id: string }>>();
                for (const m of missing) {
                    const arr = missingByParent.get(m.parentId) ?? [];
                    arr.push({ kind: m.kind, id: m.id });
                    missingByParent.set(m.parentId, arr);
                }
                for (const [parentId, list] of missingByParent) {
                    const lower = topZKeyForParent(state.items, state.lines, state.strokes, parentId);
                    const newKeys = generateNKeysBetween(lower, null, list.length);
                    for (let i = 0; i < list.length; i++) {
                        const m = list[i];
                        const k = newKeys[i];
                        if (m.kind === 'item') workItems[m.id] = { ...workItems[m.id], zKey: k };
                        else if (m.kind === 'line') workLines[m.id] = { ...workLines[m.id], zKey: k };
                        else workStrokes[m.id] = { ...workStrokes[m.id], zKey: k };
                    }
                }
            }

            // Bucket every existing entity (with a zKey) by parentId.
            const byParent = new Map<string | null, Entry[]>();
            const pushEntry = (kind: Kind, id: string, parentId: string | null, zKey: string | undefined) => {
                if (!zKey) return;
                let arr = byParent.get(parentId);
                if (!arr) { arr = []; byParent.set(parentId, arr); }
                arr.push({ kind, id, zKey });
            };
            for (const [id, it] of Object.entries(workItems)) pushEntry('item', id, it.parentId ?? null, it.zKey);
            for (const [id, ln] of Object.entries(workLines)) pushEntry('line', id, ln.parentId ?? null, ln.zKey);
            for (const [id, st] of Object.entries(workStrokes)) pushEntry('stroke', id, st.parentId ?? null, st.zKey);

            // Determine which parents have at least one selected entity.
            const affectedParents = new Set<string | null>();
            for (const id of itemIds) { const it = state.items[id]; if (it) affectedParents.add(it.parentId ?? null); }
            for (const id of lineIds) { const ln = state.lines[id]; if (ln) affectedParents.add(ln.parentId ?? null); }
            for (const id of strokeIds) { const st = state.strokes[id]; if (st) affectedParents.add(st.parentId ?? null); }
            if (affectedParents.size === 0) return state;

            const selKey = (kind: Kind, id: string) => `${kind}:${id}`;
            const selSet = new Set<string>();
            for (const id of itemIds) selSet.add(selKey('item', id));
            for (const id of lineIds) selSet.add(selKey('line', id));
            for (const id of strokeIds) selSet.add(selKey('stroke', id));
            const isSel = (e: Entry) => selSet.has(selKey(e.kind, e.id));

            // Start from workItems/workLines/workStrokes so any zKey
            // backfill from above is carried into the reorder result.
            const newItems = { ...workItems };
            const newLines = { ...workLines };
            const newStrokes = { ...workStrokes };
            // If we backfilled, mark the corresponding *Changed flag so
            // the final state-update path actually writes the backfill
            // even when no reorder permutation was needed.
            const backfilled = missing.length > 0;
            let itemsChanged = false, linesChanged = false, strokesChanged = false;

            for (const parentId of affectedParents) {
                const siblings = byParent.get(parentId) ?? [];
                if (siblings.length <= 1) continue;
                // Sort ascending: bottom of stack first. Lex compare works
                // for fractional-indexing strings.
                siblings.sort((a, b) => (a.zKey < b.zKey ? -1 : a.zKey > b.zKey ? 1 : 0));
                if (!siblings.some(isSel)) continue;

                // Dedupe: ADD_ITEM/ADD_STROKE/etc. should produce unique keys,
                // but earlier code paths (incl. agent-tool item creation that
                // bypassed the reducer's key-gen) have left some canvases with
                // colliding zKeys. The "permute existing keys" approach below
                // is a no-op for any pair of siblings sharing a key — clicking
                // "Bring to Front" silently does nothing. Detect duplicates,
                // regenerate fresh evenly-spaced keys for the whole sibling
                // group, then proceed. Caveat: fresh keys may shift this group
                // outside its original z-band relative to non-sibling items,
                // but the corrupted state already broke that invariant — the
                // user-visible alternative is the action failing silently.
                const uniq = new Set(siblings.map(s => s.zKey));
                if (uniq.size !== siblings.length) {
                    const fresh = generateNKeysBetween(null, null, siblings.length);
                    for (let i = 0; i < siblings.length; i++) {
                        const e = siblings[i];
                        const k = fresh[i];
                        e.zKey = k;
                        if (e.kind === 'item') {
                            newItems[e.id] = { ...newItems[e.id], zKey: k };
                            itemsChanged = true;
                        } else if (e.kind === 'line') {
                            newLines[e.id] = { ...newLines[e.id], zKey: k };
                            linesChanged = true;
                        } else {
                            newStrokes[e.id] = { ...newStrokes[e.id], zKey: k };
                            strokesChanged = true;
                        }
                    }
                }

                const origKeys = siblings.map(s => s.zKey);
                let nextOrder: Entry[];
                switch (action.mode) {
                    case 'front':
                        nextOrder = [...siblings.filter(e => !isSel(e)), ...siblings.filter(isSel)];
                        break;
                    case 'back':
                        nextOrder = [...siblings.filter(isSel), ...siblings.filter(e => !isSel(e))];
                        break;
                    case 'forward':
                        nextOrder = [...siblings];
                        for (let i = nextOrder.length - 2; i >= 0; i--) {
                            if (isSel(nextOrder[i]) && !isSel(nextOrder[i + 1])) {
                                const tmp = nextOrder[i]; nextOrder[i] = nextOrder[i + 1]; nextOrder[i + 1] = tmp;
                            }
                        }
                        break;
                    case 'backward':
                        nextOrder = [...siblings];
                        for (let i = 1; i < nextOrder.length; i++) {
                            if (isSel(nextOrder[i]) && !isSel(nextOrder[i - 1])) {
                                const tmp = nextOrder[i]; nextOrder[i] = nextOrder[i - 1]; nextOrder[i - 1] = tmp;
                            }
                        }
                        break;
                    default:
                        continue;
                }

                // Permute existing keys onto the new entry order. Since the
                // keys came from these same siblings, no new key generation
                // is needed and nothing leaves the parent's z-band.
                for (let i = 0; i < nextOrder.length; i++) {
                    const e = nextOrder[i];
                    const newKey = origKeys[i];
                    if (e.zKey === newKey) continue;
                    if (e.kind === 'item') {
                        newItems[e.id] = { ...newItems[e.id], zKey: newKey };
                        itemsChanged = true;
                    } else if (e.kind === 'line') {
                        newLines[e.id] = { ...newLines[e.id], zKey: newKey };
                        linesChanged = true;
                    } else {
                        newStrokes[e.id] = { ...newStrokes[e.id], zKey: newKey };
                        strokesChanged = true;
                    }
                }
            }

            if (!itemsChanged && !linesChanged && !strokesChanged && !backfilled) return state;

            // Re-sort state.order to match new item zKeys, then re-sync
            // numeric zIndex with the new positions for the CSS layer.
            let newOrder = state.order;
            if (itemsChanged || backfilled) {
                newOrder = [...state.order].sort((a, b) => {
                    const aK = newItems[a]?.zKey ?? '';
                    const bK = newItems[b]?.zKey ?? '';
                    return aK < bK ? -1 : aK > bK ? 1 : 0;
                });
                for (let i = 0; i < newOrder.length; i++) {
                    const it = newItems[newOrder[i]];
                    if (it && it.zIndex !== i) {
                        newItems[newOrder[i]] = { ...it, zIndex: i };
                    }
                }
            }

            return {
                ...state,
                items: (itemsChanged || backfilled) ? newItems : state.items,
                lines: (linesChanged || backfilled) ? newLines : state.lines,
                strokes: (strokesChanged || backfilled) ? newStrokes : state.strokes,
                order: newOrder,
            };
        }
    }
}

// --- Context ---

interface CanvasStoreValue {
    state: CanvasState;
    dispatch: React.Dispatch<CanvasAction>;
    // Undo/redo helpers — wrap dispatch so mutations record snapshots.
    commit: (action: CanvasAction, label?: string) => void;
    // Manually capture the current state as an undo point. Use this BEFORE a
    // mutation burst (e.g. a drag that emits many UPDATE_ITEMs) where commit()
    // per frame would be too expensive and would snapshot the wrong state.
    pushSnapshot: () => void;
    // Discard the most recent snapshot. Use when a committed mutation turns out
    // to be a no-op and shouldn't pollute the undo history.
    popLastSnapshot: () => void;
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
}

const CanvasStoreContext = createContext<CanvasStoreValue | null>(null);

const MAX_UNDO = 100;

export function CanvasStoreProvider({ children }: { children: React.ReactNode }) {
    const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

    // Refs so commit/undo/redo don't re-create on every render and capture
    // latest state without stale closures.
    const stateRef = useRef(state);
    stateRef.current = state;

    const undoStackRef = useRef<StateSnapshot[]>([]);
    const redoStackRef = useRef<StateSnapshot[]>([]);
    // Force re-render when stack sizes change so canUndo/canRedo flip.
    const [stackTick, bumpStack] = useReducer((n: number) => n + 1, 0);

    const commit = useCallback((action: CanvasAction, _label?: string) => {
        // Snapshot BEFORE applying. Used to undo back to this point.
        undoStackRef.current.push(snapshot(stateRef.current));
        if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
        redoStackRef.current = [];
        dispatch(action);
        bumpStack();
    }, []);

    const pushSnapshot = useCallback(() => {
        undoStackRef.current.push(snapshot(stateRef.current));
        if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
        redoStackRef.current = [];
        bumpStack();
    }, []);

    // Drop the most-recently pushed undo snapshot without recording a redo.
    // Used when a mutation burst we intended to make undoable ends up being a
    // no-op (e.g. a blank text placeholder immediately cleaned up on blur).
    const popLastSnapshot = useCallback(() => {
        if (undoStackRef.current.length === 0) return;
        undoStackRef.current.pop();
        bumpStack();
    }, []);

    const undo = useCallback(() => {
        const prev = undoStackRef.current.pop();
        if (!prev) return;
        redoStackRef.current.push(snapshot(stateRef.current));
        dispatch({ type: 'RESTORE', snapshot: prev });
        bumpStack();
    }, []);

    const redo = useCallback(() => {
        const next = redoStackRef.current.pop();
        if (!next) return;
        undoStackRef.current.push(snapshot(stateRef.current));
        dispatch({ type: 'RESTORE', snapshot: next });
        bumpStack();
    }, []);

    const value = useMemo<CanvasStoreValue>(() => ({
        state,
        dispatch,
        commit,
        pushSnapshot,
        popLastSnapshot,
        undo,
        redo,
        canUndo: undoStackRef.current.length > 0,
        canRedo: redoStackRef.current.length > 0,
    }), [state, commit, pushSnapshot, popLastSnapshot, undo, redo, stackTick]);

    return <CanvasStoreContext.Provider value={value}>{children}</CanvasStoreContext.Provider>;
}

export function useCanvasStore(): CanvasStoreValue {
    const ctx = useContext(CanvasStoreContext);
    if (!ctx) throw new Error('useCanvasStore must be used inside <CanvasStoreProvider>');
    return ctx;
}
