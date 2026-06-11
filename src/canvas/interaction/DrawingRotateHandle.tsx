import React, { useRef } from 'react';
import { RotateCw } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { refitContainers } from '../items/containerFit';
import type { DrawnLine, FreehandStroke } from '../items/types';

// Rotation handle for a SINGLE selected drawing (line or pen stroke).
// Parallel to RotateHandle (which handles items via the item.rotation field)
// and ContainerRotateHandle (which rotates a container subtree).
//
// Drawings have no rotation field — the multi-select rotate path bakes
// rotation directly into the point geometry (DrawnLine.x1/y1/x2/y2 or
// FreehandStroke.points). We follow the same model here so single-drawing
// rotation matches multi-select behavior and the file format stays stable.
//
// Positioned in SCREEN coords (matches DrawingResizeHandles which renders
// in the screen-space overlay, NOT inside the world transform layer).

interface Bounds { x: number; y: number; w: number; h: number }

interface Props {
    kind: 'line' | 'stroke';
    id: string;
    /** World-space bbox of the drawing (already includes stroke-width pad). */
    bounds: Bounds;
    view: { panX: number; panY: number; zoom: number };
}

const HANDLE_DIAMETER_SCREEN = 14;
const HANDLE_OFFSET_SCREEN = 22;
const ICON_SCREEN = 9;

interface LineSnap {
    kind: 'line';
    x1: number; y1: number;
    x2: number; y2: number;
}
interface StrokeSnap {
    kind: 'stroke';
    points: { x: number; y: number; pressure?: number }[];
}
type GeomSnap = LineSnap | StrokeSnap;

interface DragState {
    pivotX: number;
    pivotY: number;
    startCursorAngle: number;
    snap: GeomSnap;
}

