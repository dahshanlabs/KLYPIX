import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../state/canvasStore';
import {
    hitTest,
    normalizeRect,
    rectsIntersect,
    relativePoint,
    screenToWorld,
    type Point,
    type Rect,
} from '../CanvasEngine';
import {
    type BoxItem,
    type CanvasItem,
    type DrawnLine,
    type FreehandStroke,
    type TextItem,
    type Connection,
    newId,
} from '../items/types';
import { computeSnap, type SnapGuide } from './snapGuides';
import { dictateInto } from './voiceBridge';
import { cancelActiveAnimation } from './viewAnimate';
import { computeContainerScales, TITLE_BAR_HEIGHT, getContainerRenderMode, isTabMode, getCollapsedRenderW, suppressContainerResizeScaling } from '../items/ContainerItem';
import { tryOpenItem } from '../items/itemOpen';
import { defaultTextColorFor, getCurrentGridSettings } from '../gridSettings';

// Centralized pointer/wheel handlers for the canvas surface. Returns props to
// spread onto the root canvas <div>. Kept as a hook so KlypixCanvas stays
// declarative and this is easy to unit-test later.

type DragMode =
    | { kind: 'none' }
    | { kind: 'pan'; lastX: number; lastY: number }
    | {
          kind: 'move';
          ids: string[];
          lineIds: string[];
          strokeIds: string[];
          startWorld: Point;
          originals: Record<string, { x: number; y: number }>;
          lineOriginals: Record<string, { x1: number; y1: number; x2: number; y2: number }>;
          strokeOriginals: Record<string, { x: number; y: number }[]>;
          committed: boolean;
      }
    | { kind: 'draw-box'; startWorld: Point; itemId: string; committed: boolean }
    | { kind: 'draw-line'; startWorld: Point; lineId: string }
    | { kind: 'draw-stroke'; strokeId: string }
    | { kind: 'marquee'; startWorld: Point };

export interface UseCanvasInteractionOptions {
    // Fired AFTER a move-drag drop auto-grew a container because at least
    // one of its dragged children landed outside its previous bounds. The
    // surface uses this to show a small Yes/No/Cancel banner offering to
    // deparent the child instead of keeping the grown frame. Always called
    // after the grow is committed (so a "No" choice = no further work).
    onChildOverflow?: (info: { parentId: string; childIds: string[] }) => void;
}

