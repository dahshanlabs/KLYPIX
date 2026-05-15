import React, { useRef } from 'react';
import { useCanvasStore } from '../state/canvasStore';
import type { DrawnLine, FreehandStroke } from '../items/types';

// 8-handle resize for drawings (straight lines + pen strokes). Parallel to
// ResizeHandle.tsx — separate file because drawings live in state.lines /
// state.strokes (not state.items) and need their own mutation actions.
//
// Behavior (spec A2):
//   - Edges (N/S/E/W): one-axis stretch; stroke width unchanged.
//   - Corners (NW/NE/SW/SE): proportional scale; stroke width grows with
//     max(scaleX, scaleY).
//   - Shift + corner: free stretch (aspect NOT preserved).
//   - Anchor = opposite corner/edge so the user feels they're dragging
//     the side they grabbed.

export type HandlePos = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

interface Bounds { x: number; y: number; w: number; h: number }

interface Props {
    kind: 'line' | 'stroke';
    id: string;
    bounds: Bounds;           // world coords of the drawing's bbox
    view: { panX: number; panY: number; zoom: number };
}

const HANDLES: HandlePos[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
const HANDLE_SIZE_PX = 10;    // screen-px
const MIN_SIZE_WORLD = 2;      // minimum drawing bbox size after resize

function cursorFor(pos: HandlePos): string {
    switch (pos) {
        case 'nw': case 'se': return 'nwse-resize';
        case 'ne': case 'sw': return 'nesw-resize';
        case 'n': case 's': return 'ns-resize';
        case 'e': case 'w': return 'ew-resize';
    }
}

function screenOffsetFor(pos: HandlePos, wPx: number, hPx: number) {
    const mx = wPx / 2, my = hPx / 2;
    switch (pos) {
        case 'nw': return { x: 0, y: 0 };
        case 'n':  return { x: mx, y: 0 };
        case 'ne': return { x: wPx, y: 0 };
        case 'w':  return { x: 0, y: my };
        case 'e':  return { x: wPx, y: my };
        case 'sw': return { x: 0, y: hPx };
        case 's':  return { x: mx, y: hPx };
        case 'se': return { x: wPx, y: hPx };
    }
}

/** Anchor in WORLD coords — the opposite corner/edge the drag scales away from. */
function anchorWorldFor(pos: HandlePos, b: Bounds) {
    switch (pos) {
        case 'nw': return { x: b.x + b.w, y: b.y + b.h };
        case 'ne': return { x: b.x,        y: b.y + b.h };
        case 'se': return { x: b.x,        y: b.y };
        case 'sw': return { x: b.x + b.w, y: b.y };
        case 'n':  return { x: b.x + b.w / 2, y: b.y + b.h };
        case 's':  return { x: b.x + b.w / 2, y: b.y };
        case 'e':  return { x: b.x,        y: b.y + b.h / 2 };
        case 'w':  return { x: b.x + b.w, y: b.y + b.h / 2 };
    }
}

function isCorner(pos: HandlePos): boolean {
    return pos === 'nw' || pos === 'ne' || pos === 'sw' || pos === 'se';
}
function affectsX(pos: HandlePos): boolean {
    return pos !== 'n' && pos !== 's';
}
function affectsY(pos: HandlePos): boolean {
    return pos !== 'e' && pos !== 'w';
}

export function DrawingResizeHandles({ kind, id, bounds, view }: Props) {
    return (
        <>
            {HANDLES.map(pos => (
                <SingleHandle key={pos} kind={kind} id={id} bounds={bounds} view={view} pos={pos} />
            ))}
        </>
    );
}

function SingleHandle({ kind, id, bounds, view, pos }: Props & { pos: HandlePos }) {
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    const dragRef = useRef<{
        anchor: { x: number; y: number };
        srcLine?: DrawnLine;
        srcStroke?: FreehandStroke;
        srcBounds: Bounds;
        snapshotted: boolean;
    } | null>(null);

    const zoom = Math.max(0.0001, view.zoom);
    const wPx = bounds.w * zoom;
    const hPx = bounds.h * zoom;
    const off = screenOffsetFor(pos, wPx, hPx);
    const screenX = view.panX + bounds.x * zoom + off.x;
    const screenY = view.panY + bounds.y * zoom + off.y;

    return (
        <div
            data-canvas-ui="1"
            onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                const src = kind === 'line' ? state.lines[id] : undefined;
                const src2 = kind === 'stroke' ? state.strokes[id] : undefined;
                if (!src && !src2) return;
                dragRef.current = {
                    anchor: anchorWorldFor(pos, bounds),
                    srcLine: src,
                    srcStroke: src2,
                    srcBounds: bounds,
                    snapshotted: false,
                };
            }}
            onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d) return;
                if (!d.snapshotted) {
                    pushSnapshot();
                    d.snapshotted = true;
                }
                // Screen delta → world delta
                const dxWorld = e.movementX / zoom;
                const dyWorld = e.movementY / zoom;
                // Accumulate via bounds stored on ref
                const prevW = d.srcBounds.w;
                const prevH = d.srcBounds.h;
                let newW = prevW;
                let newH = prevH;
                // Compute new bounds from handle direction. For an
                // edge, only one axis changes. For a corner, both.
                // Signs: handles on the east/south grow with positive
                // delta; west/north grow with negative delta (reversed).
                if (affectsX(pos)) {
                    const sx = (pos === 'nw' || pos === 'w' || pos === 'sw') ? -1 : 1;
                    newW = Math.max(MIN_SIZE_WORLD, prevW + dxWorld * sx);
                }
                if (affectsY(pos)) {
                    const sy = (pos === 'nw' || pos === 'n' || pos === 'ne') ? -1 : 1;
                    newH = Math.max(MIN_SIZE_WORLD, prevH + dyWorld * sy);
                }
                // Corner drag: preserve aspect UNLESS Shift is held.
                if (isCorner(pos) && !e.shiftKey) {
                    const ratio = prevW > 0 && prevH > 0 ? prevH / prevW : 1;
                    // Follow whichever axis moved more.
                    if (Math.abs(dxWorld) * prevH > Math.abs(dyWorld) * prevW) {
                        newH = newW * ratio;
                    } else {
                        newW = newH / (ratio || 1);
                    }
                }
                const scaleX = newW / Math.max(0.0001, prevW);
                const scaleY = newH / Math.max(0.0001, prevH);
                const a = d.anchor;
                // Persist the updated bounds back onto ref so the next
                // pointermove frame scales from the NEW size (not from
                // the initial size — that compounds delta every frame).
                d.srcBounds = {
                    x: pos === 'nw' || pos === 'w' || pos === 'sw'
                        ? a.x - newW
                        : a.x,
                    y: pos === 'nw' || pos === 'n' || pos === 'ne'
                        ? a.y - newH
                        : a.y,
                    w: newW,
                    h: newH,
                };

                // Corner scale affects stroke width; edge doesn't.
                const widthScale = isCorner(pos) ? Math.max(scaleX, scaleY) : 1;

                if (d.srcLine) {
                    const src = d.srcLine;
                    const x1 = a.x + (src.x1 - a.x) * scaleX;
                    const y1 = a.y + (src.y1 - a.y) * scaleY;
                    const x2 = a.x + (src.x2 - a.x) * scaleX;
                    const y2 = a.y + (src.y2 - a.y) * scaleY;
                    dispatch({
                        type: 'UPDATE_LINE',
                        id,
                        patch: {
                            x1, y1, x2, y2,
                            width: Math.max(0.5, src.width * widthScale),
                        },
                    });
                    // Snapshot the post-update as the new "src" so the
                    // next frame scales from here.
                    d.srcLine = {
                        ...src,
                        x1, y1, x2, y2,
                        width: Math.max(0.5, src.width * widthScale),
                    };
                } else if (d.srcStroke) {
                    const src = d.srcStroke;
                    const newPoints = src.points.map(p => ({
                        ...p,
                        x: a.x + (p.x - a.x) * scaleX,
                        y: a.y + (p.y - a.y) * scaleY,
                    }));
                    const newWidth = Math.max(0.5, src.width * widthScale);
                    dispatch({
                        type: 'UPDATE_STROKE',
                        id,
                        patch: { points: newPoints, width: newWidth },
                    });
                    d.srcStroke = { ...src, points: newPoints, width: newWidth };
                }
            }}
            onPointerUp={(e) => {
                (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
                dragRef.current = null;
            }}
            onPointerCancel={(e) => {
                (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
                dragRef.current = null;
            }}
            style={{
                position: 'absolute',
                left: screenX - HANDLE_SIZE_PX / 2,
                top: screenY - HANDLE_SIZE_PX / 2,
                width: HANDLE_SIZE_PX,
                height: HANDLE_SIZE_PX,
                background: '#10b981',
                border: '1px solid #0a0a0f',
                borderRadius: 2,
                cursor: cursorFor(pos),
                pointerEvents: 'auto',
                zIndex: 6,
            }}
        />
    );
}