export function DrawingRotateHandle({ kind, id, bounds, view }: Props) {
    const { state, dispatch, pushSnapshot, commit } = useCanvasStore();
    const dragRef = useRef<DragState | null>(null);

    const zoom = Math.max(0.0001, view.zoom);

    // Bbox center in world coords — used as both rotation pivot and the
    // anchor the handle hovers above.
    const cxWorld = bounds.x + bounds.w / 2;
    const cyWorld = bounds.y + bounds.h / 2;
    const topWorldY = bounds.y;

    // Screen-space positions: handle floats `HANDLE_OFFSET_SCREEN` px above
    // the bbox top edge (mirrors the per-item RotateHandle's screen offset).
    const topScreenX = view.panX + cxWorld * zoom;
    const topScreenY = view.panY + topWorldY * zoom;
    const handleScreenX = topScreenX;
    const handleScreenY = topScreenY - HANDLE_OFFSET_SCREEN - HANDLE_DIAMETER_SCREEN / 2;

    function applyRotation(deltaDeg: number) {
        const d = dragRef.current;
        if (!d) return;
        const rad = (deltaDeg * Math.PI) / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const rotPt = (x: number, y: number) => ({
            x: d.pivotX + (x - d.pivotX) * c - (y - d.pivotY) * s,
            y: d.pivotY + (x - d.pivotX) * s + (y - d.pivotY) * c,
        });
        if (d.snap.kind === 'line') {
            const a = rotPt(d.snap.x1, d.snap.y1);
            const b = rotPt(d.snap.x2, d.snap.y2);
            dispatch({
                type: 'UPDATE_LINE',
                id,
                patch: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } as Partial<DrawnLine>,
            });
        } else {
            const nextPoints = d.snap.points.map(p => {
                const np = rotPt(p.x, p.y);
                return { ...p, x: np.x, y: np.y };
            });
            dispatch({
                type: 'UPDATE_STROKE',
                id,
                patch: { points: nextPoints } as Partial<FreehandStroke>,
            });
        }
    }

    function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
        e.stopPropagation();
        e.preventDefault();
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
        pushSnapshot();

        // Snapshot starting geometry so every move re-derives from the
        // pre-gesture state — prevents drift caused by rotating already-
        // rotated geometry on each frame (same trick the multi-select
        // rotate uses).
        let snap: GeomSnap | null = null;
        if (kind === 'line') {
            const ln = state.lines[id];
            if (!ln) return;
            snap = { kind: 'line', x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2 };
        } else {
            const st = state.strokes[id];
            if (!st) return;
            snap = { kind: 'stroke', points: st.points.map(p => ({ ...p })) };
        }

        const cursorWorldX = (e.clientX - view.panX) / zoom;
        const cursorWorldY = (e.clientY - view.panY) / zoom;
        const startCursorAngle =
            (Math.atan2(cursorWorldY - cyWorld, cursorWorldX - cxWorld) * 180) / Math.PI;
        dragRef.current = {
            pivotX: cxWorld,
            pivotY: cyWorld,
            startCursorAngle,
            snap,
        };
    }

    function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
        const d = dragRef.current;
        if (!d) return;
        e.stopPropagation();
        const cursorWorldX = (e.clientX - view.panX) / zoom;
        const cursorWorldY = (e.clientY - view.panY) / zoom;
        const currentAngle =
            (Math.atan2(cursorWorldY - d.pivotY, cursorWorldX - d.pivotX) * 180) / Math.PI;
        let delta = currentAngle - d.startCursorAngle;
        if (e.shiftKey) {
            const SNAP = 15;
            delta = Math.round(delta / SNAP) * SNAP;
        }
        applyRotation(delta);
    }

    function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
        const d = dragRef.current;
        dragRef.current = null;
        if (!d) return;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
        // Live drag dispatched plain UPDATE_* (no commit), so anchor the
        // gesture as one undo step — same idiom the multi-select rotate
        // and ContainerRotateHandle use.
        if (kind === 'line') {
            const ln = state.lines[id];
            if (ln) commit({ type: 'UPDATE_LINE', id, patch: { x1: ln.x1 } });
        } else {
            const st = state.strokes[id];
            if (st) commit({ type: 'UPDATE_STROKE', id, patch: { width: st.width } });
        }
        // Gesture-end auto-grow: rotation bakes new point geometry, which can
        // swing the drawing past its parent container's frame. Grow-only refit
        // wraps it — same as the item/sub-group rotate paths.
        const parentId = kind === 'line' ? state.lines[id]?.parentId : state.strokes[id]?.parentId;
        if (parentId) {
            refitContainers([parentId], {
                items: state.items,
                lines: state.lines,
                strokes: state.strokes,
                dispatch,
                mode: 'grow-only',
            });
        }
    }

    return (
        <>
            {/* Connector line — top-center of bbox to handle center. Pure
                screen-space, drawn as a thin div so we don't need an SVG
                layer for one line. */}
            <div
                style={{
                    position: 'absolute',
                    left: topScreenX - 0.5,
                    top: handleScreenY + HANDLE_DIAMETER_SCREEN / 2,
                    width: 1,
                    height: HANDLE_OFFSET_SCREEN,
                    background: 'rgba(16,185,129,0.6)',
                    pointerEvents: 'none',
                    zIndex: 6,
                }}
            />
            <div
                data-canvas-ui="1"
                className="no-drag"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title="Drag to rotate · Shift snaps to 15°"
                style={{
                    position: 'absolute',
                    left: handleScreenX - HANDLE_DIAMETER_SCREEN / 2,
                    top: handleScreenY - HANDLE_DIAMETER_SCREEN / 2,
                    width: HANDLE_DIAMETER_SCREEN,
                    height: HANDLE_DIAMETER_SCREEN,
                    borderRadius: HANDLE_DIAMETER_SCREEN / 2,
                    background: '#10b981',
                    border: '1px solid rgba(10,10,15,0.85)',
                    boxShadow: '0 0 0 2px rgba(16,185,129,0.22)',
                    cursor: 'grab',
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    zIndex: 7,
                }}
            >
                <RotateCw size={ICON_SCREEN} />
            </div>
        </>
    );
}
