import React, { useRef } from 'react';
import { RotateCw, ArrowRight, Unlink } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { getSelectionBBox } from './scaleSelection';
import { refitContainers, collectAffectedParents } from '../items/containerFit';
import { newId, type Connection } from '../items/types';
import { t } from '../../i18n/strings';

// Outer bounding box that wraps the entire multi-selection (items + lines +
// strokes). Renders only when 2+ entities are selected. All eight handles
// (4 corners, 4 edges) drive a UNIFORM scale around the opposite anchor —
// per spec, edges scale the whole selection rather than stretching one axis.
//
// Per-item / per-drawing handles stay visible while this is showing, but
// they're inert (disabled in their pointerdown handlers when multi-select
// is active). Visual feedback only.

type HandlePos = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

const ALL_HANDLES: HandlePos[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
const HANDLE_SCREEN_SIZE = 9;
const FRAME_PADDING_WORLD = 4;

interface SnapshotItem {
    kind: 'item';
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Item's authored rotation in degrees (TextItem, ImageItem, BoxItem
     *  expose this; other item types ignore it). Captured at drag start so
     *  the group rotation can OFFSET each item's rotation by the gesture
     *  delta without losing whatever angle the item already had. */
    rotation?: number;
    fontSize?: number;
    borderWidth?: number;
    isContainer: boolean;
    parentInSel: boolean;
    /** True if this entity wasn't explicitly selected by the user — it was
     *  pulled in because its (transitive) parent container IS in the
     *  selection. Group rotation must rotate descendants of selected
     *  containers because a container's rotation is just a CSS transform
     *  on its own frame and does NOT cascade to children (children live
     *  in world coords as DOM siblings). Group scale still skips these
     *  to avoid double-application via the container's auto-resize-
     *  children mechanism. */
    implicitDescendant?: boolean;
}
interface SnapshotLine {
    kind: 'line';
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    parentInSel: boolean;
    implicitDescendant?: boolean;
}
interface SnapshotStroke {
    kind: 'stroke';
    id: string;
    points: { x: number; y: number; pressure?: number }[];
    width: number;
    parentInSel: boolean;
    implicitDescendant?: boolean;
}
type SnapshotEntry = SnapshotItem | SnapshotLine | SnapshotStroke;

interface DragState {
    handle: HandlePos;
    // World-space anchor: the FIXED point the selection scales around
    // (opposite corner / edge from the dragged handle).
    ax: number;
    ay: number;
    // Distance from anchor to the dragged handle at drag start (world).
    origDx: number;
    origDy: number;
    // Client coords at drag start — used to derive world delta on move
    // without needing a surface-rect lookup.
    startClientX: number;
    startClientY: number;
    snapshot: SnapshotEntry[];
}

interface RotateDragState {
    /** Pivot: bbox center captured at drag start. Stays fixed for the
     *  duration of the gesture so the group rotates around the same world
     *  point even as items move under it. */
    pivotX: number;
    pivotY: number;
    /** Cursor angle (degrees, atan2 frame) relative to the pivot at the
     *  pointer-down moment. Subsequent moves compute delta vs this. */
    startCursorAngle: number;
    /** Pre-rotation item / line / stroke geometry, used as the base each
     *  pointer-move rebuilds from. Stops drift caused by rotating already-
     *  rotated geometry on every frame. */
    snapshot: SnapshotEntry[];
}

