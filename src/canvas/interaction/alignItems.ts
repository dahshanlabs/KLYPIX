import type { CanvasItem } from '../items/types';

// Multi-item alignment + distribution. Reference frame is the current
// selection's bounding box (Figma default): edges of every item snap to
// the bbox's left / horizontal-center / right / top / vertical-middle /
// bottom. Distribute spreads items so the GAP between consecutive items
// (sorted by axis position) is equal — extremes stay where they are.
//
// One pushSnapshot covers the whole op so a single Ctrl+Z reverses it.
//
// Limitations matching scaleSelection.ts:
//   - Only operates on item selections; lines / strokes / connections
//     are skipped (they have no w/h to align to a reference edge).
//   - Children whose container is also selected are skipped — the
//     container's vector-scale would override their patch on the next
//     resize.
//   - Items inside an unselected container get patched directly; their
//     authoredInParent baseline is NOT updated, so a subsequent
//     container resize can revert the alignment. Matches existing
//     behavior of scaleSelection.

export type AlignOp =
    | 'align-left' | 'align-center-h' | 'align-right'
    | 'align-top' | 'align-center-v' | 'align-bottom'
    | 'distribute-h' | 'distribute-v';

interface AlignState {
    items: Record<string, CanvasItem>;
    selectedIds: string[];
}

export interface AlignCtx {
    state: AlignState;
    dispatch: (action: any) => void;
    pushSnapshot: () => void;
}

/** Items eligible for alignment: in the current selection, exists in the
 *  item map, and not a child whose parent is also selected. Returned in
 *  selection order so the caller can sort by axis as needed. */
function eligibleItems(state: AlignState): CanvasItem[] {
    const selected = new Set(state.selectedIds);
    const out: CanvasItem[] = [];
    for (const id of state.selectedIds) {
        const it = state.items[id];
        if (!it) continue;
        if (it.parentId && selected.has(it.parentId)) continue;
        out.push(it);
    }
    return out;
}

/** Axis-aligned bounding box over a list of items. Returns null when the
 *  list is empty. */
function bboxOf(items: CanvasItem[]) {
    if (items.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        if (it.x < minX) minX = it.x;
        if (it.y < minY) minY = it.y;
        if (it.x + it.w > maxX) maxX = it.x + it.w;
        if (it.y + it.h > maxY) maxY = it.y + it.h;
    }
    return { minX, minY, maxX, maxY };
}

/** True when the op is meaningful for the current selection size:
 *  align ops need ≥2 items; distribute needs ≥3. */
export function canAlign(state: AlignState, op: AlignOp): boolean {
    const items = eligibleItems(state);
    if (op === 'distribute-h' || op === 'distribute-v') return items.length >= 3;
    return items.length >= 2;
}

export function alignSelection(ctx: AlignCtx, op: AlignOp): boolean {
    const items = eligibleItems(ctx.state);
    if (!canAlign(ctx.state, op)) return false;
    const bb = bboxOf(items);
    if (!bb) return false;

    ctx.pushSnapshot();

    if (op === 'distribute-h' || op === 'distribute-v') {
        // Sort by axis edge so consecutive items in the sorted list are
        // adjacent in the layout. Distribute by EQUAL GAP between the
        // edges (Figma's default Distribute). Extremes anchor: the
        // leftmost/topmost stays put; everything else is repositioned
        // so the rightmost lands exactly on its current right/bottom
        // edge.
        const horizontal = op === 'distribute-h';
        const sorted = [...items].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
        const sumSize = sorted.reduce((acc, it) => acc + (horizontal ? it.w : it.h), 0);
        const span = horizontal
            ? (bb.maxX - bb.minX)
            : (bb.maxY - bb.minY);
        // Free pixels to spread across (n - 1) gaps. If items are
        // already overlapping enough that sumSize > span, gap goes
        // negative and items will overlap — that mirrors what Figma
        // does and matches the user's mental model ("equal gaps,
        // even if those gaps are negative").
        const gap = (span - sumSize) / (sorted.length - 1);
        let cursor = horizontal ? bb.minX : bb.minY;
        for (const it of sorted) {
            if (horizontal) {
                ctx.dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { x: cursor } });
                cursor += it.w + gap;
            } else {
                ctx.dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { y: cursor } });
                cursor += it.h + gap;
            }
        }
        return true;
    }

    // Single-axis edge / center snap. Each item's coord on the affected
    // axis is rewritten so the named edge (or center) sits on the
    // bbox's named edge (or center).
    const midX = (bb.minX + bb.maxX) / 2;
    const midY = (bb.minY + bb.maxY) / 2;
    for (const it of items) {
        let patch: { x?: number; y?: number } | null = null;
        switch (op) {
            case 'align-left':     patch = { x: bb.minX }; break;
            case 'align-center-h': patch = { x: midX - it.w / 2 }; break;
            case 'align-right':    patch = { x: bb.maxX - it.w }; break;
            case 'align-top':      patch = { y: bb.minY }; break;
            case 'align-center-v': patch = { y: midY - it.h / 2 }; break;
            case 'align-bottom':   patch = { y: bb.maxY - it.h }; break;
        }
        if (patch) ctx.dispatch({ type: 'UPDATE_ITEM', id: it.id, patch });
    }
    return true;
}
