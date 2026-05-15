import React, { useRef } from 'react';
import { useCanvasStore } from '../state/canvasStore';
import { getSelectionBBox } from './scaleSelection';

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
    fontSize?: number;
    borderWidth?: number;
    isContainer: boolean;
    parentInSel: boolean;
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
}
interface SnapshotStroke {
    kind: 'stroke';
    id: string;
    points: { x: number; y: number; pressure?: number }[];
    width: number;
    parentInSel: boolean;
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

export function MultiSelectionBox() {
    const { state, dispatch, commit } = useCanvasStore();
    const dragRef = useRef<DragState | null>(null);

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
        return out;
    }

    function applyScale(snap: SnapshotEntry[], factor: number, ax: number, ay: number) {
        if (!isFinite(factor) || factor <= 0.01) return;
        for (const e of snap) {
            if (e.parentInSel) continue;
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
                dispatch({ type: 'UPDATE_ITEM', id: e.id, patch });
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
    }

    const handleSize = HANDLE_SCREEN_SIZE / Math.max(0.0001, view.zoom);
    const stroke = 1 / Math.max(0.0001, view.zoom);

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