export function MultiSelectionBox() {
    const { state, dispatch, commit, pushSnapshot } = useCanvasStore();
    const dragRef = useRef<DragState | null>(null);
    const rotateDragRef = useRef<RotateDragState | null>(null);

    const selectionCount =
        state.selectedIds.length
        + state.selectedLineIds.length
        + state.selectedStrokeIds.length;
    if (selectionCount < 2) return null;

    const bbox = getSelectionBBox(state);
    if (!bbox) return null;

    const view = state.view;
    const padW = FRAME_PADDING_WORLD / Math.max(0.0001, view.zoom);
    const boxX = bbox.cx - bbox.w / 2 - padW;
    const boxY = bbox.cy - bbox.h / 2 - padW;
    const boxW = bbox.w + padW * 2;
    const boxH = bbox.h + padW * 2;

    function anchorFor(handle: HandlePos): { x: number; y: number } {
        const midX = boxX + boxW / 2;
        const midY = boxY + boxH / 2;
        switch (handle) {
            case 'nw': return { x: boxX + boxW, y: boxY + boxH };
            case 'n':  return { x: midX,        y: boxY + boxH };
            case 'ne': return { x: boxX,        y: boxY + boxH };
            case 'e':  return { x: boxX,        y: midY         };
            case 'se': return { x: boxX,        y: boxY         };
            case 's':  return { x: midX,        y: boxY         };
            case 'sw': return { x: boxX + boxW, y: boxY         };
            case 'w':  return { x: boxX + boxW, y: midY         };
        }
    }

    function handlePos(handle: HandlePos): { x: number; y: number } {
        const midX = boxX + boxW / 2;
        const midY = boxY + boxH / 2;
        switch (handle) {
            case 'nw': return { x: boxX,        y: boxY         };
            case 'n':  return { x: midX,        y: boxY         };
            case 'ne': return { x: boxX + boxW, y: boxY         };
            case 'e':  return { x: boxX + boxW, y: midY         };
            case 'se': return { x: boxX + boxW, y: boxY + boxH };
            case 's':  return { x: midX,        y: boxY + boxH };
            case 'sw': return { x: boxX,        y: boxY + boxH };
            case 'w':  return { x: boxX,        y: midY         };
        }
    }

    function snapshotSelection(): SnapshotEntry[] {
        const itemSelected = new Set(state.selectedIds);
        const out: SnapshotEntry[] = [];
        for (const id of state.selectedIds) {
            const it = state.items[id];
            if (!it) continue;
            const parentInSel = !!(it.parentId && itemSelected.has(it.parentId));
            out.push({
                kind: 'item',
                id,
                x: it.x, y: it.y, w: it.w, h: it.h,
                rotation: (it as any).rotation,
                fontSize: (it as any).fontSize,
                borderWidth: (it as any).borderWidth,
                isContainer: it.type === 'container',
                parentInSel,
            });
        }
        for (const id of state.selectedLineIds) {
            const ln = state.lines[id];
            if (!ln) continue;
            const parentInSel = !!(ln.parentId && itemSelected.has(ln.parentId));
            out.push({
                kind: 'line',
                id,
                x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2,
                width: ln.width,
                parentInSel,
            });
        }
        for (const id of state.selectedStrokeIds) {
            const st = state.strokes[id];
            if (!st) continue;
            const parentInSel = !!(st.parentId && itemSelected.has(st.parentId));
            out.push({
                kind: 'stroke',
                id,
                points: st.points.map(p => ({ ...p })),
                width: st.width,
                parentInSel,
            });
        }

        // Expand selected containers to include their descendants. Without
        // this, group rotation of a multi-selection that includes a
        // container leaves the container's children in place (the
        // container's `rotation` is a CSS transform on the frame only —
        // children live as DOM siblings in world coords, not nested inside
        // the container's transform). Mirrors the transitive walk done by
        // ContainerRotateHandle for the single-container rotate case.
        //
        // Fixed-point iteration to absorb nested containers. Marking every
        // container we add as `visited` per the same lesson learned in
        // ContainerRotateHandle.gatherDescendants — relying on a single-
        // loop "did we change anything" gate without per-entry visited
        // tracking can re-fire forever on certain shapes (see memory
        // entry: feedback_fixed_point_loop_visited).
        const containerSubtree = new Set<string>();
        for (const id of state.selectedIds) {
            const it = state.items[id];
            if (it && it.type === 'container') containerSubtree.add(id);
        }
        if (containerSubtree.size > 0) {
            let changed = true;
            while (changed) {
                changed = false;
                for (const [id, it] of Object.entries(state.items)) {
                    if (containerSubtree.has(id)) continue;
                    if (it.type !== 'container') continue;
                    if (it.parentId && containerSubtree.has(it.parentId)) {
                        containerSubtree.add(id);
                        changed = true;
                    }
                }
            }
            // Pull in any items / lines / strokes whose direct parent sits
            // in the subtree but that weren't explicitly selected (would
            // duplicate otherwise — dedup via the explicit-selection sets).
            for (const [id, it] of Object.entries(state.items)) {
                if (itemSelected.has(id)) continue;
                if (!it.parentId || !containerSubtree.has(it.parentId)) continue;
                out.push({
                    kind: 'item',
                    id,
                    x: it.x, y: it.y, w: it.w, h: it.h,
                    rotation: (it as any).rotation,
                    fontSize: (it as any).fontSize,
                    borderWidth: (it as any).borderWidth,
                    isContainer: it.type === 'container',
                    parentInSel: false,
                    implicitDescendant: true,
                });
            }
            const lineSelected = new Set(state.selectedLineIds);
            for (const [lid, ln] of Object.entries(state.lines)) {
                if (lineSelected.has(lid)) continue;
                if (!ln.parentId || !containerSubtree.has(ln.parentId)) continue;
                out.push({
                    kind: 'line',
                    id: lid,
                    x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2,
                    width: ln.width,
                    parentInSel: false,
                    implicitDescendant: true,
                });
            }
            const strokeSelected = new Set(state.selectedStrokeIds);
            for (const [sid, st] of Object.entries(state.strokes)) {
                if (strokeSelected.has(sid)) continue;
                if (!st.parentId || !containerSubtree.has(st.parentId)) continue;
                out.push({
                    kind: 'stroke',
                    id: sid,
                    points: st.points.map(p => ({ ...p })),
                    width: st.width,
                    parentInSel: false,
                    implicitDescendant: true,
                });
            }
        }

        return out;
    }

    function applyScale(snap: SnapshotEntry[], factor: number, ax: number, ay: number) {
        if (!isFinite(factor) || factor <= 0.01) return;
        // Phase 22.5: collect item patches for one bulk dispatch (see same
        // pattern in applyRotate).
        const itemPatches: Array<{ id: string; patch: any }> = [];
        for (const e of snap) {
            // Skip both explicit-parent-in-selection AND implicit
            // descendants. The container's own resize already cascades
            // size/position to children via the auto-scale-children
            // mechanism in ContainerItemView, so scaling them again here
            // would double-apply. (Rotation does NOT cascade — see
            // applyRotate which keeps implicit descendants.)
            if (e.parentInSel) continue;
            if (e.implicitDescendant) continue;
            if (e.kind === 'item') {
                const newX = ax + (e.x - ax) * factor;
                const newY = ay + (e.y - ay) * factor;
                const newW = Math.max(1, e.w * factor);
                const newH = Math.max(1, e.h * factor);
                const patch: any = { x: newX, y: newY, w: newW, h: newH };
                if (!e.isContainer) {
                    if (typeof e.fontSize === 'number') patch.fontSize = Math.max(1, e.fontSize * factor);
                    if (typeof e.borderWidth === 'number') patch.borderWidth = Math.max(0.5, e.borderWidth * factor);
                }
                itemPatches.push({ id: e.id, patch });
            } else if (e.kind === 'line') {
                dispatch({
                    type: 'UPDATE_LINE',
                    id: e.id,
                    patch: {
                        x1: ax + (e.x1 - ax) * factor,
                        y1: ay + (e.y1 - ay) * factor,
                        x2: ax + (e.x2 - ax) * factor,
                        y2: ay + (e.y2 - ay) * factor,
                        width: Math.max(0.5, e.width * factor),
                    },
                });
            } else {
                dispatch({
                    type: 'UPDATE_STROKE',
                    id: e.id,
                    patch: {
                        points: e.points.map(p => ({
                            ...p,
                            x: ax + (p.x - ax) * factor,
                            y: ay + (p.y - ay) * factor,
                        })),
                        width: Math.max(0.5, e.width * factor),
                    },
                });
            }
        }
        // Flush item patches in one bulk dispatch.
        if (itemPatches.length === 1) {
            const u = itemPatches[0];
            dispatch({ type: 'UPDATE_ITEM', id: u.id, patch: u.patch });
        } else if (itemPatches.length > 1) {
            dispatch({ type: 'UPDATE_ITEMS_BULK', updates: itemPatches });
        }
    }

    // Phase 22.5: rotate every selected entity around (pivotX, pivotY) by
    // `deltaDeg` degrees. Geometry rebuilt from the pre-gesture snapshot
    // each call so accumulated rotations don't drift. Item rotation
    // properties (text/image/box only) get OFFSET by the delta so their
    // visual angle stacks with the group rotation; non-rotatable items
    // (containers, file/code/link/video/audio cards) just move position.
    function applyRotate(snap: SnapshotEntry[], deltaDeg: number, pivotX: number, pivotY: number) {
        const rad = (deltaDeg * Math.PI) / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const rotPt = (x: number, y: number) => ({
            x: pivotX + (x - pivotX) * c - (y - pivotY) * s,
            y: pivotY + (x - pivotX) * s + (y - pivotY) * c,
        });
        // Phase 22.5: collect item patches for one bulk dispatch per frame
        // instead of N dispatches. Lines/strokes still dispatch individually
        // (separate action types, lower count in practice).
        const itemPatches: Array<{ id: string; patch: any }> = [];
        for (const e of snap) {
            // Rotate every entry — including explicitly-selected children
            // whose parent is also selected. A container's rotation patch
            // is just a CSS transform on its own frame and does NOT
            // cascade to children (they live as siblings in world coords).
            // The previous `if (e.parentInSel) continue;` skip left those
            // children un-rotated inside a rotated parent — visible as
            // a child whose selection ring stays axis-aligned while the
            // parent frame tilts.
            if (e.kind === 'item') {
                const oldCx = e.x + e.w / 2;
                const oldCy = e.y + e.h / 2;
                const np = rotPt(oldCx, oldCy);
                const patch: any = {
                    x: np.x - e.w / 2,
                    y: np.y - e.h / 2,
                };
                // Always accumulate rotation — containers ARE rotatable now
                // (see ContainerRotateHandle / ContainerItem frame
                // transform), so the previous "containers without a prior
                // rotation field stay axis-aligned" guard left the frame
                // visually un-rotated during multi-select rotate.
                const base = typeof e.rotation === 'number' ? e.rotation : 0;
                patch.rotation = base + deltaDeg;
                itemPatches.push({ id: e.id, patch });
            } else if (e.kind === 'line') {
                const a = rotPt(e.x1, e.y1);
                const b = rotPt(e.x2, e.y2);
                dispatch({
                    type: 'UPDATE_LINE',
                    id: e.id,
                    patch: { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
                });
            } else {
                dispatch({
                    type: 'UPDATE_STROKE',
                    id: e.id,
                    patch: {
                        points: e.points.map(p => {
                            const np = rotPt(p.x, p.y);
                            return { ...p, x: np.x, y: np.y };
                        }),
                    },
                });
            }
        }
        // Flush all item patches in one bulk dispatch — the reducer runs
        // ONE shallow-copy of state.items instead of N. Big win when the
        // selection has many items (rotating a 10-item group goes from
        // 10× O(N_total) to 1× O(N_total) of object-copy work per frame).
        if (itemPatches.length === 1) {
            const u = itemPatches[0];
            dispatch({ type: 'UPDATE_ITEM', id: u.id, patch: u.patch });
        } else if (itemPatches.length > 1) {
            dispatch({ type: 'UPDATE_ITEMS_BULK', updates: itemPatches });
        }
    }

    function onRotatePointerDown(e: React.PointerEvent<HTMLDivElement>) {
        e.stopPropagation();
        e.preventDefault();
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
        pushSnapshot();
        const pivotX = boxX + boxW / 2;
        const pivotY = boxY + boxH / 2;
        const z = Math.max(0.0001, view.zoom);
        const cursorWorldX = (e.clientX - view.panX) / z;
        const cursorWorldY = (e.clientY - view.panY) / z;
        const startCursorAngle = (Math.atan2(cursorWorldY - pivotY, cursorWorldX - pivotX) * 180) / Math.PI;
        rotateDragRef.current = {
            pivotX, pivotY,
            startCursorAngle,
            snapshot: snapshotSelection(),
        };
    }

    function onRotatePointerMove(e: React.PointerEvent<HTMLDivElement>) {
        const d = rotateDragRef.current;
        if (!d) return;
        e.stopPropagation();
        const z = Math.max(0.0001, view.zoom);
        const cursorWorldX = (e.clientX - view.panX) / z;
        const cursorWorldY = (e.clientY - view.panY) / z;
        const angle = (Math.atan2(cursorWorldY - d.pivotY, cursorWorldX - d.pivotX) * 180) / Math.PI;
        let delta = angle - d.startCursorAngle;
        // Shift snaps to 15° increments (Figma convention).
        if (e.shiftKey) {
            const SNAP = 15;
            delta = Math.round(delta / SNAP) * SNAP;
        }
        applyRotate(d.snapshot, delta, d.pivotX, d.pivotY);
    }

    function onRotatePointerUp(e: React.PointerEvent<HTMLDivElement>) {
        const d = rotateDragRef.current;
        rotateDragRef.current = null;
        if (!d) return;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
        // Same undo-anchoring trick as the scale path: one no-op commit so
        // the gesture lands as ONE step in the undo stack.
        if (state.selectedIds.length > 0) {
            const id = state.selectedIds[0];
            const it = state.items[id];
            if (it) commit({ type: 'UPDATE_ITEM', id, patch: { x: it.x } });
        }
        // Gesture-end auto-grow: rotation expands each child's visual
        // envelope. Refit every parent the selection touches so each
        // group frame wraps its now-rotated children. Skipped per
        // container when autoSized===false (user-shaped).
        const parents = collectAffectedParents(state.selectedIds, state.items);
        if (parents.size > 0) {
            refitContainers(parents, {
                items: state.items,
                lines: state.lines,
                strokes: state.strokes,
                dispatch,
                mode: 'grow-only',
            });
        }
    }

    function onPointerDown(e: React.PointerEvent<HTMLDivElement>, handle: HandlePos) {
        e.stopPropagation();
        e.preventDefault();
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
        const anchor = anchorFor(handle);
        const hp = handlePos(handle);
        dragRef.current = {
            handle,
            ax: anchor.x,
            ay: anchor.y,
            origDx: hp.x - anchor.x,
            origDy: hp.y - anchor.y,
            startClientX: e.clientX,
            startClientY: e.clientY,
            snapshot: snapshotSelection(),
        };
    }

    function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
        const d = dragRef.current;
        if (!d) return;
        e.stopPropagation();
        // Cumulative world-space delta since drag started. Same math the
        // per-item ResizeHandle uses — avoids needing to know where the
        // canvas surface is in the DOM.
        const z = Math.max(0.0001, view.zoom);
        const deltaWX = (e.clientX - d.startClientX) / z;
        const deltaWY = (e.clientY - d.startClientY) / z;
        // Current handle offset from anchor = original offset + drag delta.
        const newDx = d.origDx + deltaWX;
        const newDy = d.origDy + deltaWY;
        const isCorner = d.handle.length === 2;
        let factor: number;
        if (isCorner) {
            // Average per-axis ratio gives a smooth uniform scale that
            // responds to motion in either direction.
            const fx = d.origDx !== 0 ? newDx / d.origDx : 1;
            const fy = d.origDy !== 0 ? newDy / d.origDy : 1;
            factor = (Math.abs(fx) + Math.abs(fy)) / 2;
        } else {
            // Edge handle — only the relevant axis has a non-zero origD;
            // use that as the scale factor and apply uniformly.
            factor = Math.abs(d.origDx) > Math.abs(d.origDy)
                ? (d.origDx !== 0 ? Math.abs(newDx) / Math.abs(d.origDx) : 1)
                : (d.origDy !== 0 ? Math.abs(newDy) / Math.abs(d.origDy) : 1);
        }
        applyScale(d.snapshot, factor, d.ax, d.ay);
    }

    function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
        const d = dragRef.current;
        dragRef.current = null;
        if (!d) return;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
        // Anchor an undo entry. Live drag dispatched plain UPDATE_* without
        // commit() (no undo entries during preview). On release, issue one
        // commit() of a no-op patch so the undo stack records this drag as
        // a single step. Using the first selected item's current x as
        // both old and new keeps it idempotent visually.
        if (state.selectedIds.length > 0) {
            const id = state.selectedIds[0];
            const it = state.items[id];
            if (it) commit({ type: 'UPDATE_ITEM', id, patch: { x: it.x } });
        }
        // Gesture-end auto-grow: scaling enlarges each child's footprint,
        // which can push past the parent frame. Refit every parent the
        // selection touches so each group frame wraps its now-larger
        // children. Skipped per container when autoSized===false.
        const parents = collectAffectedParents(state.selectedIds, state.items);
        if (parents.size > 0) {
            refitContainers(parents, {
                items: state.items,
                lines: state.lines,
                strokes: state.strokes,
                dispatch,
                mode: 'grow-only',
            });
        }
    }

    const handleSize = HANDLE_SCREEN_SIZE / Math.max(0.0001, view.zoom);
    const stroke = 1 / Math.max(0.0001, view.zoom);

    // Phase 22.5: rotation-handle metrics. Same screen-px sizing strategy as
    // the per-item RotateHandle so the chrome feels consistent.
    const ROT_DIAMETER_SCREEN = 14;
    const ROT_OFFSET_SCREEN = 22;
    const surfaceZoom = Math.max(0.0001, view.zoom);
    const rotDiameter = ROT_DIAMETER_SCREEN / surfaceZoom;
    const rotOffset = ROT_OFFSET_SCREEN / surfaceZoom;
    const rotCenterX = boxX + boxW / 2;
    const rotCenterY = boxY - rotOffset - rotDiameter / 2;
    const shadowWorld = 2 / surfaceZoom;

    return (
        <>
            <div
                style={{
                    position: 'absolute',
                    left: boxX,
                    top: boxY,
                    width: boxW,
                    height: boxH,
                    border: `${stroke}px dashed #10b981`,
                    pointerEvents: 'none',
                    boxShadow: `inset 0 0 0 ${stroke}px rgba(16,185,129,0.15)`,
                }}
            />
            {/* Phase 22.5: connector line from top-middle of bbox to the
                group rotation handle so the handle reads as "attached" rather
                than floating. */}
            <div
                style={{
                    position: 'absolute',
                    left: rotCenterX - stroke / 2,
                    top: boxY - rotOffset,
                    width: stroke,
                    height: rotOffset,
                    background: '#10b981',
                    pointerEvents: 'none',
                }}
            />
            {/* Group rotation handle. Mirrors the per-item RotateHandle UX:
                Shift = snap to 15°, drag = rotate selection around bbox
                centroid. Cursor is the standard "grab" so users recognize
                this as a rotation grip. Uses Lucide RotateCw — the hand-
                coded arc-arrow it replaces collapsed to a download-arrow
                silhouette at low zoom (same fix already in
                ContainerRotateHandle). */}
            <div
                onPointerDown={onRotatePointerDown}
                onPointerMove={onRotatePointerMove}
                onPointerUp={onRotatePointerUp}
                title="Drag to rotate group · Shift snaps to 15°"
                style={{
                    position: 'absolute',
                    left: rotCenterX - rotDiameter / 2,
                    top: rotCenterY - rotDiameter / 2,
                    width: rotDiameter,
                    height: rotDiameter,
                    background: '#10b981',
                    border: `${stroke}px solid rgba(10,10,15,0.85)`,
                    boxShadow: `0 0 0 ${shadowWorld}px rgba(16,185,129,0.22)`,
                    borderRadius: '50%',
                    cursor: 'grab',
                    pointerEvents: 'auto',
                    zIndex: 13,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                }}
            >
                <RotateCw size={9 / surfaceZoom} />
            </div>
            {ALL_HANDLES.map(h => {
                const p = handlePos(h);
                return (
                    <div
                        key={h}
                        onPointerDown={(e) => onPointerDown(e, h)}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        style={{
                            position: 'absolute',
                            left: p.x - handleSize / 2,
                            top: p.y - handleSize / 2,
                            width: handleSize,
                            height: handleSize,
                            background: '#10b981',
                            border: `${stroke}px solid #ffffff`,
                            cursor: cursorFor(h),
                            pointerEvents: 'auto',
                            zIndex: 12,
                        }}
                    />
                );
            })}
            {/* "Link" pill — when EXACTLY two items (no lines/strokes) are
                selected, one click connects them with a real arrow. The
                no-typing path for nearby cards (the type-a-name picker handles
                far ones). Sits BELOW the frame so it can't collide with the
                rotate handle above. Screen-constant via /surfaceZoom. */}
            {state.selectedIds.length === 2 && state.selectedLineIds.length === 0 && state.selectedStrokeIds.length === 0 && (() => {
                const [fromId, toId] = state.selectedIds;
                // Arrow(s) between the two selected items, either direction. If any
                // exist the pill toggles to DISCONNECT (removes them); otherwise it
                // connects. One click either way.
                const linkedIds = Object.values(state.connections)
                    .filter(c => (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId))
                    .map(c => c.id);
                const alreadyLinked = linkedIds.length > 0;
                const pillH = 22 / surfaceZoom;
                const gap = 12 / surfaceZoom;
                return (
                    <div
                        onPointerDown={(e) => { e.stopPropagation(); }}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!fromId || !toId || fromId === toId) return;
                            if (alreadyLinked) {
                                commit({ type: 'DELETE_CONNECTIONS', ids: linkedIds });
                            } else {
                                const conn: Connection = {
                                    id: newId('conn'), fromId, toId, label: '',
                                    color: state.color, width: 2, arrowHead: true, style: 'solid', createdBy: 'user',
                                };
                                commit({ type: 'ADD_CONNECTION', connection: conn });
                            }
                        }}
                        title={alreadyLinked ? t('canvas.link.unlink') : t('canvas.link.label')}
                        style={{
                            position: 'absolute',
                            left: boxX + boxW / 2,
                            top: boxY + boxH + gap,
                            transform: 'translateX(-50%)',
                            height: pillH,
                            padding: `0 ${10 / surfaceZoom}px`,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5 / surfaceZoom,
                            background: alreadyLinked ? 'rgba(239,68,68,0.9)' : '#10b981',
                            color: 'white',
                            border: `${stroke}px solid rgba(10,10,15,0.85)`,
                            borderRadius: pillH / 2,
                            fontSize: 12 / surfaceZoom,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            cursor: 'pointer',
                            pointerEvents: 'auto',
                            zIndex: 13,
                            boxShadow: alreadyLinked
                                ? `0 0 0 ${shadowWorld}px rgba(239,68,68,0.22)`
                                : `0 0 0 ${shadowWorld}px rgba(16,185,129,0.22)`,
                        }}
                    >
                        {alreadyLinked ? <Unlink size={11 / surfaceZoom} /> : <ArrowRight size={11 / surfaceZoom} />}
                        {alreadyLinked ? t('canvas.link.unlink') : t('canvas.link.label')}
                    </div>
                );
            })()}
        </>
    );
}

function cursorFor(h: HandlePos): string {
    switch (h) {
        case 'nw': case 'se': return 'nwse-resize';
        case 'ne': case 'sw': return 'nesw-resize';
        case 'n':  case 's':  return 'ns-resize';
        case 'e':  case 'w':  return 'ew-resize';
    }
}
