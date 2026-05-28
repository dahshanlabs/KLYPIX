// Shared "refit a container to its children" plumbing. Two callers today:
//
//   1. Gesture commits (move/resize/rotate, single + multi-select) — grow-only
//      auto-fit so a child poking out of the parent's frame after a gesture
//      pulls the frame outward to keep wrapping it. Skipped when the user has
//      explicitly resized the container itself (`autoSized === false`).
//
//   2. Right-click "Fit to contents" menu action — full refit (both grow and
//      shrink) regardless of the autoSized flag, and re-enables autoSized
//      afterward so subsequent child gestures continue to track.
//
// Rotation-aware AABB: a TextItem rotated 30° has a visual extent larger than
// its stored x..x+w / y..y+h rect. Both callers must wrap that visible
// envelope, not the stored unrotated frame. Mirrors getSelectionBBox in
// interaction/scaleSelection.ts.

import type { CanvasItem, ContainerItem, DrawnLine, FreehandStroke } from './types';
import { suppressContainerResizeScaling } from './ContainerItem';

// Frame chrome — matches groupSelection() in KlypixCanvas.tsx and the existing
// move-end logic in useCanvasInteraction.ts so refit math stays consistent
// across creation, gesture-grow, and Fit to contents.
const PAD = 16;
const TITLE = 28;

interface ChildBBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    empty: boolean;
}

