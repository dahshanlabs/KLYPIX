import type { CanvasItem, ViewState } from './items/types';

// Pure coordinate / hit-test helpers. No React, no DOM. Keep side-effect-free
// so they can be unit tested and used from event handlers without subscribing
// to state.

export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Convert a screen-space point (relative to the canvas viewport) to world space. */
export function screenToWorld(p: Point, view: ViewState): Point {
    return {
        x: (p.x - view.panX) / view.zoom,
        y: (p.y - view.panY) / view.zoom,
    };
}

/** Convert a world-space point to screen space (inverse of screenToWorld). */
export function worldToScreen(p: Point, view: ViewState): Point {
    return {
        x: p.x * view.zoom + view.panX,
        y: p.y * view.zoom + view.panY,
    };
}

/** Item bounding box in world coords. */
export function itemRect(item: CanvasItem): Rect {
    return { x: item.x, y: item.y, w: item.w, h: item.h };
}

export function pointInRect(p: Point, r: Rect): boolean {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/** Normalize a rect so w/h are positive (for drag-to-create boxes). */
export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
    };
}

/** Top-most item (respecting render order) whose bounds contain the point. */
export function hitTest(items: CanvasItem[], order: string[], p: Point): CanvasItem | null {
    // Iterate top-to-bottom (reverse order).
    const itemMap = new Map(items.map(i => [i.id, i]));
    for (let i = order.length - 1; i >= 0; i--) {
        const item = itemMap.get(order[i]);
        if (item && pointInRect(p, itemRect(item))) return item;
    }
    return null;
}

/** Read pointer coords relative to a target element. */
export function relativePoint(e: React.PointerEvent | PointerEvent, el: HTMLElement): Point {
    const rect = el.getBoundingClientRect();
    return { x: (e as PointerEvent).clientX - rect.left, y: (e as PointerEvent).clientY - rect.top };
}

/** Compute the bounding rect of all items (in world coords). Returns null if empty. */
export function itemsBounds(items: { x: number; y: number; w: number; h: number }[]): Rect | null {
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

/**
 * Compute the pan/zoom that fits `bounds` inside a viewport of the given size,
 * with padding. Returns a ViewState.
 */
export function fitToViewport(bounds: Rect, viewport: { w: number; h: number }, padding = 80): import('./items/types').ViewState {
    const zoomX = (viewport.w - padding * 2) / Math.max(bounds.w, 1);
    const zoomY = (viewport.h - padding * 2) / Math.max(bounds.h, 1);
    const zoom = Math.min(zoomX, zoomY, 2); // never zoom further in than 2x on fit
    // Center the bounds in the viewport.
    const centerX = bounds.x + bounds.w / 2;
    const centerY = bounds.y + bounds.h / 2;
    const panX = viewport.w / 2 - centerX * zoom;
    const panY = viewport.h / 2 - centerY * zoom;
    // Clamp matches the ZOOM reducer's range so Ctrl+0 (fit all) on a
    // very wide canvas doesn't land at a zoom below what the user can
    // then pan/zoom normally.
    return { panX, panY, zoom: Math.max(0.02, zoom) };
}
