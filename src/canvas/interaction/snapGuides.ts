import type { CanvasItem } from '../items/types';

// Figma-style alignment / snap guides. During a move drag we compare the
// dragged bounding rect's six key lines (left, right, h-center, top, bottom,
// v-center) against the same lines on every non-dragged item. If any pair is
// within `thresholdWorld`, we snap to that line and surface a guide line the
// UI can draw.

export interface SnapGuide {
    // World-space line. Either vertical (xs match) or horizontal (ys match).
    orientation: 'vertical' | 'horizontal';
    // Constant axis coord (x for vertical, y for horizontal).
    coord: number;
    // Extent so the guide line visually spans both items.
    min: number;
    max: number;
}

export interface SnapResult {
    dx: number;                 // adjusted drag delta
    dy: number;
    guides: SnapGuide[];        // lines the UI should paint
}

interface Rect { x: number; y: number; w: number; h: number }

function itemEdges(r: Rect) {
    return {
        left:   r.x,
        right:  r.x + r.w,
        hCenter: r.x + r.w / 2,
        top:    r.y,
        bottom: r.y + r.h,
        vCenter: r.y + r.h / 2,
    };
}

/**
 * Compute a snapped delta plus any guide lines to draw.
 *
 * @param draggedBounds union rect of all items being dragged, AFTER applying
 *   the raw (unsnapped) dx/dy.
 * @param rawDx raw candidate delta (world units)
 * @param rawDy raw candidate delta
 * @param otherItems items NOT being dragged — candidates for snap targets.
 * @param thresholdWorld max world-space distance to still snap (6 is a good
 *   default at 1x zoom; scale the threshold by `1/zoom` in the caller to keep
 *   a constant feel at any zoom).
 */
export function computeSnap(
    draggedBounds: Rect,
    rawDx: number,
    rawDy: number,
    otherItems: CanvasItem[],
    thresholdWorld: number,
): SnapResult {
    if (otherItems.length === 0) {
        return { dx: rawDx, dy: rawDy, guides: [] };
    }
    const de = itemEdges(draggedBounds);
    // For each axis, find the smallest-distance snap candidate.
    let bestX: { adjust: number; coord: number; otherRect: Rect; draggedCoord: number } | null = null;
    let bestY: { adjust: number; coord: number; otherRect: Rect; draggedCoord: number } | null = null;

    for (const it of otherItems) {
        const o = itemEdges(it);
        // Vertical alignments (x-axis snap).
        const xCandidates: Array<{ drag: number; other: number }> = [
            { drag: de.left,    other: o.left },
            { drag: de.left,    other: o.right },
            { drag: de.right,   other: o.left },
            { drag: de.right,   other: o.right },
            { drag: de.hCenter, other: o.hCenter },
        ];
        for (const cand of xCandidates) {
            const diff = cand.other - cand.drag;
            if (Math.abs(diff) <= thresholdWorld) {
                if (!bestX || Math.abs(diff) < Math.abs(bestX.adjust)) {
                    bestX = {
                        adjust: diff,
                        coord: cand.other,
                        otherRect: { x: it.x, y: it.y, w: it.w, h: it.h },
                        draggedCoord: cand.drag,
                    };
                }
            }
        }
        // Horizontal alignments (y-axis snap).
        const yCandidates: Array<{ drag: number; other: number }> = [
            { drag: de.top,     other: o.top },
            { drag: de.top,     other: o.bottom },
            { drag: de.bottom,  other: o.top },
            { drag: de.bottom,  other: o.bottom },
            { drag: de.vCenter, other: o.vCenter },
        ];
        for (const cand of yCandidates) {
            const diff = cand.other - cand.drag;
            if (Math.abs(diff) <= thresholdWorld) {
                if (!bestY || Math.abs(diff) < Math.abs(bestY.adjust)) {
                    bestY = {
                        adjust: diff,
                        coord: cand.other,
                        otherRect: { x: it.x, y: it.y, w: it.w, h: it.h },
                        draggedCoord: cand.drag,
                    };
                }
            }
        }
    }

    const dx = rawDx + (bestX?.adjust ?? 0);
    const dy = rawDy + (bestY?.adjust ?? 0);
    const guides: SnapGuide[] = [];
    if (bestX) {
        // Vertical guide at x = bestX.coord. Span y-extent of both rects.
        const yMin = Math.min(draggedBounds.y, bestX.otherRect.y);
        const yMax = Math.max(draggedBounds.y + draggedBounds.h, bestX.otherRect.y + bestX.otherRect.h);
        guides.push({ orientation: 'vertical', coord: bestX.coord, min: yMin, max: yMax });
    }
    if (bestY) {
        const xMin = Math.min(draggedBounds.x, bestY.otherRect.x);
        const xMax = Math.max(draggedBounds.x + draggedBounds.w, bestY.otherRect.x + bestY.otherRect.w);
        guides.push({ orientation: 'horizontal', coord: bestY.coord, min: xMin, max: xMax });
    }
    return { dx, dy, guides };
}

/**
 * Union bounding rect of a set of items. Returns null for an empty array.
 */
export function unionBounds(items: CanvasItem[]): Rect | null {
    if (items.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        if (it.x < minX) minX = it.x;
        if (it.y < minY) minY = it.y;
        if (it.x + it.w > maxX) maxX = it.x + it.w;
        if (it.y + it.h > maxY) maxY = it.y + it.h;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