// World-space envelope of one item, accounting for its rotation (degrees,
// clockwise around the center). Containers in v1 ignore the rotation field
// per types.ts, so they hit the cheap branch.
function itemAABB(it: CanvasItem): { x0: number; y0: number; x1: number; y1: number } {
    const rot = (it as any).rotation;
    if (typeof rot === 'number' && rot !== 0 && it.type !== 'container') {
        const cx = it.x + it.w / 2;
        const cy = it.y + it.h / 2;
        const rad = (rot * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const hw = it.w / 2;
        const hh = it.h / 2;
        const rotW = hw * cos + hh * sin;
        const rotH = hw * sin + hh * cos;
        return { x0: cx - rotW, y0: cy - rotH, x1: cx + rotW, y1: cy + rotH };
    }
    return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
}

// Tight bbox across every direct child (item / line / stroke) of `parentId`.
// Returns empty=true when the container has no children — caller must skip
// resizing in that case (an empty container has no useful "tight" frame).
export function computeChildrenBBox(
    parentId: string,
    items: Record<string, CanvasItem>,
    lines: Record<string, DrawnLine>,
    strokes: Record<string, FreehandStroke>,
): ChildBBox {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let touched = false;
    for (const child of Object.values(items)) {
        if (child.parentId !== parentId) continue;
        const { x0, y0, x1, y1 } = itemAABB(child);
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
        touched = true;
    }
    for (const ln of Object.values(lines)) {
        if (ln.parentId !== parentId) continue;
        const lx0 = Math.min(ln.x1, ln.x2);
        const ly0 = Math.min(ln.y1, ln.y2);
        const lx1 = Math.max(ln.x1, ln.x2);
        const ly1 = Math.max(ln.y1, ln.y2);
        if (lx0 < minX) minX = lx0;
        if (ly0 < minY) minY = ly0;
        if (lx1 > maxX) maxX = lx1;
        if (ly1 > maxY) maxY = ly1;
        touched = true;
    }
    for (const st of Object.values(strokes)) {
        if (st.parentId !== parentId) continue;
        if (st.points.length === 0) continue;
        for (const p of st.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        touched = true;
    }
    return { minX, minY, maxX, maxY, empty: !touched };
}

interface RefitOpts {
    items: Record<string, CanvasItem>;
    lines: Record<string, DrawnLine>;
    strokes: Record<string, FreehandStroke>;
    dispatch: (action: any) => void;
    // 'grow-only' — gesture commits. Skip containers with autoSized===false.
    //                Skip per-axis when bbox doesn't exceed current frame.
    // 'fit-exact'  — explicit user action. Always compute the new frame
    //                from the bbox + PAD/TITLE, regardless of autoSized.
    //                Reasserts autoSized=true so subsequent gestures track.
    mode: 'grow-only' | 'fit-exact';
}

// Re-fit one or more containers around their children. Caller passes the set
// of parent ids whose frames need re-evaluation (in 'grow-only' mode, this is
// typically the parent of every item touched by a gesture).
//
// Walks up the parent chain — a refit at depth N may push the parent past
// grandparent's bounds, which must then also grow. We deduplicate via a
// visited set and an explicit queue so cyclic parentId chains (shouldn't
// happen, but defense) terminate.
//
// Skips refit for a container when EITHER:
//   - mode==='grow-only' AND container.autoSized === false (user-shaped)
//   - container has no direct children (empty group — frame is whatever the
//     user dragged it to, no children to fit around)
//   - mode==='grow-only' AND the new bbox is already inside the current
//     frame on every axis (nothing to grow)
//
// On commit, re-seeds authoredInParent for every child / line / stroke so
// the vector-scale system in ContainerItem's effect derives positions from
// the new baseline on its next pass. Suppresses one scale pass first so the
// effect doesn't snap children off-position using stale anchors.
export function refitContainers(parentIds: Iterable<string>, opts: RefitOpts): void {
    const { items, lines, strokes, dispatch, mode } = opts;
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const id of parentIds) if (id && !visited.has(id)) { visited.add(id); queue.push(id); }

    while (queue.length > 0) {
        const id = queue.shift()!;
        const container = items[id];
        if (!container || container.type !== 'container') continue;
        const c = container as ContainerItem;
        // Grow-only path respects the user's explicit sizing. Fit-exact
        // overrides it (and re-enables autoSized below).
        if (mode === 'grow-only' && c.autoSized === false) continue;
        const bbox = computeChildrenBBox(id, items, lines, strokes);
        if (bbox.empty) continue;

        // Desired frame from bbox + chrome. y subtracts TITLE so the title
        // bar sits ABOVE the content area (matches groupSelection).
        const desiredX = bbox.minX - PAD;
        const desiredY = bbox.minY - PAD - TITLE;
        const desiredW = (bbox.maxX - bbox.minX) + PAD * 2;
        const desiredH = (bbox.maxY - bbox.minY) + PAD * 2 + TITLE;

        let nx = c.x, ny = c.y, nw = c.w, nh = c.h;
        let changed = false;
        if (mode === 'fit-exact') {
            nx = desiredX; ny = desiredY; nw = desiredW; nh = desiredH;
            changed = nx !== c.x || ny !== c.y || nw !== c.w || nh !== c.h;
        } else {
            // Grow-only: expand the frame outward on whichever sides the
            // bbox pushes past. Never pull a side inward — that would
            // surprise the user during a tweak gesture.
            const curRight = c.x + c.w;
            const curBottom = c.y + c.h;
            const newLeft = Math.min(c.x, desiredX);
            const newTop = Math.min(c.y, desiredY);
            const newRight = Math.max(curRight, bbox.maxX + PAD);
            const newBottom = Math.max(curBottom, bbox.maxY + PAD);
            nx = newLeft;
            ny = newTop;
            nw = newRight - newLeft;
            nh = newBottom - newTop;
            changed = nx !== c.x || ny !== c.y || nw !== c.w || nh !== c.h;
        }
        if (!changed) continue;

        // Vector-scale effect would otherwise read every child's frozen
        // authoredInParent × the (now-changed) parent scale and snap
        // children off-position. Suppress one pass; we'll rebase the
        // anchors right after.
        suppressContainerResizeScaling(id);

        const patch: any = { x: nx, y: ny, w: nw, h: nh, authoredW: nw, authoredH: nh };
        // fit-exact re-enables autoSized — the user explicitly asked for
        // the frame to track children, so any prior manual sizing intent
        // is overridden until they resize the container again.
        if (mode === 'fit-exact') patch.autoSized = true;
        dispatch({ type: 'UPDATE_ITEM', id, patch });

        // Re-seed authoredInParent for every child of the refitted
        // container — their world positions haven't changed, but the
        // parent origin has, so the (x - parent.x) baseline needs to be
        // rebased at scale=1.
        for (const child of Object.values(items)) {
            if (child.parentId !== id) continue;
            const next: any = {
                relX: child.x - nx,
                relY: child.y - ny,
                w: child.w,
                h: child.h,
            };
            if (child.type === 'text') {
                next.fontSize = (child as any).fontSize;
                next.authoredWidth = (child as any).authoredWidth ?? child.w;
            }
            if (child.type === 'box') {
                next.borderWidth = (child as any).borderWidth;
            }
            dispatch({ type: 'UPDATE_ITEM', id: child.id, patch: { authoredInParent: next } });
        }
        for (const [lid, ln] of Object.entries(lines)) {
            if (ln.parentId !== id) continue;
            dispatch({
                type: 'UPDATE_LINE',
                id: lid,
                patch: {
                    authoredInParent: {
                        x1: ln.x1 - nx,
                        y1: ln.y1 - ny,
                        x2: ln.x2 - nx,
                        y2: ln.y2 - ny,
                        width: ln.width,
                    },
                },
            });
        }
        for (const [sid, st] of Object.entries(strokes)) {
            if (st.parentId !== id) continue;
            dispatch({
                type: 'UPDATE_STROKE',
                id: sid,
                patch: {
                    authoredInParent: {
                        points: st.points.map(p => ({ ...p, x: p.x - nx, y: p.y - ny })),
                        width: st.width,
                    },
                },
            });
        }

        // Cascade: if THIS container has a parent, its bounds may now have
        // pushed past the grandparent's frame. Enqueue.
        const grandparentId = c.parentId;
        if (grandparentId && !visited.has(grandparentId)) {
            visited.add(grandparentId);
            queue.push(grandparentId);
        }
    }
}

// Convenience: collect the set of parent ids reachable from a set of item ids
// — walks parentId once per item, no further. Callers at gesture commits
// pass the touched item ids; this helper turns that into the parent set the
// refit needs.
export function collectAffectedParents(
    itemIds: Iterable<string>,
    items: Record<string, CanvasItem>,
): Set<string> {
    const out = new Set<string>();
    for (const id of itemIds) {
        const it = items[id];
        if (it?.parentId) out.add(it.parentId);
    }
    return out;
}