export function useCanvasInteraction(opts?: UseCanvasInteractionOptions) {
    const { state, dispatch, commit, pushSnapshot } = useCanvasStore();
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const stateRef = useRef(state);
    stateRef.current = state;

    const dragRef = useRef<DragMode>({ kind: 'none' });
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const movedRef = useRef(false);
    // rAF batching for the move drag. Modern pointers fire at 100-240 Hz,
    // and each event used to dispatch one UPDATE_ITEM per dragged item +
    // run snap/auto-grow logic. Capping the work rate at ~60 fps via
    // requestAnimationFrame removes the duplicate work without changing
    // the visible drag (the latest pointer position always wins on the
    // next frame). Refs only — never read in render — so this can't
    // trigger an extra render itself.
    const moveRafRef = useRef<number | null>(null);
    const movePendingRef = useRef<Point | null>(null);
    // Last pointerdown on an item, used to detect a "click twice on the same
    // item" → edit, in tools where the native dblclick event doesn't fire
    // because the surface's setPointerCapture redirects pointerup/click.
    const lastHitRef = useRef<{ id: string; t: number } | null>(null);
    const DBLCLICK_MS = 400;
    // Held-space pan (AutoCAD-style hand tool): while space is held, left-
    // click-and-drag pans regardless of active tool. Tracked as a ref so the
    // pointerdown closure sees the latest value without recreating.
    const spaceDownRef = useRef(false);
    const [spaceHeld, setSpaceHeld] = useState(false);  // for cursor update only

    // Transient UI state surfaced to the surface component for rendering.
    const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
    // Connect tool: once user clicks item A, we're "pending" until they click B.
    const [connectPendingId, setConnectPendingId] = useState<string | null>(null);
    // World-coord pointer position while a connect is pending — drives the
    // rubber-band preview line in ConnectionsLayer.
    const [connectHoverWorld, setConnectHoverWorld] = useState<Point | null>(null);
    // Active snap guides during a move drag — rendered by the surface.
    const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
    // Transient cursor-anchored toast slot. No active callers now that
    // the auto-zoom abort path is gone; kept as null state + setter so
    // re-adding a toast caller later is a one-liner.
    const [toast] = useState<{ text: string; x: number; y: number } | null>(null);

    const setSurfaceRef = useCallback((el: HTMLDivElement | null) => {
        surfaceRef.current = el;
    }, []);

    // Space-held pan: activate while Space is down and the user isn't typing
    // into a field. Release on keyup. keyrepeat fires multiple keydowns; ignore
    // extras. Cursor changes to 'grab' on held, 'grabbing' when drag starts.
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.code !== 'Space') return;
            const tgt = e.target as HTMLElement | null;
            if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
            if (spaceDownRef.current) return;
            spaceDownRef.current = true;
            setSpaceHeld(true);
            e.preventDefault();
        };
        const up = (e: KeyboardEvent) => {
            if (e.code !== 'Space') return;
            if (!spaceDownRef.current) return;
            spaceDownRef.current = false;
            setSpaceHeld(false);
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
        };
    }, []);

    const pointerWorld = useCallback((e: React.PointerEvent | PointerEvent): Point => {
        const el = surfaceRef.current!;
        const p = relativePoint(e, el);
        return screenToWorld(p, stateRef.current.view);
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!surfaceRef.current) return;
        // User input always wins over an in-flight view animation. Any
        // pointer-down on the canvas kills a running zoom-to-author
        // tween so the view stays wherever it was mid-tween; the user
        // takes over from there. Prevents view-jitter from two sources
        // fighting for SET_VIEW. (Exception: the zoom-to-author call
        // below for this same pointer-down will START a new animation,
        // which is fine — animateView cancels the previous one first.)
        cancelActiveAnimation();
        // Bail early if the click originated on any canvas chrome (Toolbar,
        // Minimap, panels, ContextMenu, ChatThread, etc.). Otherwise the
        // surface starts a drag AND captures the pointer, which silently
        // swallows the synthesized click event on the chrome button. Every
        // floating UI component marks its root with data-canvas-ui="1".
        const targetEl = e.target as HTMLElement | null;
        if (targetEl && targetEl.closest?.('[data-canvas-ui]')) return;
        // Self-heal the focus bug: Electron frameless + alwaysOnTop
        // sometimes leaves the renderer focus unattached after a window
        // switch, so the user sees a blinking cursor but keystrokes go
        // nowhere. window.focus() from the renderer is often blocked by
        // Windows focus-stealing prevention for alwaysOnTop overlays; the
        // focus-window IPC has main-process privilege to actually raise the
        // window. Belt-and-braces: call both.
        try { window.focus(); } catch { /* noop */ }
        try { (window as any).electron?.focusWindow?.(); } catch { /* noop */ }
        const s = stateRef.current;
        const screen = relativePoint(e, surfaceRef.current);
        const world = screenToWorld(screen, s.view);
        movedRef.current = false;

        // Middle-mouse OR Alt-drag OR Space-held → pan (works in any tool).
        if (e.button === 1 || (e.button === 0 && (e.altKey || spaceDownRef.current))) {
            dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
            surfaceRef.current.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        // Hit-test existing items. In focus mode, restrict to descendants of
        // the focused container so the user can't accidentally grab an item
        // outside it; a click that lands on an out-of-focus area exits
        // focus mode (handled below after the hit decision).
        const focusedId = s.focusedContainerId;
        let allItems = s.order.map(id => s.items[id]).filter(Boolean) as CanvasItem[];
        let focusedSet: Set<string> | null = null;
        if (focusedId) {
            focusedSet = new Set<string>([focusedId]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const it of allItems) {
                    if (focusedSet.has(it.id)) continue;
                    if (it.parentId && focusedSet.has(it.parentId)) {
                        focusedSet.add(it.id);
                        changed = true;
                    }
                }
            }
            // Exclude the focused container itself from hit testing — in
            // focus mode the container frame is a backdrop, not a target.
            // Clicks on empty interior fall through to the "exit focus" path.
            allItems = allItems.filter(it => focusedSet!.has(it.id) && it.id !== focusedId);
        }
        const items = allItems;
        let hit = hitTest(items, focusedId ? items.map(i => i.id) : s.order, world);
        // Tab-mode hit priority. Containers in collapsed or collapsed-visual
        // mode own their RENDERED tab rectangle, not their expanded bounds.
        // At extreme zoom-out, a regular bounds-only hitTest can return
        // a (hidden) child whose world position happens to overlap the
        // tab area, blocking the user from dragging the visible tab.
        // Pre-pass: if the click lands inside any container's rendered
        // tab, that container wins. Iterates s.order in reverse so
        // top-most containers take priority. Skip containers that are
        // hidden by an ancestor's tab mode.
        if (!focusedId) {
            for (let i = s.order.length - 1; i >= 0; i--) {
                const cand = s.items[s.order[i]];
                if (!cand || cand.type !== 'container') continue;
                const mode = getContainerRenderMode(cand, s.view.zoom, s.items, {
                    zoomCollapsedIds: s.zoomCollapsedIds,
                    userOverrideExpandedIds: s.userOverrideExpandedIds,
                });
                if (!isTabMode(mode)) continue;
                const tabW = getCollapsedRenderW(cand, s.view.zoom);
                const { titleScale } = computeContainerScales(cand, s.view.zoom);
                const tabH = TITLE_BAR_HEIGHT * titleScale;
                if (world.x >= cand.x && world.x <= cand.x + tabW &&
                    world.y >= cand.y && world.y <= cand.y + tabH) {
                    hit = cand;
                    break;
                }
            }
        }
        // Outside focus mode, a group is an ATOMIC unit. Clicking a child
        // selects/drags its enclosing container — users can't accidentally
        // pull children out of the group by clicking on them. Double-click
        // a container to enter focus mode, then children are individually
        // addressable (see focusedSet filter above).
        if (hit && !focusedId) {
            let cur: CanvasItem | undefined = hit;
            let topContainer: CanvasItem | undefined = undefined;
            // Walk up until we find the FURTHEST container ancestor, so
            // nested groups still resolve to the outermost frame.
            while (cur?.parentId) {
                const parent: CanvasItem | undefined = s.items[cur.parentId];
                if (parent?.type === 'container') topContainer = parent;
                cur = parent;
            }
            if (topContainer) hit = topContainer;
        }
        // Focus mode is only exited via explicit user actions: pressing
        // Escape, clicking the LogOut button in the container's header,
        // or double-clicking another container to enter it. A plain click
        // on empty canvas inside focus mode falls through to the active
        // tool's create path, which parents the new item/drawing to the
        // focused group (see C2/C3 in docs/KLYPIX-GROUPS-SHAPES-UX.md).
        // Previously this block cleared focus on any outside click,
        // making T/box/pen a no-op inside groups (the click exited focus
        // before reaching the tool branch).

        // In select tool: click an item to select + start move drag. Click empty to start marquee.
        if (s.tool === 'select') {
            // v3: drawings live in the same z-order namespace as items, so
            // click priority follows zKey — the topmost entity at the
            // click point wins, whether it's an item or a drawing. Pre-v3
            // drawings always rendered above items so items unconditionally
            // beat drawings on click; that's now wrong because a stroke
            // can be sent behind a box (or vice versa).
            const zoomInv = 1 / Math.max(0.0001, s.view.zoom);
            let hitLineId: string | null = null;
            let hitStrokeId: string | null = null;
            // Filter drawings before hit-testing:
            //   1. Focus-mode: only drawings inside the focused group.
            //   2. Collapse-mode: a drawing under a collapsed ancestor
            //      is visually hidden, so it must not be clickable either.
            const collapsedAncestorIds = new Set<string>();
            for (const [cid, c] of Object.entries(s.items)) {
                if (c?.type !== 'container') continue;
                if (c.collapsed) collapsedAncestorIds.add(cid);
            }
            const parentIsUnderCollapsed = (parentId: string | null | undefined): boolean => {
                let cur: string | null | undefined = parentId;
                while (cur) {
                    if (collapsedAncestorIds.has(cur)) return true;
                    const parent = s.items[cur];
                    cur = parent?.parentId ?? null;
                }
                return false;
            };
            const allowedLines: Record<string, import('../items/types').DrawnLine> = {};
            for (const [lid, ln] of Object.entries(s.lines)) {
                if (parentIsUnderCollapsed(ln.parentId)) continue;
                if (focusedSet && !(ln.parentId && focusedSet.has(ln.parentId))) continue;
                allowedLines[lid] = ln;
            }
            const allowedStrokes: Record<string, import('../items/types').FreehandStroke> = {};
            for (const [sid, st] of Object.entries(s.strokes)) {
                if (parentIsUnderCollapsed(st.parentId)) continue;
                if (focusedSet && !(st.parentId && focusedSet.has(st.parentId))) continue;
                allowedStrokes[sid] = st;
            }
            hitLineId = hitTestLine(world, allowedLines, zoomInv);
            if (!hitLineId) hitStrokeId = hitTestStroke(world, allowedStrokes, zoomInv);

            // Resolve by zKey: if both an item AND a drawing are under the
            // pointer, whichever has the higher zKey wins. Tie-break via >=
            // so drawings beat items when both lack zKey — that matches
            // renderList's DOM order (items pushed first, drawings after,
            // stable sort keeps drawings on top), which is what the user
            // sees on screen.
            if (hit && (hitLineId || hitStrokeId)) {
                const itemZ = (hit as any).zKey ?? '';
                const drawingZ = hitLineId
                    ? (s.lines[hitLineId]?.zKey ?? '')
                    : (s.strokes[hitStrokeId!]?.zKey ?? '');
                if (drawingZ >= itemZ) {
                    hit = null;
                } else {
                    hitLineId = null;
                    hitStrokeId = null;
                }
            }
            if (!hit && (hitLineId || hitStrokeId)) {
                // Start a move drag carrying the clicked drawing. Three
                // selection cases, same rules as item clicks:
                //   - replaceMode (plain click on a drawing NOT in the
                //     current selection) → selection becomes just this
                //     drawing; drag only this.
                //   - plain click on an already-selected drawing → keep
                //     the full selection; drag everything (items too).
                //   - shift-click → add to selection; drag everything.
                const additive = e.shiftKey;
                const alreadySelected =
                    !!(hitLineId && s.selectedLineIds.includes(hitLineId))
                    || !!(hitStrokeId && s.selectedStrokeIds.includes(hitStrokeId));
                const replaceMode = !additive && !alreadySelected;

                const finalLineIds: string[] = replaceMode
                    ? (hitLineId ? [hitLineId] : [])
                    : (hitLineId && !s.selectedLineIds.includes(hitLineId)
                        ? [...s.selectedLineIds, hitLineId]
                        : s.selectedLineIds);
                const finalStrokeIds: string[] = replaceMode
                    ? (hitStrokeId ? [hitStrokeId] : [])
                    : (hitStrokeId && !s.selectedStrokeIds.includes(hitStrokeId)
                        ? [...s.selectedStrokeIds, hitStrokeId]
                        : s.selectedStrokeIds);
                const finalItemIds: string[] = replaceMode ? [] : s.selectedIds;

                if (replaceMode) dispatch({ type: 'CLEAR_SELECTION' });
                if (finalLineIds.length > 0) dispatch({ type: 'SELECT_LINES', ids: finalLineIds, additive: true });
                if (finalStrokeIds.length > 0) dispatch({ type: 'SELECT_STROKES', ids: finalStrokeIds, additive: true });

                const originals: Record<string, { x: number; y: number }> = {};
                for (const id of finalItemIds) {
                    const it = s.items[id];
                    if (it) originals[id] = { x: it.x, y: it.y };
                }
                const lineOriginals: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {};
                for (const id of finalLineIds) {
                    const ln = s.lines[id];
                    if (ln) lineOriginals[id] = { x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2 };
                }
                const strokeOriginals: Record<string, { x: number; y: number }[]> = {};
                for (const id of finalStrokeIds) {
                    const st = s.strokes[id];
                    if (st) strokeOriginals[id] = st.points.map(p => ({ x: p.x, y: p.y }));
                }
                pushSnapshot();
                dragRef.current = {
                    kind: 'move',
                    ids: finalItemIds,
                    lineIds: finalLineIds,
                    strokeIds: finalStrokeIds,
                    startWorld: world,
                    originals,
                    lineOriginals,
                    strokeOriginals,
                    committed: false,
                };
                surfaceRef.current.setPointerCapture(e.pointerId);
                return;
            }
            if (hit) {
                // Manual double-click detection: the setPointerCapture below
                // prevents React's synthetic dblclick on the text item div,
                // so we look for two pointerdowns on the same item within
                // DBLCLICK_MS and upgrade that to "enter edit" for text items
                // (or rename mode for container title bars).
                const now = Date.now();
                const prev = lastHitRef.current;
                const isDblSameItem = prev && prev.id === hit.id && (now - prev.t) < DBLCLICK_MS;
                lastHitRef.current = { id: hit.id, t: now };
                if (isDblSameItem && hit.type === 'text') {
                    dispatch({ type: 'SELECT', ids: [hit.id] });
                    pushSnapshot();
                    dispatch({ type: 'SET_EDITING', id: hit.id });
                    return;
                }
                // Container double-click → rename.
                // - In tab mode (collapsed or collapsed-visual) the
                //   entire visible surface IS the title bar, so any
                //   click on the container triggers rename.
                // - In expanded mode, only the rendered title bar area
                //   counts. Use the ACTUAL rendered bar height (dynamic
                //   via titleScale) so this works at any zoom — a
                //   constant 28 misses at low zoom where the rendered
                //   bar is 50× taller.
                if (isDblSameItem && hit.type === 'container') {
                    const mode = getContainerRenderMode(hit as any, s.view.zoom, s.items, {
                        zoomCollapsedIds: s.zoomCollapsedIds,
                        userOverrideExpandedIds: s.userOverrideExpandedIds,
                    });
                    const { titleScale } = computeContainerScales(hit as any, s.view.zoom);
                    const renderedTitleBarH = TITLE_BAR_HEIGHT * titleScale;
                    const inTitleArea = isTabMode(mode) || (world.y - hit.y <= renderedTitleBarH);
                    if (inTitleArea) {
                        dispatch({ type: 'SELECT', ids: [hit.id] });
                        dispatch({ type: 'SET_RENAMING_CONTAINER', id: hit.id });
                        return;
                    }
                }
                // Box (rect) double-click → in-place convert to a bordered
                // TextItem and enter edit mode. The box's native
                // onDoubleClick never fires because setPointerCapture below
                // redirects events to the surface; manual detection is the
                // reliable path. Non-rect shapes (circle/triangle/diamond)
                // fall through so the box keeps its shape while the user's
                // second pointerdown just starts another move drag.
                if (isDblSameItem && hit.type === 'box' && (!hit.shape || hit.shape === 'rect')) {
                    pushSnapshot();
                    const textId = newId('txt');
                    dispatch({ type: 'DELETE_ITEMS', ids: [hit.id] });
                    // Target a readable typing font (~13 screen-px) at any
                    // Canonical font cap — text created by double-clicking a
                    // box picks fontSize ≤ 13 world-px (matches T-tool
                    // authoring default), bounded by boxH*0.4 so small
                    // boxes don't burst their own borders.
                    const boxH = Math.max(1, hit.h);
                    const readableCap = 13;
                    const fitFontSize = Math.max(8, Math.min(boxH * 0.4, readableCap));
                    dispatch({
                        type: 'ADD_ITEM',
                        item: {
                            id: textId,
                            type: 'text',
                            x: hit.x,
                            y: hit.y,
                            w: hit.w,
                            h: hit.h,
                            zIndex: hit.zIndex,
                            locked: false,
                            parentId: hit.parentId,
                            createdAt: Date.now(),
                            createdBy: 'user',
                            content: '',
                            fontSize: fitFontSize,
                            color: defaultTextColorFor(getCurrentGridSettings().background),
                            border: true,
                            borderColor: (hit as any).borderColor || '#10b981',
                            borderWidth: (hit as any).borderWidth,
                            // Carry over the box's paint so double-click
                            // doesn't strip the shape's personality. Fill
                            // preserves a colored background; lineStyle
                            // keeps dashed/dotted borders dashed/dotted;
                            // opacity keeps the faded look if any.
                            fillColor: (hit as any).fillColor,
                            lineStyle: (hit as any).lineStyle,
                            opacity: (hit as any).opacity,
                            heading: false,
                            authoredWidth: hit.w,
                        } as TextItem,
                    });
                    dispatch({ type: 'SELECT', ids: [textId] });
                    dispatch({ type: 'SET_EDITING', id: textId });
                    return;
                }
                // Universal "open" dispatch on dblclick for items with an
                // external representation. Text / box / container / drawing
                // all have their own dblclick semantics above and short-
                // circuit before this branch. Code items enter edit mode
                // like text; file / image / video / audio open externally;
                // link / canvas-link open their target.
                if (isDblSameItem) {
                    if (hit.type === 'code') {
                        dispatch({ type: 'SELECT', ids: [hit.id] });
                        dispatch({ type: 'SET_EDITING', id: hit.id });
                        return;
                    }
                    if (hit.type === 'file' || hit.type === 'image' || hit.type === 'video'
                        || hit.type === 'audio' || hit.type === 'link' || hit.type === 'canvas-link') {
                        dispatch({ type: 'SELECT', ids: [hit.id] });
                        tryOpenItem(hit);
                        return;
                    }
                }
                const additive = e.shiftKey;
                const nextSelected = additive
                    ? Array.from(new Set([...s.selectedIds, hit.id]))
                    : s.selectedIds.includes(hit.id)
                        ? s.selectedIds
                        : [hit.id];
                if (!additive && !s.selectedIds.includes(hit.id)) {
                    dispatch({ type: 'SELECT', ids: [hit.id] });
                } else if (additive) {
                    dispatch({ type: 'SELECT', ids: [hit.id], additive: true });
                }
                const originals: Record<string, { x: number; y: number }> = {};
                const allIds = [...nextSelected];
                // Collect all descendants of a container, not just direct
                // children — nested groups (A in B in C) must move together
                // when C is dragged.
                const addDescendants = (containerId: string) => {
                    for (const cid of s.order) {
                        const c = s.items[cid];
                        if (c?.parentId !== containerId) continue;
                        if (!originals[cid]) originals[cid] = { x: c.x, y: c.y };
                        if (!allIds.includes(cid)) allIds.push(cid);
                        if (c.type === 'container') addDescendants(cid);
                    }
                };
                for (const id of nextSelected) {
                    const it = s.items[id];
                    if (it) originals[id] = { x: it.x, y: it.y };
                    if (it?.type === 'container') addDescendants(id);
                }
                // If the click doesn't cause a non-additive SELECT
                // dispatch (which would wipe drawings from selection),
                // any already-selected drawings should move together
                // with the items. Supports the marquee → drag flow
                // where a text + stroke are selected and the user
                // grabs the text to reposition both.
                const isNonAdditiveReplace = !additive && !s.selectedIds.includes(hit.id);
                // Drawings that are children of a dragged container must
                // move with it — `addDescendants` above only walks items.
                // Without this, dragging a group leaves parented strokes
                // behind on the canvas even though they're correctly
                // parented in state.
                const draggedContainerIds = new Set<string>();
                for (const id of allIds) {
                    const it = s.items[id];
                    if (it?.type === 'container') draggedContainerIds.add(id);
                }
                const ancestorIsDragged = (parentId: string | null | undefined): boolean => {
                    let cur: string | null | undefined = parentId;
                    const seen = new Set<string>();
                    while (cur && !seen.has(cur)) {
                        if (draggedContainerIds.has(cur)) return true;
                        seen.add(cur);
                        const parent = s.items[cur];
                        cur = parent?.parentId ?? null;
                    }
                    return false;
                };
                const childLineIds: string[] = [];
                for (const [lid, ln] of Object.entries(s.lines)) {
                    if (ancestorIsDragged(ln.parentId)) childLineIds.push(lid);
                }
                const childStrokeIds: string[] = [];
                for (const [sid, st] of Object.entries(s.strokes)) {
                    if (ancestorIsDragged(st.parentId)) childStrokeIds.push(sid);
                }
                const selectedLineIds = isNonAdditiveReplace ? [] : s.selectedLineIds;
                const selectedStrokeIds = isNonAdditiveReplace ? [] : s.selectedStrokeIds;
                const moveLineIds = Array.from(new Set([...selectedLineIds, ...childLineIds]));
                const moveStrokeIds = Array.from(new Set([...selectedStrokeIds, ...childStrokeIds]));
                const lineOriginals: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {};
                for (const lid of moveLineIds) {
                    const ln = s.lines[lid];
                    if (ln) lineOriginals[lid] = { x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2 };
                }
                const strokeOriginals: Record<string, { x: number; y: number }[]> = {};
                for (const sid of moveStrokeIds) {
                    const st = s.strokes[sid];
                    if (st) strokeOriginals[sid] = st.points.map(p => ({ x: p.x, y: p.y }));
                }
                pushSnapshot();
                dragRef.current = {
                    kind: 'move',
                    ids: allIds,
                    lineIds: moveLineIds,
                    strokeIds: moveStrokeIds,
                    startWorld: world,
                    originals,
                    lineOriginals,
                    strokeOriginals,
                    committed: false,
                };
                surfaceRef.current.setPointerCapture(e.pointerId);
                return;
            }
            // Empty → start rubber-band marquee. If user clicks without dragging we'll clear selection on pointerUp.
            dragRef.current = { kind: 'marquee', startWorld: world };
            setMarqueeRect({ x: world.x, y: world.y, w: 0, h: 0 });
            surfaceRef.current.setPointerCapture(e.pointerId);
            return;
        }

        // In type tool: click empty → create text item + enter edit. Click item → move it.
        if (s.tool === 'type') {
            let clickedContainerId: string | null = null;
            if (hit) {
                dispatch({ type: 'SELECT', ids: [hit.id] });
                if (hit.type === 'text') {
                    // Snapshot so the whole edit session is one undo entry.
                    pushSnapshot();
                    dispatch({ type: 'SET_EDITING', id: hit.id });
                    return;
                }
                if (hit.type === 'container') {
                    // Container hit → fall through to the create-text path
                    // so the new text is parented to this group. Moving the
                    // whole group frame with T-tool was a footgun: the
                    // group header is a big click target, so aiming near it
                    // to author text kept relocating the frame instead.
                    clickedContainerId = hit.id;
                } else {
                    // Non-text, non-container hit (box, image, …) → move it.
                    const originals: Record<string, { x: number; y: number }> = { [hit.id]: { x: hit.x, y: hit.y } };
                    pushSnapshot();
                    dragRef.current = {
                        kind: 'move',
                        ids: [hit.id],
                        lineIds: [],
                        strokeIds: [],
                        startWorld: world,
                        originals,
                        lineOriginals: {},
                        strokeOriginals: {},
                        committed: false,
                    };
                    surfaceRef.current.setPointerCapture(e.pointerId);
                    return;
                }
            }
            // Before creating a fresh text item, evict any empty ghost text
            // items the user clicked into earlier and never typed into —
            // including the one that's currently in edit mode. Repeated T
            // clicks without typing otherwise stack ghosts that the 1s
            // sweeper cleans up afterward, producing a visible "3 ITEMS"
            // → "1 ITEMS" bounce in the counter. Figma's T-tool has the
            // same behavior: abandoning an uncommitted caret discards it.
            {
                const staleEmptyIds: string[] = [];
                for (const iid of s.order) {
                    const it = s.items[iid];
                    if (!it || it.type !== 'text') continue;
                    if ((it.content ?? '') !== '') continue;
                    staleEmptyIds.push(iid);
                }
                if (staleEmptyIds.length > 0) {
                    dispatch({ type: 'DELETE_ITEMS', ids: staleEmptyIds });
                }
            }
            // Empty click → create text + enter editing mode.
            // NO auto-zoom here. The user chose this zoom level; don't
            // yank them out of their overview just because they clicked
            // to type. Content is created at fixed world sizes
            // (fontSize: 16, w: 260) at the clicked position. At extreme
            // zoom-out the text is tiny on screen — user can zoom in
            // to edit if they want. That's a conscious UX trade vs the
            // earlier jarring auto-zoom. If the user
            // holds Alt (Opt) while clicking, auto-start voice dictation
            // into the new item — "T + Alt-click + speak" is the
            // at-cursor voice flow. Plain T-click keeps pure keyboard entry.
            //
            // If the click landed inside a focused container, parent the
            // new text to it AND pre-wrap at the container's inner width.
            // Saves the visible flicker of "text grows outside frame →
            // parent effect clamps it back".
            // Canonical authoring sizes. New text is fontSize:16 / w:260
            // in world-px regardless of the current view zoom — items
            // have a fixed world size, zoom is just magnification. Items
            // authored at high zoom still land at 16/260; they just
            // render proportionally bigger on screen at that zoom. See
            // Reading 2 decision (2026-04-22).
            //
            // Exception — readability rescue at extreme zoom-out. At 2%
            // zoom a canonical fontSize:16 renders at 0.32 screen-px —
            // invisible. Authoring becomes impossible. So we apply a
            // ONE-WAY floor: if 16 × zoom would be below 14 screen-px,
            // scale fontSize + width up together so new text renders at
            // ≥ 14 screen-px (roughly 11pt — comfortable for reading
            // while you type). Above ~88% zoom the scale is exactly 1
            // (Reading 2 strict). Only scales up, never down — so items
            // authored at 400% still get the canonical 16.
            const readabilityScale = Math.max(1, 14 / (16 * Math.max(0.01, s.view.zoom)));
            // Focus mode: new text always parented to the focused group so
            // it tracks with the group. The inside-bounds check only
            // controls first-author width (match container inner width)
            // and fontSize scale (match siblings).
            const textParentContainerId = focusedId ?? clickedContainerId;
            let parentId: string | null = textParentContainerId;
            let initialW = 260 * readabilityScale;
            let initialAuthoredWidth: number | undefined = undefined;
            let initialFontSize = 16 * readabilityScale;
            if (textParentContainerId) {
                const container = s.items[textParentContainerId];
                if (container && container.type === 'container') {
                    const INNER_PAD = 16;
                    const innerW = Math.max(60, container.w - INNER_PAD * 2);
                    if (world.x >= container.x && world.x <= container.x + container.w &&
                        world.y >= container.y && world.y <= container.y + container.h) {
                        initialW = innerW;
                        initialAuthoredWidth = innerW;
                        // Inside a container the new text matches siblings:
                        // scale by the container's own vector scale, capped
                        // to [0.5, 4] to avoid absurd sizes in a wildly
                        // stretched group. Readability rescue still applies
                        // (compounded with container scale) so tiny text
                        // inside a tiny group at 2% zoom is still authorable.
                        const authoredW = container.authoredW || container.w;
                        const authoredH = container.authoredH || container.h;
                        const scaleW = container.w / Math.max(1, authoredW);
                        const scaleH = container.h / Math.max(1, authoredH);
                        const groupScale = Math.min(scaleW, scaleH);
                        const capped = Math.max(0.5, Math.min(4, groupScale));
                        initialFontSize = 16 * capped * readabilityScale;
                    }
                }
            }
            const td = s.textDefaults;
            // User-picked size from the Text panel wins over the
            // readability-rescued default. We still scale by the
            // readabilityScale floor so a 16 px choice at 2 % zoom stays
            // authorable, but a banner-sized 96 px choice carries through
            // one-for-one above ~88 % zoom.
            const finalFontSize = td.fontSize != null
                ? td.fontSize * readabilityScale
                : initialFontSize;
            const newText: TextItem = {
                id: newId('txt'),
                type: 'text',
                x: world.x,
                y: world.y,
                w: initialW,
                h: Math.max(28, finalFontSize * 1.75),
                zIndex: s.order.length,
                locked: false,
                parentId,
                createdAt: Date.now(),
                createdBy: 'user',
                content: '',
                fontSize: finalFontSize,
                // User-picked color from the Text panel wins; otherwise
                // fall back to a theme-aware default (dark canvas →
                // near-white, light canvas → near-black). The legacy
                // hard default ('#e8e8ed') was theme-blind and looked
                // invisible on light canvas.
                color: td.color ?? defaultTextColorFor(getCurrentGridSettings().background),
                border: false,
                borderColor: '#1e1e2e',
                heading: false,
                authoredWidth: initialAuthoredWidth,
                // Inherit text defaults set via the Text panel while the
                // T-tool was active. Legacy defaults are no-ops (bold:false
                // etc.) so pre-panel behavior is unchanged.
                fontFamily: td.fontFamily,
                fontWeight: td.bold ? 'bold' : 'normal',
                fontStyle: td.italic ? 'italic' : 'normal',
                textDecoration: td.underline ? 'underline' : 'none',
                strikethrough: td.strikethrough || undefined,
                textAlign: td.alignH,
                verticalAlign: td.alignV,
            };
            commit({ type: 'ADD_ITEM', item: newText });
            dispatch({ type: 'SELECT', ids: [newText.id] });
            dispatch({ type: 'SET_EDITING', id: newText.id });
            if (e.altKey) {
                // Defer by a tick so the ADD_ITEM reducer can commit the
                // new item before voice tries to patch its content.
                const id = newText.id;
                setTimeout(() => dictateInto(id), 0);
            }
            return;
        }

        // Box tool: drag to draw. Shape/style come from the toolbar.
        // (No zoom-to-author interception — at extreme zoom the user
        // gets a shape sized to their drag's world coords. That's a
        // conscious choice; the user chose the zoom level.)
        if (s.tool === 'box') {
            const box: BoxItem = {
                id: newId('box'),
                type: 'box',
                x: world.x,
                y: world.y,
                w: 1,
                h: 1,
                zIndex: s.order.length,
                locked: false,
                // Parent to the focused group (if any) so boxes drawn in
                // focus mode become children of the group.
                parentId: focusedId ?? null,
                createdAt: Date.now(),
                createdBy: 'user',
                borderColor: s.strokeEnabled === false ? 'transparent' : s.color,
                borderWidth: s.strokeWidth,
                fillColor: s.fillEnabled ? s.fillColor : 'transparent',
                borderRadius: 6,
                shape: s.shape,
                opacity: s.opacity,
                lineStyle: s.lineStyle,
            };
            // Snapshot BEFORE the box exists so undo erases it entirely.
            pushSnapshot();
            dispatch({ type: 'ADD_ITEM', item: box });
            dispatch({ type: 'SET_DRAWING', id: box.id });
            dragRef.current = { kind: 'draw-box', startWorld: world, itemId: box.id, committed: false };
            surfaceRef.current.setPointerCapture(e.pointerId);
            return;
        }

        // Line tool: drag to draw a straight line.
        if (s.tool === 'line') {
            const line: DrawnLine = {
                id: newId('ln'),
                x1: world.x, y1: world.y, x2: world.x, y2: world.y,
                color: s.color,
                width: s.strokeWidth,
                arrowHead: false,
                parentId: focusedId ?? null,
            };
            pushSnapshot();
            dispatch({ type: 'ADD_LINE', line });
            dragRef.current = { kind: 'draw-line', startWorld: world, lineId: line.id };
            surfaceRef.current.setPointerCapture(e.pointerId);
            return;
        }

        // Pen tool: freehand stroke, point list grows with pointer moves.
        if (s.tool === 'pen') {
            const stroke: FreehandStroke = {
                id: newId('pen'),
                points: [{ x: world.x, y: world.y, pressure: e.pressure || 0.5 }],
                color: s.color,
                width: s.strokeWidth,
                parentId: focusedId ?? null,
            };
            pushSnapshot();
            dispatch({ type: 'ADD_STROKE', stroke });
            dragRef.current = { kind: 'draw-stroke', strokeId: stroke.id };
            surfaceRef.current.setPointerCapture(e.pointerId);
            return;
        }

        // Eraser tool: hold-drag to wipe strokes/lines under the pointer.
        if (s.tool === 'eraser') {
            pushSnapshot();
            dragRef.current = { kind: 'draw-stroke', strokeId: 'eraser' }; // reuse stroke kind for path events
            surfaceRef.current.setPointerCapture(e.pointerId);
            // Also wipe whatever's under the initial click.
            eraseAt(world, stateRef.current, dispatch);
            return;
        }

        // Connect tool: click item A, click item B → arrow. First click
        // records pending; second click on another item commits. Click empty or
        // Escape cancels. A rubber-band preview line follows the cursor
        // between the two clicks (see connectHoverWorld + ConnectionsLayer).
        if (s.tool === 'connect') {
            if (!hit) {
                if (connectPendingId) { setConnectPendingId(null); setConnectHoverWorld(null); }
                return;
            }
            if (!connectPendingId) {
                setConnectPendingId(hit.id);
                setConnectHoverWorld(world);
                return;
            }
            if (connectPendingId === hit.id) return; // don't self-connect
            const conn: Connection = {
                id: newId('conn'),
                fromId: connectPendingId,
                toId: hit.id,
                label: '',
                color: s.color,
                width: s.strokeWidth,
                arrowHead: true,
                style: 'solid',
                createdBy: 'user',
            };
            commit({ type: 'ADD_CONNECTION', connection: conn });
            setConnectPendingId(null);
            setConnectHoverWorld(null);
            // Connection finalized — return to Select so the user can
            // manipulate the newly-connected items without re-picking.
            dispatch({ type: 'SET_TOOL', tool: 'select' });
            return;
        }
    }, [dispatch, commit, pushSnapshot, connectPendingId]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // Track pointer world coords whenever a connect is pending so the
        // rubber-band preview can follow the cursor, even without a drag.
        if (connectPendingId && surfaceRef.current) {
            setConnectHoverWorld(pointerWorld(e));
        }
        const drag = dragRef.current;
        if (drag.kind === 'none' || !surfaceRef.current) return;
        movedRef.current = true;

        if (drag.kind === 'pan') {
            const dx = e.clientX - drag.lastX;
            const dy = e.clientY - drag.lastY;
            dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
            dispatch({ type: 'PAN', dx, dy });
            return;
        }

        const world = pointerWorld(e);

        if (drag.kind === 'move') {
            // Cap dispatch rate at one frame per pointer position. Pointer
            // events can fire >120 Hz on modern hardware; without rAF
            // batching we'd recompute snap + dispatch per dragged item on
            // every event, double the work for no visible benefit. The
            // pending world coord is overwritten on every event, so the
            // rAF callback always uses the latest cursor position.
            movePendingRef.current = world;
            if (moveRafRef.current != null) return;
            moveRafRef.current = requestAnimationFrame(() => {
                moveRafRef.current = null;
                const w = movePendingRef.current;
                movePendingRef.current = null;
                if (!w) return;
                const drag2 = dragRef.current;
                if (drag2.kind !== 'move') return;
                const rawDx = w.x - drag2.startWorld.x;
                const rawDy = w.y - drag2.startWorld.y;
                // Snap pass: build union rect of dragged items AFTER applying
                // the raw delta, then see if any edge aligns with a non-dragged
                // item. Threshold scales inversely with zoom so the feel stays
                // constant.
                const s = stateRef.current;
                const draggedSet = new Set(drag2.ids);
                const draggedItems: CanvasItem[] = [];
                const otherItems: CanvasItem[] = [];
                for (const id of s.order) {
                    const it = s.items[id];
                    if (!it) continue;
                    if (draggedSet.has(id)) draggedItems.push(it);
                    else otherItems.push(it);
                }
                // Build post-delta dragged bounds using originals + raw delta.
                // Drawings-only drags skip snap entirely (the ItemBounds snap
                // logic is tuned for item-to-item alignment, not stroke edges).
                let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
                for (const it of draggedItems) {
                    const orig = drag2.originals[it.id];
                    if (!orig) continue;
                    const nx = orig.x + rawDx;
                    const ny = orig.y + rawDy;
                    if (nx < pminX) pminX = nx;
                    if (ny < pminY) pminY = ny;
                    if (nx + it.w > pmaxX) pmaxX = nx + it.w;
                    if (ny + it.h > pmaxY) pmaxY = ny + it.h;
                }
                const hasBounds = isFinite(pminX);
                const zoom = Math.max(0.01, s.view.zoom);
                const snap = hasBounds
                    ? computeSnap(
                        { x: pminX, y: pminY, w: pmaxX - pminX, h: pmaxY - pminY },
                        rawDx,
                        rawDy,
                        otherItems,
                        6 / zoom,
                    )
                    : { dx: rawDx, dy: rawDy, guides: [] as SnapGuide[] };
                const { dx, dy, guides } = snap;
                setSnapGuides(guides);
                for (const id of drag2.ids) {
                    const orig = drag2.originals[id];
                    if (!orig) continue;
                    dispatch({ type: 'UPDATE_ITEM', id, patch: { x: orig.x + dx, y: orig.y + dy } });
                }
                // Lines: reset to original coords + translate by dx/dy.
                // Resetting first (instead of accumulating delta-from-last-
                // frame) keeps the drag path perfectly straight even if
                // earlier frames dispatched slightly different deltas due to
                // snap.
                for (const lid of drag2.lineIds) {
                    const orig = drag2.lineOriginals[lid];
                    if (!orig) continue;
                    dispatch({
                        type: 'UPDATE_LINE',
                        id: lid,
                        patch: {
                            x1: orig.x1 + dx,
                            y1: orig.y1 + dy,
                            x2: orig.x2 + dx,
                            y2: orig.y2 + dy,
                        },
                    });
                }
                for (const sid of drag2.strokeIds) {
                    const origPts = drag2.strokeOriginals[sid];
                    if (!origPts) continue;
                    dispatch({
                        type: 'UPDATE_STROKE',
                        id: sid,
                        patch: { points: origPts.map(p => ({ x: p.x + dx, y: p.y + dy })) },
                    });
                }
            });
            return;
        }

        if (drag.kind === 'draw-box') {
            let endX = world.x;
            let endY = world.y;
            if (e.shiftKey) {
                const dx = world.x - drag.startWorld.x;
                const dy = world.y - drag.startWorld.y;
                const size = Math.max(Math.abs(dx), Math.abs(dy));
                endX = drag.startWorld.x + (dx < 0 ? -size : size);
                endY = drag.startWorld.y + (dy < 0 ? -size : size);
            }
            const r = normalizeRect(drag.startWorld.x, drag.startWorld.y, endX, endY);
            dispatch({ type: 'UPDATE_ITEM', id: drag.itemId, patch: { x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) } });
            return;
        }

        if (drag.kind === 'draw-line') {
            dispatch({ type: 'UPDATE_LINE', id: drag.lineId, patch: { x2: world.x, y2: world.y } });
            return;
        }

        if (drag.kind === 'draw-stroke') {
            // Eraser path reuses this drag kind with strokeId='eraser'.
            if (drag.strokeId === 'eraser') {
                eraseAt(world, stateRef.current, dispatch);
                return;
            }
            const s = stateRef.current;
            const stroke = s.strokes[drag.strokeId];
            if (stroke) {
                const nextPoints = [...stroke.points, { x: world.x, y: world.y, pressure: e.pressure || 0.5 }];
                dispatch({ type: 'UPDATE_STROKE', id: drag.strokeId, patch: { points: nextPoints } });
            }
            return;
        }

        if (drag.kind === 'marquee') {
            const r = normalizeRect(drag.startWorld.x, drag.startWorld.y, world.x, world.y);
            setMarqueeRect(r);
            return;
        }
    }, [dispatch, pointerWorld, connectPendingId]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag.kind === 'none') return;
        surfaceRef.current?.releasePointerCapture?.(e.pointerId);

        // Flush any pending rAF-batched move frame synchronously so the
        // final cursor position is committed before the drag-end logic
        // runs. Cancelling without flushing would leave items at their
        // last-rendered (older) frame; flushing inline guarantees the
        // post-drag pass sees the cursor's true final coords.
        if (moveRafRef.current != null) {
            cancelAnimationFrame(moveRafRef.current);
            moveRafRef.current = null;
            const w = movePendingRef.current;
            movePendingRef.current = null;
            if (w && drag.kind === 'move') {
                const rawDx = w.x - drag.startWorld.x;
                const rawDy = w.y - drag.startWorld.y;
                for (const id of drag.ids) {
                    const orig = drag.originals[id];
                    if (!orig) continue;
                    dispatch({ type: 'UPDATE_ITEM', id, patch: { x: orig.x + rawDx, y: orig.y + rawDy } });
                }
                for (const lid of drag.lineIds) {
                    const orig = drag.lineOriginals[lid];
                    if (!orig) continue;
                    dispatch({
                        type: 'UPDATE_LINE',
                        id: lid,
                        patch: {
                            x1: orig.x1 + rawDx, y1: orig.y1 + rawDy,
                            x2: orig.x2 + rawDx, y2: orig.y2 + rawDy,
                        },
                    });
                }
                for (const sid of drag.strokeIds) {
                    const origPts = drag.strokeOriginals[sid];
                    if (!origPts) continue;
                    dispatch({
                        type: 'UPDATE_STROKE',
                        id: sid,
                        patch: { points: origPts.map(p => ({ x: p.x + rawDx, y: p.y + rawDy })) },
                    });
                }
                setSnapGuides([]);
            }
        }

        // Re-seed authoredInParent after a child drag finishes, so the
        // user's new position becomes the baseline for future container
        // scaling. Skipping this would cause the next group resize to
        // snap the child back to its original authored spot.
        //
        // Also: if a dragged child now extends outside its parent's
        // bounds, GROW the parent so the frame keeps wrapping its
        // content (spec B3: "group frame auto-expands as child moves").
        // Auto-expand only — never auto-shrink; right-click → Fit to
        // contents is the explicit shrink path. Growth re-seeds the
        // parent's authoredW/H AND every child's authoredInParent so
        // the vector-scale system continues to round-trip correctly
        // through the new baseline.
        if (drag.kind === 'move') {
            const s = stateRef.current;
            // Click-vs-drag detection: a move drag with no actual pointer
            // movement is a pure selection click. We used to run the
            // whole auto-expand + authoredInParent re-seed pass anyway,
            // which fired on every click of a container and auto-grew
            // it whenever a child's world bbox didn't match the
            // container's shrunk bounds (the "group grows on select"
            // bug). Bail out early for click-only moves — the pan / zoom
            // / drag-end path only needs to run when something actually
            // moved.
            const MOVE_THRESHOLD = 0.5; // world-px
            let anyMoved = false;
            for (const id of drag.ids) {
                const orig = drag.originals[id];
                const cur = s.items[id];
                if (!orig || !cur) continue;
                if (Math.abs(orig.x - cur.x) > MOVE_THRESHOLD || Math.abs(orig.y - cur.y) > MOVE_THRESHOLD) {
                    anyMoved = true;
                    break;
                }
            }
            if (!anyMoved) {
                for (const id of drag.lineIds) {
                    const orig = drag.lineOriginals[id];
                    const cur = s.lines[id];
                    if (!orig || !cur) continue;
                    if (Math.abs(orig.x1 - cur.x1) > MOVE_THRESHOLD || Math.abs(orig.y1 - cur.y1) > MOVE_THRESHOLD) {
                        anyMoved = true;
                        break;
                    }
                }
            }
            if (!anyMoved) {
                for (const id of drag.strokeIds) {
                    const orig = drag.strokeOriginals[id];
                    const cur = s.strokes[id];
                    if (!orig || !cur || orig.length === 0 || cur.points.length === 0) continue;
                    if (Math.abs(orig[0].x - cur.points[0].x) > MOVE_THRESHOLD
                        || Math.abs(orig[0].y - cur.points[0].y) > MOVE_THRESHOLD) {
                        anyMoved = true;
                        break;
                    }
                }
            }
            if (!anyMoved) {
                // Fall through to the end-of-handler cleanup (pointer
                // capture release, dragRef reset). Don't early-return —
                // we need the reset.
                dragRef.current = { kind: 'none' };
                return;
            }
            const PAD = 16;
            const TITLE = 28; // TITLE_BAR_HEIGHT — inline to avoid circular import
            const processedParents = new Set<string>();
            // Each entry = a parent that auto-grew because a dragged child
            // landed outside its previous bounds. Aggregated across the
            // whole drop and surfaced via opts.onChildOverflow at the end.
            const overflowReports: { parentId: string; childIds: string[] }[] = [];

            // Collect parent ids from items AND drawings so dragging a
            // stroke inside focus mode also triggers auto-expand of its
            // parent group.
            const draggedByParent = new Map<string, string[]>();
            for (const id of drag.ids) {
                const it = s.items[id];
                if (!it?.parentId) continue;
                const arr = draggedByParent.get(it.parentId) || [];
                arr.push(id);
                draggedByParent.set(it.parentId, arr);
            }
            const affectedParentIds = new Set<string>(draggedByParent.keys());
            for (const lid of drag.lineIds) {
                const ln = s.lines[lid];
                if (ln?.parentId) affectedParentIds.add(ln.parentId);
            }
            for (const sid of drag.strokeIds) {
                const st = s.strokes[sid];
                if (st?.parentId) affectedParentIds.add(st.parentId);
            }

            // Parents whose children ALL moved alongside them are not
            // candidates for auto-expand. If the user dragged Group 3
            // and Group 1 / Group 2 / inner text are all part of that
            // drag (via addDescendants), their positions relative to
            // their parents are unchanged — no overflow can have
            // appeared. Checking "parent in drag.ids" catches direct
            // cases; the ancestor walk catches transitive ones (text
            // inside Group 1 inside Group 3, when Group 3 is dragged).
            const draggedSet = new Set(drag.ids);
            const parentDraggedByAncestor = (pid: string): boolean => {
                if (draggedSet.has(pid)) return true;
                let cur: string | null = s.items[pid]?.parentId ?? null;
                const seen = new Set<string>();
                while (cur && !seen.has(cur)) {
                    if (draggedSet.has(cur)) return true;
                    seen.add(cur);
                    cur = s.items[cur]?.parentId ?? null;
                }
                return false;
            };

            for (const parentId of affectedParentIds) {
                const parent = s.items[parentId];
                if (!parent || parent.type !== 'container') continue;
                // Skip pure-translation parents. This was the root of
                // the "move father → child height grows" bug: dragging
                // Group 3 pulled Group 1 / Group 2 / inner texts along
                // as descendants; for each descendant's parent we'd
                // still run the overflow check, which triggered on any
                // pre-existing sub-pixel overflow and grew the child.
                if (parentDraggedByAncestor(parentId)) continue;
                const draggedChildren = draggedByParent.get(parentId) || [];

                // Compute bbox across ALL children — items, lines, AND
                // strokes. A stroke dragged outside the parent frame must
                // also grow the frame; previously only items contributed
                // to the bbox check, so moving a stroke far away had no
                // effect on the container.
                let minX = parent.x, minY = parent.y;
                let maxX = parent.x + parent.w, maxY = parent.y + parent.h;
                let needsGrow = false;
                // Only grow when a child actually EXCEEDS the parent —
                // not when it merely sits within PAD of the edge. The
                // old check used child.x - PAD < parent.x, which treated
                // any edge-aligned child as needing more margin. Result:
                // a pure translate-the-whole-group drag grew the parent
                // by 2×PAD every time, because dragged descendants were
                // still flush with the (now-translated) parent's edges.
                // PAD is re-applied AFTER overflow is detected so the
                // grown container still has breathing room.
                const parentRight = parent.x + parent.w;
                const parentBottom = parent.y + parent.h;
                const parentHeaderBottom = parent.y + TITLE;
                for (const child of Object.values(s.items)) {
                    if (child.parentId !== parentId) continue;
                    if (child.x < parent.x) { minX = child.x - PAD; needsGrow = true; }
                    if (child.y < parentHeaderBottom) { minY = child.y - PAD - TITLE; needsGrow = true; }
                    if (child.x + child.w > parentRight) { maxX = child.x + child.w + PAD; needsGrow = true; }
                    if (child.y + child.h > parentBottom) { maxY = child.y + child.h + PAD; needsGrow = true; }
                }
                for (const ln of Object.values(s.lines)) {
                    if (ln.parentId !== parentId) continue;
                    const lnMinX = Math.min(ln.x1, ln.x2);
                    const lnMinY = Math.min(ln.y1, ln.y2);
                    const lnMaxX = Math.max(ln.x1, ln.x2);
                    const lnMaxY = Math.max(ln.y1, ln.y2);
                    if (lnMinX < parent.x) { minX = lnMinX - PAD; needsGrow = true; }
                    if (lnMinY < parentHeaderBottom) { minY = lnMinY - PAD - TITLE; needsGrow = true; }
                    if (lnMaxX > parentRight) { maxX = lnMaxX + PAD; needsGrow = true; }
                    if (lnMaxY > parentBottom) { maxY = lnMaxY + PAD; needsGrow = true; }
                }
                for (const st of Object.values(s.strokes)) {
                    if (st.parentId !== parentId) continue;
                    if (st.points.length === 0) continue;
                    let smX = Infinity, smY = Infinity, sxX = -Infinity, sxY = -Infinity;
                    for (const p of st.points) {
                        if (p.x < smX) smX = p.x;
                        if (p.y < smY) smY = p.y;
                        if (p.x > sxX) sxX = p.x;
                        if (p.y > sxY) sxY = p.y;
                    }
                    if (smX < parent.x) { minX = smX - PAD; needsGrow = true; }
                    if (smY < parentHeaderBottom) { minY = smY - PAD - TITLE; needsGrow = true; }
                    if (sxX > parentRight) { maxX = sxX + PAD; needsGrow = true; }
                    if (sxY > parentBottom) { maxY = sxY + PAD; needsGrow = true; }
                }

                if (needsGrow) {
                    const newW = maxX - minX;
                    const newH = maxY - minY;
                    // Skip the vector-scale effect's next pass — we're about
                    // to re-seed every child's authoredInParent to the new
                    // baseline, so letting the effect derive children from
                    // stale values would momentarily yank them off-position.
                    suppressContainerResizeScaling(parentId);
                    dispatch({
                        type: 'UPDATE_ITEM',
                        id: parentId,
                        patch: {
                            x: minX,
                            y: minY,
                            w: newW,
                            h: newH,
                            authoredW: newW,
                            authoredH: newH,
                        } as any,
                    });

                    // Re-seed authoredInParent for EVERY child of the grown
                    // container (not just dragged ones). Their world
                    // positions are untouched; we're just rebasing the
                    // anchor onto the new parent bounds at scale = 1.
                    for (const child of Object.values(s.items)) {
                        if (child.parentId !== parentId) continue;
                        const next: any = {
                            relX: child.x - minX,
                            relY: child.y - minY,
                            w: child.w,
                            h: child.h,
                        };
                        if (child.type === 'text') {
                            next.fontSize = child.fontSize;
                            next.authoredWidth = child.authoredWidth ?? child.w;
                        }
                        if (child.type === 'box') {
                            next.borderWidth = child.borderWidth;
                        }
                        dispatch({ type: 'UPDATE_ITEM', id: child.id, patch: { authoredInParent: next } as any });
                    }
                    // Same re-seed for drawings (lines + pen strokes). Their
                    // authoredInParent holds endpoints/points relative to
                    // the container; rebase to the new parent origin at
                    // scale=1 using current world coords.
                    for (const [lid, ln] of Object.entries(s.lines)) {
                        if (ln.parentId !== parentId) continue;
                        dispatch({
                            type: 'UPDATE_LINE',
                            id: lid,
                            patch: {
                                authoredInParent: {
                                    x1: ln.x1 - minX,
                                    y1: ln.y1 - minY,
                                    x2: ln.x2 - minX,
                                    y2: ln.y2 - minY,
                                    width: ln.width,
                                },
                            },
                        });
                    }
                    for (const [sid, st] of Object.entries(s.strokes)) {
                        if (st.parentId !== parentId) continue;
                        dispatch({
                            type: 'UPDATE_STROKE',
                            id: sid,
                            patch: {
                                authoredInParent: {
                                    points: st.points.map(p => ({ ...p, x: p.x - minX, y: p.y - minY })),
                                    width: st.width,
                                },
                            },
                        });
                    }
                    processedParents.add(parentId);
                    // Record the dragged child ids that pushed this grow,
                    // regardless of where their CENTER ended up. Includes
                    // children that the drop-reparent loop below will
                    // auto-deparent — the banner's "Yes" is a no-op for
                    // them which is fine, and the user still sees the
                    // confirmation they asked for.
                    // draggedByParent stores string ids (not item objects),
                    // so use the array directly.
                    const draggedHere = draggedByParent.get(parentId) || [];
                    if (draggedHere.length > 0) {
                        overflowReports.push({ parentId, childIds: draggedHere });
                    }
                }
            }

            // Fallback reseed for dragged children whose parent did NOT
            // grow (within-bounds moves). Same scale-aware math as before.
            // Also skipped when the parent itself was dragged (pure
            // translation): the authored anchor stays identical because
            // every child moved by the same delta, so re-writing it is
            // just floating-point noise that risks drifting the anchor.
            for (const id of drag.ids) {
                const it = s.items[id];
                if (!it?.parentId) continue;
                if (processedParents.has(it.parentId)) continue;
                if (parentDraggedByAncestor(it.parentId)) continue;
                const parent = s.items[it.parentId];
                if (!parent || parent.type !== 'container') continue;
                const aw = parent.authoredW || parent.w;
                if (!aw) continue;
                const scale = parent.w / aw;
                if (scale <= 0) continue;
                const inv = 1 / scale;
                const next: NonNullable<CanvasItem['authoredInParent']> = {
                    relX: (it.x - parent.x) * inv,
                    relY: (it.y - parent.y) * inv,
                    w: it.w * inv,
                    h: it.h * inv,
                };
                if (it.type === 'text') {
                    next.fontSize = it.fontSize * inv;
                    next.authoredWidth = (it.authoredWidth ?? it.w) * inv;
                }
                if (it.type === 'box') {
                    next.borderWidth = it.borderWidth * inv;
                }
                const prev = it.authoredInParent;
                const same = prev
                    && Math.abs(prev.relX - next.relX) < 0.01
                    && Math.abs(prev.relY - next.relY) < 0.01
                    && Math.abs(prev.w - next.w) < 0.01
                    && Math.abs(prev.h - next.h) < 0.01;
                if (!same) {
                    dispatch({ type: 'UPDATE_ITEM', id, patch: { authoredInParent: next } as any });
                }
            }

            // === Drop-reparenting ===
            // If a dragged item's center has landed inside a different
            // container, reassign parentId so containers act like real
            // drop targets (kanban move-between-columns, mind-map
            // subgrouping, organising loose cards into a group). Only
            // top-level dragged items qualify — descendants pulled along
            // by an ancestor's translation keep their existing parent.
            // Reparenting also clears/recomputes authoredInParent so
            // the next vector-scale pass derives positions against the
            // new parent's bounds, not the old one.
            // Children covered by an overflow report — for these, defer
            // the "deparent to top-level" decision to the user via the
            // banner. Reparenting to a SIBLING container still proceeds
            // normally (a drop into another group is a clear intent).
            const overflowChildIds = new Set<string>(
                overflowReports.flatMap(r => r.childIds),
            );

            const reparentDecisions: Array<{ id: string; newParentId: string | null }> = [];
            for (const id of drag.ids) {
                const it = s.items[id];
                if (!it) continue;
                if (it.locked) continue;
                // Skip if this item moved as a descendant of another
                // dragged item — its world position is consistent with
                // its current parent (the parent moved too).
                if (it.parentId && parentDraggedByAncestor(it.parentId)) continue;
                // Build the exclusion set: self + every descendant.
                // Containers can't be reparented into their own children
                // (would create a cycle).
                const excluded = new Set<string>([id]);
                if (it.type === 'container') {
                    const stack = [id];
                    while (stack.length) {
                        const pid = stack.pop()!;
                        for (const k of Object.keys(s.items)) {
                            if (s.items[k]?.parentId === pid && !excluded.has(k)) {
                                excluded.add(k);
                                if (s.items[k]?.type === 'container') stack.push(k);
                            }
                        }
                    }
                }
                // Drop point: item's center.
                const cx = it.x + it.w / 2;
                const cy = it.y + it.h / 2;
                // Find the topmost container whose bounds contain the
                // drop point. Iterate state.order in reverse so visually
                // on-top groups (drawn last) win — matches what the
                // user sees under the cursor.
                let newParentId: string | null = null;
                for (let i = s.order.length - 1; i >= 0; i--) {
                    const oid = s.order[i];
                    if (excluded.has(oid)) continue;
                    const cand = s.items[oid];
                    if (!cand || cand.type !== 'container') continue;
                    if (cand.userCollapsed || cand.collapsed) continue; // collapsed = capsule, can't accept drops
                    if (cx >= cand.x && cx <= cand.x + cand.w && cy >= cand.y && cy <= cand.y + cand.h) {
                        newParentId = oid;
                        break;
                    }
                }
                const currentParentId: string | null = it.parentId ?? null;
                // Defer the "drop to top-level" decision to the banner
                // for overflow children — but allow drops into a sibling
                // container (a clear intent that the banner doesn't cover).
                if (newParentId === null && overflowChildIds.has(id)) {
                    continue;
                }
                if (newParentId !== currentParentId) {
                    reparentDecisions.push({ id, newParentId });
                }
            }

            for (const dec of reparentDecisions) {
                const it = s.items[dec.id];
                if (!it) continue;
                const patch: any = { parentId: dec.newParentId };
                if (dec.newParentId === null) {
                    // Item left its container — drop the anchor so future
                    // resizes don't try to derive position from a now-stale
                    // baseline.
                    patch.authoredInParent = undefined;
                } else {
                    // Compute fresh authoredInParent against the new
                    // parent at scale=1 (same math the fallback re-seed
                    // uses, but rebased to the new parent's authored size).
                    const np = s.items[dec.newParentId];
                    if (np && np.type === 'container') {
                        const aw = (np as any).authoredW || np.w;
                        const scale = aw > 0 ? np.w / aw : 1;
                        const inv = scale > 0 ? 1 / scale : 1;
                        const next: any = {
                            relX: (it.x - np.x) * inv,
                            relY: (it.y - np.y) * inv,
                            w: it.w * inv,
                            h: it.h * inv,
                        };
                        if (it.type === 'text') {
                            next.fontSize = (it as any).fontSize * inv;
                            next.authoredWidth = ((it as any).authoredWidth ?? it.w) * inv;
                        }
                        if (it.type === 'box') {
                            next.borderWidth = (it as any).borderWidth * inv;
                        }
                        patch.authoredInParent = next;
                    }
                }
                dispatch({ type: 'UPDATE_ITEM', id: dec.id, patch });
            }

            // Emit the first overflow report — banner only handles one
            // parent at a time. Multi-parent drags are rare; the user can
            // re-drag the next batch if needed.
            if (overflowReports.length > 0 && optsRef.current?.onChildOverflow) {
                optsRef.current.onChildOverflow(overflowReports[0]);
            }
        }

        if (drag.kind === 'draw-box') {
            const s = stateRef.current;
            const box = s.items[drag.itemId];
            const wasCreated = !!(box && !(box.w < 4 || box.h < 4));
            if (!wasCreated) {
                dispatch({ type: 'DELETE_ITEMS', ids: [drag.itemId] });
            } else {
                dispatch({ type: 'SELECT', ids: [drag.itemId] });
            }
            dispatch({ type: 'SET_DRAWING', id: null });
            // Auto-return to Select after a successful draw so the user
            // doesn't have to manually switch tools between primitive +
            // manipulate-the-primitive. Skip on too-small (treat as
            // mis-click; keep tool active for a retry).
            if (wasCreated) dispatch({ type: 'SET_TOOL', tool: 'select' });
        }

        if (drag.kind === 'draw-line') {
            const s = stateRef.current;
            const ln = s.lines[drag.lineId];
            const dx = ln ? Math.abs(ln.x2 - ln.x1) : 0;
            const dy = ln ? Math.abs(ln.y2 - ln.y1) : 0;
            const tooShort = ln && Math.hypot(dx, dy) < 4;
            if (tooShort) {
                dispatch({ type: 'DELETE_LINES', ids: [drag.lineId] });
            } else if (ln) {
                dispatch({ type: 'SET_TOOL', tool: 'select' });
            }
        }

        if (drag.kind === 'draw-stroke') {
            const s = stateRef.current;
            const str = s.strokes[drag.strokeId];
            const tooShort = str && str.points.length < 2;
            if (tooShort) {
                dispatch({ type: 'DELETE_STROKES', ids: [drag.strokeId] });
            }
            // Pen stays active for continuous drawing — multiple strokes
            // in a row without re-picking the tool. Right-click exits
            // back to Select (handled by the canvas's contextMenu
            // handler, same pattern as Type and Eraser).
        }

        if (drag.kind === 'marquee') {
            if (marqueeRect && (marqueeRect.w > 4 || marqueeRect.h > 4)) {
                const s = stateRef.current;
                const focusedId = s.focusedContainerId;
                // Promote children to their topmost container ancestor so
                // a rubber-band select grabs the group as ONE unit, not
                // its individual text/image children. Matches the atomic-
                // group semantics of single-click selection. In focus
                // mode we keep per-child marquee so the user can multi-
                // select items inside the group.
                const promote = (id: string): string => {
                    if (focusedId) return id;
                    let cur: CanvasItem | undefined = s.items[id];
                    let top: CanvasItem | undefined = undefined;
                    while (cur?.parentId) {
                        const parent: CanvasItem | undefined = s.items[cur.parentId];
                        if (parent?.type === 'container') top = parent;
                        cur = parent;
                    }
                    return top ? top.id : id;
                };
                const hitSet = new Set<string>();
                for (const id of s.order) {
                    const it = s.items[id];
                    if (!it) continue;
                    if (!rectsIntersect({ x: it.x, y: it.y, w: it.w, h: it.h }, marqueeRect)) continue;
                    hitSet.add(promote(id));
                }
                // Drawings inside the marquee: include lines/strokes whose
                // bbox intersects the rect. Dispatched separately because
                // they live in their own selection buckets — SELECT carries
                // items only.
                const hitLineIds: string[] = [];
                for (const [id, ln] of Object.entries(s.lines)) {
                    if (rectsIntersect(lineBounds(ln), marqueeRect)) hitLineIds.push(id);
                }
                const hitStrokeIds: string[] = [];
                for (const [id, st] of Object.entries(s.strokes)) {
                    if (rectsIntersect(strokeBounds(st), marqueeRect)) hitStrokeIds.push(id);
                }
                // CLEAR first so the three SELECT_* dispatches compose
                // cleanly via additive:true instead of each one clobbering
                // the previous bucket. Without the clear, a prior drawing
                // selection would persist through a new items-only marquee.
                dispatch({ type: 'CLEAR_SELECTION' });
                const hitSetArr = Array.from(hitSet);
                if (hitSetArr.length > 0) dispatch({ type: 'SELECT', ids: hitSetArr, additive: true });
                if (hitLineIds.length > 0) dispatch({ type: 'SELECT_LINES', ids: hitLineIds, additive: true });
                if (hitStrokeIds.length > 0) dispatch({ type: 'SELECT_STROKES', ids: hitStrokeIds, additive: true });
            } else {
                // Click-without-drag → clear selection.
                dispatch({ type: 'CLEAR_SELECTION' });
            }
            setMarqueeRect(null);
        }

        dragRef.current = { kind: 'none' };
        setSnapGuides([]);
    }, [dispatch, marqueeRect]);

    const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        if (!surfaceRef.current) return;
        // Any user-initiated pan/zoom cancels an active auto-zoom
        // tween. User input always wins.
        cancelActiveAnimation();
        // Ctrl+wheel = zoom (pinch on trackpad fires as ctrl+wheel in Chromium).
        // Plain wheel = pan.
        const rect = surfaceRef.current.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (e.ctrlKey || e.metaKey) {
            // Zoom sensitivity: lower coefficient = finer control per wheel
            // tick. 0.0015 gave ~14% per 120-delta mouse click which felt
            // too coarse for fine positioning; 0.0008 gives ~8% so overview
            // traversal takes more scrolls but individual zoom steps land
            // where you aim.
            const factor = Math.exp(-e.deltaY * 0.0008);
            dispatch({ type: 'ZOOM', factor, cx, cy });
        } else {
            dispatch({ type: 'PAN', dx: -e.deltaX, dy: -e.deltaY });
        }
    }, [dispatch]);

    return {
        setSurfaceRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onWheel,
        marqueeRect,
        connectPendingId,
        connectHoverWorld,
        spaceHeld,
        snapGuides,
        toast,
        cancelConnect: () => { setConnectPendingId(null); setConnectHoverWorld(null); },
    };
}

