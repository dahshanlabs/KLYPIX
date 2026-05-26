import React, { useRef } from 'react';
import { RotateCw } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import type { ContainerItem, CanvasItem, DrawnLine, FreehandStroke } from '../items/types';

// Group rotation handle for a SINGLE selected container. Rotates the
// container's frame plus every descendant (items, lines, strokes,
// transitively) around the container's centroid. Mirrors the gesture
// model of MultiSelectionBox's rotate handle but scoped to one
// container's subtree.
//
// Why a dedicated handle (instead of reusing per-item RotateHandle):
//   - The per-item handle only sets item.rotation. For a container that's
//     just a visual flag — descendants live as siblings in the world
//     transform layer, so they wouldn't follow.
//   - Multi-selection rotate already does the descendant-walking math,
//     but it's gated to selectionCount >= 2. A single container is a
//     count of 1, so it falls through that gate.
//
// v1 limitations (kept tight on purpose):
//   - Handle position uses the un-rotated AABB top-center, like the
//     per-item RotateHandle. The handle floats above the original top
//     edge regardless of current rotation, then is positioned by rotating
//     that anchor with `rotation` so it stays attached to the rotated
//     visual.
//   - Resize handles on a rotated container still orbit around the
//     un-rotated bounds (ResizeHandle does support a rotation prop —
//     we pass it through — but the cumulative resize math under
//     rotation has its own edge cases we leave for v2).
//   - Subsequent vector-scale resizes scale rotated positions from the
//     container's top-left instead of its centroid, so a rotate-then-
//     resize gesture will warp child positions. Accept for v1.

interface SnapshotItem {
    kind: 'item';
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation?: number;
    /** authoredInParent at drag start, so we can write the rotated relX/relY
     *  back to the snapshot's authored anchor — keeps the vector-scale
     *  derivation (in ContainerItemView's big useEffect) consistent with
     *  the new rotated layout. */
    authoredInParent?: CanvasItem['authoredInParent'];
}
interface SnapshotLine {
    kind: 'line';
    id: string;
    x1: number; y1: number;
    x2: number; y2: number;
    authoredInParent?: DrawnLine['authoredInParent'];
}
interface SnapshotStroke {
    kind: 'stroke';
    id: string;
    points: { x: number; y: number; pressure?: number }[];
    authoredInParent?: FreehandStroke['authoredInParent'];
}
type SnapshotEntry = SnapshotItem | SnapshotLine | SnapshotStroke;

interface DragState {
    pivotX: number;
    pivotY: number;
    startCursorAngle: number;
    startContainerRotation: number;
    descendants: SnapshotEntry[];
}

interface Props {
    item: ContainerItem;
}

