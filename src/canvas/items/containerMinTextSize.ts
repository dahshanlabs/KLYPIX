import type { CanvasItem, TextItem, DrawnLine, FreehandStroke } from './types';

// Per-container "smallest readable unit" measurement for semantic-zoom
// thresholds. Walks the container's entire descendant tree (items only)
// and returns the smallest fontSize found among text descendants. If no
// text exists, falls back to the smallest child DIMENSION (min of w/h
// across direct/nested non-container descendants). If the group is
// empty, returns the container header's authored font baseline so the
// threshold rule still has something to compare against.
//
// Results are cached in a module-level WeakMap keyed by the items
// record reference. React re-creates `items` on every reducer dispatch
// that touches items, so the cache auto-invalidates on any relevant
// mutation (add/remove/text edit/font-size change) without manual
// tracking. The cache survives zoom-only changes — zoom doesn't
// mutate items — which is where caching pays off: a pinch-zoom gesture
// calls this function many times with the same items ref and gets
// O(1) lookups after the first call.

// World-px fallback when a container is empty. Matches the authored
// header font size used in ContainerItem's header rendering.
const HEADER_AUTHORED_FONT = 11;

interface CacheEntry {
    minTextSize: Map<string, number>;
    minDimension: Map<string, number>;
    // Dimension cache also depends on lines/strokes refs. The WeakMap
    // is keyed by the items ref, which auto-invalidates the whole
    // entry on any item mutation (reducer creates a new items object).
    // But drawings live in separate state slices — a stroke add with
    // no item touch would leave the dimension cache stale. Track the
    // lines/strokes refs we used when populating the dimension cache
    // and clear it on mismatch.
    dimLinesRef: Record<string, DrawnLine> | undefined;
    dimStrokesRef: Record<string, FreehandStroke> | undefined;
    dimScopePopulated: boolean;
}

const cache = new WeakMap<Record<string, CanvasItem>, CacheEntry>();

function getCache(items: Record<string, CanvasItem>): CacheEntry {
    let entry = cache.get(items);
    if (!entry) {
        entry = {
            minTextSize: new Map(),
            minDimension: new Map(),
            dimLinesRef: undefined,
            dimStrokesRef: undefined,
            dimScopePopulated: false,
        };
        cache.set(items, entry);
    }
    return entry;
}

// Collect every descendant id (items only — lines/strokes aren't text-
// bearing at the container-threshold level). Includes nested-container
// descendants' descendants (i.e., full subtree).
function collectDescendants(containerId: string, items: Record<string, CanvasItem>): CanvasItem[] {
    const out: CanvasItem[] = [];
    const queue: string[] = [containerId];
    const seen = new Set<string>();
    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (seen.has(currentId)) continue;
        seen.add(currentId);
        for (const it of Object.values(items)) {
            if (it.parentId === currentId) {
                out.push(it);
                if (it.type === 'container') queue.push(it.id);
            }
        }
    }
    return out;
}

/**
 * Smallest text fontSize (world-px) among direct and nested descendants.
 * Returns `null` when the container has no text descendants — callers
 * should then use `getMinChildDimension` as the fallback.
 */
export function getMinTextSize(containerId: string, items: Record<string, CanvasItem>): number | null {
    const cached = getCache(items).minTextSize.get(containerId);
    if (cached !== undefined) return cached === Infinity ? null : cached;

    const descendants = collectDescendants(containerId, items);
    let min = Infinity;
    for (const it of descendants) {
        if (it.type !== 'text') continue;
        const fs = (it as TextItem).fontSize;
        if (typeof fs === 'number' && fs > 0 && fs < min) min = fs;
    }
    getCache(items).minTextSize.set(containerId, min);
    return min === Infinity ? null : min;
}

/**
 * Fallback for non-text content: smallest dimension (min of w/h) across
 * direct and nested non-container descendants, including drawn lines
 * and pen strokes when provided. Container descendants are skipped —
 * a nested group's own width isn't the readability measure; its
 * contents are. Lines/strokes contribute their bbox's min dimension.
 */
export function getMinChildDimension(
    containerId: string,
    items: Record<string, CanvasItem>,
    lines?: Record<string, DrawnLine>,
    strokes?: Record<string, FreehandStroke>,
): number | null {
    const entry = getCache(items);
    // Scope-check: if the caller's (lines, strokes) pair differs from
    // what this cache entry was populated with, throw out the dimension
    // map. Handles: (a) a stroke/line was added or removed (new slice
    // ref), (b) a previously-drawing-aware caller switches to a
    // drawing-unaware one. Text cache is unaffected — text doesn't
    // depend on drawings.
    if (
        entry.dimScopePopulated
        && (entry.dimLinesRef !== lines || entry.dimStrokesRef !== strokes)
    ) {
        entry.minDimension.clear();
        entry.dimScopePopulated = false;
    }
    const cached = entry.minDimension.get(containerId);
    if (cached !== undefined) return cached === Infinity ? null : cached;

    const descendants = collectDescendants(containerId, items);
    const descendantIds = new Set(descendants.map(d => d.id));
    descendantIds.add(containerId);
    let min = Infinity;
    for (const it of descendants) {
        if (it.type === 'container') continue;
        const d = Math.min(it.w || 0, it.h || 0);
        if (d > 0 && d < min) min = d;
    }
    // Drawings: walk lines/strokes whose parentId points anywhere in the
    // container's subtree. Their bbox min-dim contributes to readability.
    if (lines) {
        for (const ln of Object.values(lines)) {
            if (!ln.parentId || !descendantIds.has(ln.parentId)) continue;
            const bw = Math.abs(ln.x2 - ln.x1);
            const bh = Math.abs(ln.y2 - ln.y1);
            const d = Math.min(bw, bh);
            if (d > 0 && d < min) min = d;
        }
    }
    if (strokes) {
        for (const st of Object.values(strokes)) {
            if (!st.parentId || !descendantIds.has(st.parentId)) continue;
            if (st.points.length === 0) continue;
            let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
            for (const p of st.points) {
                if (p.x < mnx) mnx = p.x;
                if (p.y < mny) mny = p.y;
                if (p.x > mxx) mxx = p.x;
                if (p.y > mxy) mxy = p.y;
            }
            const d = Math.min(mxx - mnx, mxy - mny);
            if (d > 0 && d < min) min = d;
        }
    }
    entry.minDimension.set(containerId, min);
    entry.dimLinesRef = lines;
    entry.dimStrokesRef = strokes;
    entry.dimScopePopulated = true;
    return min === Infinity ? null : min;
}

/**
 * Readability-threshold reference: smallest text fontSize, falling back
 * to smallest child dimension (items + drawings), falling back to the
 * header font baseline for empty containers. Always returns a positive
 * number. Callers that want drawings considered in the fallback must
 * pass `lines` and `strokes`; omitting them yields an items-only
 * dimension fallback.
 */
export function getReadabilityReference(
    containerId: string,
    items: Record<string, CanvasItem>,
    lines?: Record<string, DrawnLine>,
    strokes?: Record<string, FreehandStroke>,
): number {
    const text = getMinTextSize(containerId, items);
    if (text != null) return text;
    const dim = getMinChildDimension(containerId, items, lines, strokes);
    if (dim != null) return dim;
    return HEADER_AUTHORED_FONT;
}

/**
 * Whether this container's reference came from the text path (vs
 * dimension fallback). Used to pick the correct threshold constants —
 * text uses 6/9 screen-px; dimension uses 20/30 screen-px per spec.
 */
export function hasTextDescendant(containerId: string, items: Record<string, CanvasItem>): boolean {
    return getMinTextSize(containerId, items) != null;
}