/** Erase strokes/lines within ERASER_RADIUS world units of point p. */
const ERASER_RADIUS = 18;
function eraseAt(p: Point, s: { lines: Record<string, import('../items/types').DrawnLine>; strokes: Record<string, import('../items/types').FreehandStroke> }, dispatch: (a: any) => void) {
    // Lines: distance from point to segment.
    const toDeleteLines: string[] = [];
    for (const [id, ln] of Object.entries(s.lines)) {
        if (distPointToSegment(p, { x: ln.x1, y: ln.y1 }, { x: ln.x2, y: ln.y2 }) <= ERASER_RADIUS) {
            toDeleteLines.push(id);
        }
    }
    if (toDeleteLines.length) dispatch({ type: 'DELETE_LINES', ids: toDeleteLines });

    // Strokes: any point within radius → nuke the whole stroke (simple + fast).
    const toDeleteStrokes: string[] = [];
    for (const [id, str] of Object.entries(s.strokes)) {
        for (const pt of str.points) {
            const dx = pt.x - p.x, dy = pt.y - p.y;
            if (dx * dx + dy * dy <= ERASER_RADIUS * ERASER_RADIUS) {
                toDeleteStrokes.push(id);
                break;
            }
        }
    }
    if (toDeleteStrokes.length) dispatch({ type: 'DELETE_STROKES', ids: toDeleteStrokes });
}