export function ContainerRotateHandle({ item }: Props) {
    const { state, dispatch, pushSnapshot, commit } = useCanvasStore();
    const dragRef = useRef<DragState | null>(null);

    // Hide when 2+ entities are selected — MultiSelectionBox owns the
    // group rotate handle in that case (around the bbox of everything,
    // not just this container). Mirrors the same gate per-item
    // RotateHandle uses, so the two paths can't conflict.
    const totalSel =
        state.selectedIds.length
        + state.selectedLineIds.length
        + state.selectedStrokeIds.length;
    if (totalSel >= 2) return null;

    const surfaceZoom = Math.max(0.01, state.view.zoom);

    // Same visual constants as the per-item RotateHandle so the chrome
    // feels consistent across single-item and group-rotate UIs.
    const HANDLE_DIAMETER_SCREEN = 14;
    const HANDLE_OFFSET_SCREEN = 22;
    const handleDiameter = HANDLE_DIAMETER_SCREEN / surfaceZoom;
    const handleOffset = HANDLE_OFFSET_SCREEN / surfaceZoom;
    const borderWidthWorld = 1 / surfaceZoom;
    const shadowWorld = 2 / surfaceZoom;

    const rotation = item.rotation ?? 0;
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;

    // Handle anchor in container-local coords (un-rotated).
    const localAnchorX = 0;
    const localAnchorY = -(item.h / 2) - handleOffset - handleDiameter / 2;
    const topLocalY = -item.h / 2;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const worldDx = localAnchorX * cos - localAnchorY * sin;
    const worldDy = localAnchorX * sin + localAnchorY * cos;
    const handleCenterX = cx + worldDx;
    const handleCenterY = cy + worldDy;
    const topWorldX = cx + (0 * cos - topLocalY * sin);
    const topWorldY = cy + (0 * sin + topLocalY * cos);

    function gatherDescendants(): SnapshotEntry[] {
        // Two-phase walk. Phase 1 builds the set of containers in the
        // subtree (transitive — a nested group inside a nested group
        // counts) via fixed-point iteration. Phase 2 collects every
        // item / line / stroke whose direct parent is in that set.
        //
        // The previous single-loop version pushed non-containers into
        // `out` on every iteration without marking them visited, so
        // `changed = true` re-fired forever and the renderer locked the
        // event loop on pointerdown — that was the PC-freeze.
        const containerIds = new Set<string>([item.id]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const [id, it] of Object.entries(state.items)) {
                if (containerIds.has(id)) continue;
                if (it.type !== 'container') continue;
                if (it.parentId && containerIds.has(it.parentId)) {
                    containerIds.add(id);
                    changed = true;
                }
            }
        }

        const out: SnapshotEntry[] = [];
        for (const [id, it] of Object.entries(state.items)) {
            if (id === item.id) continue;
            if (!it.parentId || !containerIds.has(it.parentId)) continue;
            out.push({
                kind: 'item',
                id,
                x: it.x, y: it.y, w: it.w, h: it.h,
                rotation: (it as any).rotation,
                authoredInParent: it.authoredInParent,
            });
        }
        for (const [lid, ln] of Object.entries(state.lines)) {
            if (!ln.parentId || !containerIds.has(ln.parentId)) continue;
            out.push({
                kind: 'line',
                id: lid,
                x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2,
                authoredInParent: ln.authoredInParent,
            });
        }
        for (const [sid, st] of Object.entries(state.strokes)) {
            if (!st.parentId || !containerIds.has(st.parentId)) continue;
            out.push({
                kind: 'stroke',
                id: sid,
                points: st.points.map(p => ({ ...p })),
                authoredInParent: st.authoredInParent,
            });
        }
        return out;
    }

    function applyRotation(snap: SnapshotEntry[], totalDelta: number) {
        const rad = (totalDelta * Math.PI) / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const rotPt = (x: number, y: number) => ({
            x: cx + (x - cx) * c - (y - cy) * s,
            y: cy + (x - cx) * s + (y - cy) * c,
        });

        const itemPatches: Array<{ id: string; patch: any }> = [];
        for (const e of snap) {
            if (e.kind === 'item') {
                // Rotate the item's CENTER around the container centroid,
                // then derive the new top-left. Using center keeps the
                // item visually anchored as it spins.
                const oldCx = e.x + e.w / 2;
                const oldCy = e.y + e.h / 2;
                const np = rotPt(oldCx, oldCy);
                const newX = np.x - e.w / 2;
                const newY = np.y - e.h / 2;
                const patch: any = { x: newX, y: newY };
                // Accumulate own rotation so the visual orientation of
                // each child matches the group rotation.
                const base = typeof e.rotation === 'number' ? e.rotation : 0;
                patch.rotation = base + totalDelta;
                // Keep authoredInParent in sync with the new rotated
                // layout so the next vector-scale resize pass doesn't
                // snap children back to their un-rotated anchors. relX/Y
                // are stored relative to container.x / container.y (top-
                // left), independent of container w/h.
                if (e.authoredInParent) {
                    patch.authoredInParent = {
                        ...e.authoredInParent,
                        relX: newX - item.x,
                        relY: newY - item.y,
                    };
                }
                itemPatches.push({ id: e.id, patch });
            } else if (e.kind === 'line') {
                const a = rotPt(e.x1, e.y1);
                const b = rotPt(e.x2, e.y2);
                const linePatch: any = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
                if (e.authoredInParent) {
                    linePatch.authoredInParent = {
                        ...e.authoredInParent,
                        x1: a.x - item.x,
                        y1: a.y - item.y,
                        x2: b.x - item.x,
                        y2: b.y - item.y,
                    };
                }
                dispatch({ type: 'UPDATE_LINE', id: e.id, patch: linePatch });
            } else {
                const nextPoints = e.points.map(p => {
                    const np = rotPt(p.x, p.y);
                    return { ...p, x: np.x, y: np.y };
                });
                const strokePatch: any = { points: nextPoints };
                if (e.authoredInParent) {
                    strokePatch.authoredInParent = {
                        ...e.authoredInParent,
                        points: nextPoints.map(p => ({ ...p, x: p.x - item.x, y: p.y - item.y })),
                    };
                }
                dispatch({ type: 'UPDATE_STROKE', id: e.id, patch: strokePatch });
            }
        }

        // Container's own rotation. Bundle into the same bulk dispatch
        // as the descendants for one reducer pass.
        itemPatches.push({
            id: item.id,
            patch: { rotation: (dragRef.current?.startContainerRotation ?? 0) + totalDelta },
        });

        if (itemPatches.length === 1) {
            const u = itemPatches[0];
            dispatch({ type: 'UPDATE_ITEM', id: u.id, patch: u.patch });
        } else if (itemPatches.length > 1) {
            dispatch({ type: 'UPDATE_ITEMS_BULK', updates: itemPatches });
        }
    }

    function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
        e.stopPropagation();
        e.preventDefault();
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
        pushSnapshot();
        const cursorWorldX = (e.clientX - state.view.panX) / surfaceZoom;
        const cursorWorldY = (e.clientY - state.view.panY) / surfaceZoom;
        const startCursorAngle = (Math.atan2(cursorWorldY - cy, cursorWorldX - cx) * 180) / Math.PI;
        dragRef.current = {
            pivotX: cx,
            pivotY: cy,
            startCursorAngle,
            startContainerRotation: rotation,
            descendants: gatherDescendants(),
        };
    }

    function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
        const d = dragRef.current;
        if (!d) return;
        e.stopPropagation();
        const cursorWorldX = (e.clientX - state.view.panX) / surfaceZoom;
        const cursorWorldY = (e.clientY - state.view.panY) / surfaceZoom;
        const currentAngle = (Math.atan2(cursorWorldY - d.pivotY, cursorWorldX - d.pivotX) * 180) / Math.PI;
        let delta = currentAngle - d.startCursorAngle;
        if (e.shiftKey) {
            const SNAP = 15;
            delta = Math.round(delta / SNAP) * SNAP;
        }
        applyRotation(d.descendants, delta);
    }

    function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
        const d = dragRef.current;
        dragRef.current = null;
        if (!d) return;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
        // Same undo-anchoring trick the scale/multi-rotate paths use: live
        // drag dispatched plain UPDATE_* (no commit), so the undo stack
        // would otherwise miss the gesture. Emit one no-op commit to land
        // the whole gesture as a single step.
        commit({ type: 'UPDATE_ITEM', id: item.id, patch: { x: item.x } });
    }

    return (
        <>
            <svg
                style={{
                    position: 'absolute',
                    left: Math.min(topWorldX, handleCenterX) - 2,
                    top: Math.min(topWorldY, handleCenterY) - 2,
                    width: Math.abs(handleCenterX - topWorldX) + 4,
                    height: Math.abs(handleCenterY - topWorldY) + 4,
                    pointerEvents: 'none',
                    overflow: 'visible',
                }}
            >
                <line
                    x1={topWorldX - (Math.min(topWorldX, handleCenterX) - 2)}
                    y1={topWorldY - (Math.min(topWorldY, handleCenterY) - 2)}
                    x2={handleCenterX - (Math.min(topWorldX, handleCenterX) - 2)}
                    y2={handleCenterY - (Math.min(topWorldY, handleCenterY) - 2)}
                    stroke="rgba(16,185,129,0.6)"
                    strokeWidth={borderWidthWorld}
                    strokeDasharray={`${2 / surfaceZoom} ${2 / surfaceZoom}`}
                />
            </svg>
            <div
                data-canvas-ui="1"
                className="no-drag"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title="Drag to rotate group · Shift snaps to 15°"
                style={{
                    position: 'absolute',
                    left: handleCenterX - handleDiameter / 2,
                    top: handleCenterY - handleDiameter / 2,
                    width: handleDiameter,
                    height: handleDiameter,
                    borderRadius: handleDiameter / 2,
                    background: '#10b981',
                    border: `${borderWidthWorld}px solid rgba(10,10,15,0.85)`,
                    boxShadow: `0 0 0 ${shadowWorld}px rgba(16,185,129,0.22)`,
                    cursor: 'grab',
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    zIndex: 13,
                }}
            >
                {/* Lucide RotateCw — same icon the per-item RotateHandle uses.
                    Reads unambiguously as "rotate" at any size, where the
                    previous hand-coded arc-arrow path collapsed to a
                    download-arrow silhouette when the stroke width drowned
                    out the arc at small zooms. */}
                <RotateCw size={9 / surfaceZoom} />
            </div>
        </>
    );
}
