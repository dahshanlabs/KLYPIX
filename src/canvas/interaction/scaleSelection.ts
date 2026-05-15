import type { CanvasItem, DrawnLine, FreehandStroke } from '../items/types';

// Pure scale utility for the current selection. Multiplies positions and
// dimensions by `factor` around the selection's bounding-box center, and
// proportionally scales inner properties (fontSize, borderWidth, line/
// stroke widths) so visual ratios are preserved — the same rule the
// corner-resize handle already uses.
//
// Children whose parent is also in the selection are skipped: the
// container's vector-scale effect will derive their new bounds from the
// container's new w/h, so scaling them directly would double-apply.

interface ScaleState {
    items: Record<string, CanvasItem>;
    lines: Record<string, DrawnLine>;
    strokes: Record<string, FreehandStroke>;
    selectedIds: string[];
    selectedLineIds: string[];
    selectedStrokeIds: string[];
}

export interface SelectionBBox {
    cx: number;
    cy: number;
    w: number;
    h: number;
}

export function getSelectionBBox(state: ScaleState): SelectionBBox | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let touched = false;

    for (const id of state.selectedIds) {
        const it = state.items[id];
        if (!it) continue;
        touched = true;
        if (it.x < minX) minX = it.x;
        if (it.y < minY) minY = it.y;
        if (it.x + it.w > maxX) maxX = it.x + it.w;
        if (it.y + it.h > maxY) maxY = it.y + it.h;
    }
    for (const id of state.selectedLineIds) {
        const ln = state.lines[id];
        if (!ln) continue;
        touched = true;
        const lx1 = Math.min(ln.x1, ln.x2);
        const lx2 = Math.max(ln.x1, ln.x2);
        const ly1 = Math.min(ln.y1, ln.y2);
        const ly2 = Math.max(ln.y1, ln.y2);
        if (lx1 < minX) minX = lx1;
        if (ly1 < minY) minY = ly1;
        if (lx2 > maxX) maxX = lx2;
        if (ly2 > maxY) maxY = ly2;
    }
    for (const id of state.selectedStrokeIds) {
        const st = state.strokes[id];
        if (!st) continue;
        for (const p of st.points) {
            touched = true;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (!touched || !isFinite(minX)) return null;
    return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: maxX - minX,
        h: maxY - minY,
    };
}

export interface ScaleCtx {
    state: ScaleState;
    dispatch: (action: any) => void;
    pushSnapshot: () => void;
}

export function scaleSelection(ctx: ScaleCtx, factor: number): boolean {
    if (!isFinite(factor) || factor <= 0 || factor === 1) return false;
    const bbox = getSelectionBBox(ctx.state);
    if (!bbox) return false;

    const itemSelected = new Set(ctx.state.selectedIds);
    const { cx, cy } = bbox;

    ctx.pushSnapshot();

    for (const id of ctx.state.selectedIds) {
        const it = ctx.state.items[id] as any;
        if (!it) continue;
        // Skip children whose parent is also in the selection — the
        // container's vector-scale system derives their bounds from the
        // container's new w/h.
        if (it.parentId && itemSelected.has(it.parentId)) continue;

        const newW = Math.max(1, it.w * factor);
        const newH = Math.max(1, it.h * factor);
        const newX = cx + (it.x - cx) * factor;
        const newY = cy + (it.y - cy) * factor;
        const patch: any = { x: newX, y: newY, w: newW, h: newH };
        // Containers derive children fontSize/borderWidth via vector
        // scale — don't multiply them at the item level too.
        if (it.type !== 'container') {
            if (typeof it.fontSize === 'number') patch.fontSize = Math.max(1, it.fontSize * factor);
            if (typeof it.borderWidth === 'number') patch.borderWidth = Math.max(0.5, it.borderWidth * factor);
        }
        ctx.dispatch({ type: 'UPDATE_ITEM', id, patch });
    }

    for (const id of ctx.state.selectedLineIds) {
        const ln = ctx.state.lines[id];
        if (!ln) continue;
        if (ln.parentId && itemSelected.has(ln.parentId)) continue;
        const x1 = cx + (ln.x1 - cx) * factor;
        const y1 = cy + (ln.y1 - cy) * factor;
        const x2 = cx + (ln.x2 - cx) * factor;
        const y2 = cy + (ln.y2 - cy) * factor;
        const patch: any = { x1, y1, x2, y2 };
        if (typeof ln.width === 'number') patch.width = Math.max(0.5, ln.width * factor);
        ctx.dispatch({ type: 'UPDATE_LINE', id, patch });
    }

    for (const id of ctx.state.selectedStrokeIds) {
        const st = ctx.state.strokes[id];
        if (!st) continue;
        if (st.parentId && itemSelected.has(st.parentId)) continue;
        const newPoints = st.points.map(p => ({
            ...p,
            x: cx + (p.x - cx) * factor,
            y: cy + (p.y - cy) * factor,
        }));
        const patch: any = { points: newPoints };
        if (typeof st.width === 'number') patch.width = Math.max(0.5, st.width * factor);
        ctx.dispatch({ type: 'UPDATE_STROKE', id, patch });
    }

    return true;
}