/** Fat hit-radius for thin drawings (lines/strokes) — world-px. Clicks within
 *  this of the drawn path count as a hit. Scaled up from the pixel width so
 *  a 1-world-px line is still comfortably grabbable at 100% zoom. */
function drawingHitRadius(width: number, zoomInv: number): number {
    // Minimum 8 screen-px of forgiveness translated to world-px, plus half
    // the line's stroke width so fat strokes keep their natural hit area.
    return Math.max(width / 2 + 6 * zoomInv, 8 * zoomInv);
}

export function hitTestLine(
    p: Point,
    lines: Record<string, import('../items/types').DrawnLine>,
    zoomInv: number,
): string | null {
    // Iterate in reverse key order so last-drawn wins (matches visual stacking).
    const keys = Object.keys(lines);
    for (let i = keys.length - 1; i >= 0; i--) {
        const id = keys[i];
        const l = lines[id];
        const radius = drawingHitRadius(l.width, zoomInv);
        if (distPointToSegment(p, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }) <= radius) return id;
    }
    return null;
}

export function hitTestStroke(
    p: Point,
    strokes: Record<string, import('../items/types').FreehandStroke>,
    zoomInv: number,
): string | null {
    const keys = Object.keys(strokes);
    for (let i = keys.length - 1; i >= 0; i--) {
        const id = keys[i];
        const s = strokes[id];
        if (s.points.length === 0) continue;
        const radius = drawingHitRadius(s.width, zoomInv);
        if (s.points.length === 1) {
            const dx = s.points[0].x - p.x, dy = s.points[0].y - p.y;
            if (Math.hypot(dx, dy) <= radius) return id;
            continue;
        }
        for (let j = 1; j < s.points.length; j++) {
            if (distPointToSegment(p, s.points[j - 1], s.points[j]) <= radius) return id;
        }
    }
    return null;
}

/** Bounding rect of a stroke (in world coords). Used for selection ring
 *  + marquee intersection. Returns a small square for single-point strokes. */
export function strokeBounds(s: import('../items/types').FreehandStroke): Rect {
    if (s.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of s.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
    }
    const pad = Math.max(2, s.width / 2);
    return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

export function lineBounds(l: import('../items/types').DrawnLine): Rect {
    const minX = Math.min(l.x1, l.x2);
    const minY = Math.min(l.y1, l.y2);
    const maxX = Math.max(l.x1, l.x2);
    const maxY = Math.max(l.y1, l.y2);
    const pad = Math.max(2, l.width / 2);
    return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

function distPointToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    return Math.hypot(p.x - px, p.y - py);
}
