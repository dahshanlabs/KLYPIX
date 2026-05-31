import React from 'react';
import type { CanvasItem, Connection, RelationshipType } from '../items/types';
import { resolveContainerRenderRect } from '../items/ContainerItem';

interface Rect { x: number; y: number; w: number; h: number; }

// Per-relationship visual treatment. Drives stroke color, dash pattern, width
// bump, and midpoint icon glyph. "default" covers connections that have no
// typed relationship set — keeps the pre-relationship behavior intact.
interface RelStyle {
    color: string;
    dashed: boolean;
    widthBoost: number;     // added to the connection's own width
    midpointIcon?: string;  // single glyph; rendered at the midpoint for type-at-a-glance
    arrowMarker: string;    // marker id referenced below in <defs>
    label: string;          // accessible / tooltip label
}

const REL_STYLES: Record<RelationshipType | 'default', RelStyle> = {
    default:        { color: '#10b981', dashed: false, widthBoost: 0, arrowMarker: 'klpx-arrow-emerald', label: '' },
    leads_to:       { color: '#3b82f6', dashed: false, widthBoost: 0, midpointIcon: '→', arrowMarker: 'klpx-arrow-blue', label: 'leads to' },
    depends_on:     { color: '#a855f7', dashed: false, widthBoost: 0, midpointIcon: '⇠', arrowMarker: 'klpx-arrow-purple', label: 'depends on' },
    relates_to:     { color: '#9ca3af', dashed: false, widthBoost: 0, midpointIcon: '∼', arrowMarker: 'klpx-arrow-gray', label: 'relates to' },
    conflicts_with: { color: '#ef4444', dashed: true,  widthBoost: 0, midpointIcon: '⚡', arrowMarker: 'klpx-arrow-red', label: 'conflicts with' },
    supports:       { color: '#10b981', dashed: false, widthBoost: 0, midpointIcon: '✓', arrowMarker: 'klpx-arrow-emerald', label: 'supports' },
    questions:      { color: '#f59e0b', dashed: true,  widthBoost: 0, midpointIcon: '?', arrowMarker: 'klpx-arrow-amber', label: 'questions' },
    costs:          { color: '#f97316', dashed: false, widthBoost: 0, midpointIcon: '$', arrowMarker: 'klpx-arrow-orange', label: 'costs' },
    blocks:         { color: '#ef4444', dashed: false, widthBoost: 1, midpointIcon: '✕', arrowMarker: 'klpx-arrow-red', label: 'blocks' },
};

function styleForConnection(c: Connection): RelStyle {
    if (c.relationship && REL_STYLES[c.relationship]) return REL_STYLES[c.relationship];
    return REL_STYLES.default;
}

// Effective vector-scale for a connection whose endpoints share a
// container. Connections aren't parented the way items/drawings are,
// so they normally ignore container resizes — which left arrows at
// full authored stroke thickness even when their group shrank 90%.
// When both endpoints have the same parentId AND that container has
// authoredW/H, derive scale the same way ContainerItem does for
// children (uniform via min of axis scales) and multiply the rendered
// stroke width by it. Arrow heads use markerUnits="strokeWidth" (the
// SVG default) so they scale along with the stroke automatically.
// Connections that span containers or don't share a parent return 1
// so they stay visible at their authored width.
function sharedContainerScale(a: CanvasItem, b: CanvasItem, items: Record<string, CanvasItem>): number {
    const pa = a.parentId;
    const pb = b.parentId;
    if (!pa || pa !== pb) return 1;
    const container = items[pa] as any;
    if (!container || container.type !== 'container') return 1;
    if (!container.authoredW || !container.authoredH) return 1;
    const scaleW = container.w / container.authoredW;
    const scaleH = container.h / container.authoredH;
    return Math.min(scaleW, scaleH);
}

interface Props {
    connections: Record<string, Connection>;
    items: Record<string, CanvasItem>;
    // Ids of items currently hidden (e.g. children of a collapsed container).
    // Connections touching a hidden item are skipped so arrows don't dangle
    // across empty canvas.
    hiddenIds?: Set<string>;
    // Connections currently selected — highlighted and targeted by Delete.
    selectedIds?: Set<string>;
    // Click on a connection. Stops bubbling so the canvas surface doesn't
    // also start a drag / clear selection in the same frame.
    onPickConnection?: (id: string, additive: boolean) => void;
    // While the user is in connect mode and has clicked the first item,
    // preview a rubber-band line from that item to their cursor.
    previewFromId?: string | null;
    previewToWorld?: { x: number; y: number } | null;
    // Stroke width to use for the rubber-band preview — so the preview
    // matches what the committed arrow will look like (same as what's
    // selected in the toolbar). Defaults to 2 if not provided.
    previewWidth?: number;
    // Stroke color for the rubber-band preview. Should mirror the user's
    // current toolbar color so the preview shows what the committed
    // connection will look like. Defaults to brand emerald.
    previewColor?: string;
    // Current view zoom + semantic-zoom maps. Needed so connection
    // endpoints anchor to a container's RENDERED bounds (capsule
    // rectangle in tab mode, dot square in dot mode) rather than the
    // invisible expanded frame that item.x/y/w/h describe.
    viewZoom?: number;
    zoomCollapsedIds?: Record<string, boolean>;
    userOverrideExpandedIds?: Record<string, boolean>;
}

// SVG layer for connection arrows. Lives inside the transform layer so arrows
// pan/zoom with items. Keeping all paths in ONE <svg> is cheaper than per-
// connection <svg> wrappers and sets us up for the batched path optimization
// in spec §23 Layer 8.

export const ConnectionsLayer = React.memo(ConnectionsLayerImpl);

// Per-connection memoized renderer. Splits the per-connection geometry +
// SVG work out of the inner `.map(...)` so a typing or dragging burst
// that only changes ONE item's geometry doesn't recompute paths for the
// OTHER connections in the canvas. Custom comparator does shallow rect
// equality (rect.x/y/w/h primitives) so per-render rect-object
// allocations in the parent don't break the bailout.
interface ConnectionPathProps {
    c: Connection;
    aRect: Rect;
    bRect: Rect;
    connScale: number;
    isSelected: boolean;
    onPickConnection?: (id: string, additive: boolean) => void;
}

function rectEq(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

const ConnectionPath = React.memo(function ConnectionPath({
    c, aRect, bRect, connScale, isSelected, onPickConnection,
}: ConnectionPathProps) {
    const rel = styleForConnection(c);
    const hasExplicitColor = !!c.color && c.color !== '#10b981';
    const stroke = hasExplicitColor ? c.color : rel.color;
    const dashed = c.style === 'dashed' || rel.dashed;
    const dashPattern = dashed ? '8 4' : undefined;
    const baseWidth = (c.width || 2) + rel.widthBoost;
    const width = baseWidth * connScale + (isSelected ? 1.5 : 0);
    const hasArrowEnd = !!c.arrowHead;
    const path = bezierBetween(aRect, bRect, hasArrowEnd, width);
    const mid = midpoint(aRect, bRect, hasArrowEnd, width);
    const arrowMarker = !hasArrowEnd ? undefined : 'klpx-arrow';
    return (
        <g>
            <path
                d={path}
                data-canvas-connection={c.id}
                stroke="transparent"
                strokeWidth={Math.max(12, (c.width || 2) + 10)}
                fill="none"
                pointerEvents={onPickConnection ? 'stroke' : 'none'}
                onPointerDown={(e) => {
                    if (!onPickConnection) return;
                    if (e.button === 2) {
                        onPickConnection(c.id, false);
                        return;
                    }
                    e.stopPropagation();
                    onPickConnection(c.id, e.shiftKey);
                }}
                style={{ cursor: onPickConnection ? 'pointer' : 'default' }}
            >
                {rel.label ? <title>{rel.label}{c.label ? ` — ${c.label}` : ''}</title> : null}
            </path>
            <path
                d={path}
                stroke={stroke}
                strokeWidth={width}
                strokeDasharray={dashPattern}
                fill="none"
                opacity={isSelected ? 1 : 0.8}
                markerEnd={arrowMarker ? `url(#${arrowMarker})` : undefined}
                pointerEvents="none"
            />
            {rel.midpointIcon && (
                <g pointerEvents="none" transform={`translate(${mid.x}, ${mid.y})`}>
                    <circle
                        r={Math.max(3, 9 * connScale)}
                        fill="#0a0a0f"
                        stroke={stroke}
                        strokeWidth={1.5}
                        opacity={isSelected ? 1 : 0.88}
                    />
                    <text
                        y={Math.max(1.5, 3.5 * connScale)}
                        textAnchor="middle"
                        fontSize={Math.max(5, 10 * connScale)}
                        fill={stroke}
                        fontWeight={600}
                        fontFamily="system-ui, sans-serif"
                    >{rel.midpointIcon}</text>
                </g>
            )}
        </g>
    );
}, (prev, next) => {
    // Bail out re-render when nothing actually changed for THIS connection.
    // The connection object reference changes on any UPDATE_CONNECTION; the
    // rects change only when the endpoint items change. So a drag on an
    // unrelated item leaves both prev and next rects intact → memo bails.
    return (
        prev.c === next.c &&
        prev.connScale === next.connScale &&
        prev.isSelected === next.isSelected &&
        prev.onPickConnection === next.onPickConnection &&
        rectEq(prev.aRect, next.aRect) &&
        rectEq(prev.bRect, next.bRect)
    );
});

function ConnectionsLayerImpl({ connections, items, hiddenIds, selectedIds, onPickConnection, previewFromId, previewToWorld, previewWidth, previewColor, viewZoom, zoomCollapsedIds, userOverrideExpandedIds }: Props) {
    // Rect resolver: for containers, ask resolveContainerRenderRect
    // (so the arrow anchors to the capsule / dot / frame the user
    // actually sees). For other items, raw item bounds are the rect.
    const rectOf = (it: CanvasItem): Rect => {
        if (it.type === 'container' && viewZoom != null) {
            return resolveContainerRenderRect(it, viewZoom, items, {
                zoomCollapsedIds,
                userOverrideExpandedIds,
            });
        }
        return { x: it.x, y: it.y, w: it.w, h: it.h };
    };
    const list = Object.values(connections);
    const previewFrom = previewFromId ? items[previewFromId] : null;
    const hasPreview = !!(previewFrom && previewToWorld);
    if (list.length === 0 && !hasPreview) return null;

    return (
        <svg
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                // Huge intrinsic size so items anywhere in the infinite
                // canvas project onto the SVG coordinate space. Pointer events
                // are off by default so the arrows never steal clicks from
                // items; individual path children opt in with
                // pointer-events="stroke" for selection.
                width: '100000px',
                height: '100000px',
                overflow: 'visible',
                // Parent SVG stays pointer-events:none so clicks on empty
                // areas pass through to items/surface. The invisible wide
                // click-target <path> per connection overrides with
                // pointer-events="stroke" when onPickConnection is provided.
                pointerEvents: 'none',
            }}
        >
            <defs>
                {/* Single arrowhead that inherits the path's stroke color
                    via SVG 2's context-stroke paint server. One marker
                    serves every line — fill automatically matches each
                    path's stroke, so changing a connection's color also
                    recolors its arrowhead. The old per-color markers
                    (emerald/blue/…) are kept below for backward compat
                    so existing connections that reference them still
                    render until they're re-picked by getMarkerId. */}
                <marker id="klpx-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                </marker>
                <marker id="klpx-arrow-emerald" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
                </marker>
                <marker id="klpx-arrow-blue" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6" />
                </marker>
                <marker id="klpx-arrow-purple" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#a855f7" />
                </marker>
                <marker id="klpx-arrow-gray" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
                </marker>
                <marker id="klpx-arrow-red" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#ef4444" />
                </marker>
                <marker id="klpx-arrow-amber" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
                </marker>
                <marker id="klpx-arrow-orange" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#f97316" />
                </marker>
            </defs>
            {list.map(c => {
                const a = items[c.fromId];
                const b = items[c.toId];
                if (!a || !b) return null;
                if (hiddenIds && (hiddenIds.has(c.fromId) || hiddenIds.has(c.toId))) return null;
                const aRect = rectOf(a);
                const bRect = rectOf(b);
                const isSelected = selectedIds?.has(c.id) ?? false;
                const connScale = sharedContainerScale(a, b, items);
                return (
                    <ConnectionPath
                        key={c.id}
                        c={c}
                        aRect={aRect}
                        bRect={bRect}
                        connScale={connScale}
                        isSelected={isSelected}
                        onPickConnection={onPickConnection}
                    />
                );
            })}
            {hasPreview && previewFrom && previewToWorld && (
                <path
                    d={bezierToPoint(rectOf(previewFrom), previewToWorld, previewWidth ?? 2)}
                    stroke={previewColor ?? '#10b981'}
                    strokeWidth={previewWidth ?? 2}
                    strokeDasharray="6 4"
                    fill="none"
                    opacity={0.85}
                    markerEnd="url(#klpx-arrow)"
                />
            )}
        </svg>
    );
}

function rectCenter(r: Rect) {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Snap the connection anchor to the MIDPOINT of one of the rect's
 *  four cardinal sides (top, right, bottom, left), picked by which
 *  side is "facing" (tx, ty). Replaces the previous arbitrary-edge-
 *  point math (which landed the arrow at any point along the edge
 *  the center-to-center line happened to cross — looked off-center,
 *  especially for text items where the bbox includes invisible
 *  padding). Side-midpoint snapping gives the Miro / diagramming-
 *  tool look: every arrow attaches perpendicular to one of 4 well-
 *  defined points on each shape, which reads as deliberate and tidy.
 *
 *  Side choice rule: compare the horizontal-vs-vertical "pull" of
 *  the target point against the rect's aspect ratio. Wider rects
 *  need a steeper diagonal before preferring top/bottom over
 *  left/right — without aspect-weighting, a long thin shape would
 *  flip to its short sides on tiny vertical offsets. */
function sideAnchorToward(r: Rect, tx: number, ty: number): { x: number; y: number; side: 'top' | 'right' | 'bottom' | 'left' } {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    // Default to the right side if the other point is exactly on the
    // center (degenerate; arrow has no direction). Picks a stable side
    // instead of NaN-ing.
    if (dx === 0 && dy === 0) return { x: r.x + r.w, y: cy, side: 'right' };
    // Aspect-weighted comparison: |dx|/halfW vs |dy|/halfH. Whichever
    // crosses the boundary first determines the dominant side.
    const hw = r.w / 2;
    const hh = r.h / 2;
    if (Math.abs(dx) * hh > Math.abs(dy) * hw) {
        // Horizontal dominant → left or right side midpoint.
        return dx > 0
            ? { x: r.x + r.w, y: cy, side: 'right' }
            : { x: r.x,        y: cy, side: 'left' };
    }
    // Vertical dominant → top or bottom side midpoint.
    return dy > 0
        ? { x: cx, y: r.y + r.h, side: 'bottom' }
        : { x: cx, y: r.y,        side: 'top' };
}

/** Handle magnitude along the line from p1 to p2 — used by the cubic
 *  bezier control points so the curve bows outward on its own half of
 *  the span. Floor of 40 keeps short-distance curves from flattening
 *  into a straight line. */
function handleMag(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
    const dx = p2.x - p1.x;
    return Math.max(40, Math.abs(dx) * 0.5);
}

/** Build the cubic-bezier control points for an arrow that LEAVES the
 *  source side perpendicular to the side and ARRIVES at the target side
 *  perpendicular. For 'left'/'right' sides the handle extends horizontally;
 *  for 'top'/'bottom' it extends vertically. Gives the curve a clean
 *  "out from the side, into the side" feel instead of the previous
 *  always-horizontal handles (which kinked when arrows attached to
 *  top/bottom sides). */
function handleForSide(p: { x: number; y: number }, side: 'top' | 'right' | 'bottom' | 'left', mag: number): { cx: number; cy: number } {
    switch (side) {
        case 'right':  return { cx: p.x + mag, cy: p.y };
        case 'left':   return { cx: p.x - mag, cy: p.y };
        case 'bottom': return { cx: p.x, cy: p.y + mag };
        case 'top':    return { cx: p.x, cy: p.y - mag };
    }
}

/** Push a side anchor point OUTWARD from the rect by `offset` path-units
 *  along the side's perpendicular. Used to position the path endpoint
 *  outside the rect so the arrow marker (refX=5) has room to extend its
 *  apex back to the rect edge without burying it inside. Without this
 *  offset, with refX=5 the apex would stab ~15px into the target item;
 *  with the offset, the apex sits exactly on the rect's side. */
function pushOutward(anchor: { x: number; y: number; side: 'top' | 'right' | 'bottom' | 'left' }, offset: number): { x: number; y: number; side: 'top' | 'right' | 'bottom' | 'left' } {
    switch (anchor.side) {
        case 'top':    return { x: anchor.x, y: anchor.y - offset, side: anchor.side };
        case 'bottom': return { x: anchor.x, y: anchor.y + offset, side: anchor.side };
        case 'left':   return { x: anchor.x - offset, y: anchor.y, side: anchor.side };
        case 'right':  return { x: anchor.x + offset, y: anchor.y, side: anchor.side };
    }
}

/** Path-units to push the path endpoint OUTSIDE the target rect so the
 *  arrow marker's apex lands at the rect edge. Derived from the marker
 *  geometry: refX=5 in a viewBox of 10 means the apex is 5 marker-units
 *  past the path endpoint along the tangent. Marker is scaled by
 *  markerWidth=6 stroke-units / viewBoxWidth=10 = 0.6 stroke-units per
 *  viewBox unit. So apex-past-endpoint distance = 5 × 0.6 × strokeWidth
 *  = 3 × strokeWidth path-units. */
function arrowApexOffset(strokeWidth: number): number {
    return 3 * Math.max(1, strokeWidth);
}

/** Midpoint of the cubic bezier at t=0.5 — used to anchor the
 *  relationship icon on top of the arrow. Takes RECTs (rendered
 *  bounds) so collapsed containers anchor to the capsule, not the
 *  phantom expanded frame. */
function midpoint(a: Rect, b: Rect, hasArrowEnd: boolean, strokeWidth: number): { x: number; y: number } {
    const centerA = rectCenter(a);
    const centerB = rectCenter(b);
    const p1 = sideAnchorToward(a, centerB.x, centerB.y);
    const p2Anchor = sideAnchorToward(b, centerA.x, centerA.y);
    // Match the endpoint offset bezierBetween uses so the icon stays
    // anchored to the actual rendered path midpoint.
    const p2 = hasArrowEnd ? pushOutward(p2Anchor, arrowApexOffset(strokeWidth)) : p2Anchor;
    const mag = handleMag(p1, p2);
    const h1 = handleForSide(p1, p1.side, mag);
    const h2 = handleForSide(p2, p2.side, mag);
    // Bezier midpoint at t=0.5: (p1 + 3·c1 + 3·c2 + p2) / 8
    const x = (p1.x + 3 * h1.cx + 3 * h2.cx + p2.x) / 8;
    const y = (p1.y + 3 * h1.cy + 3 * h2.cy + p2.y) / 8;
    return { x, y };
}

/** S-curve between the two rect SIDES. Arrow leaves the source side
 *  perpendicular and lands on the target side perpendicular — Miro-
 *  style edge anchoring with clean orthogonal handles.
 *
 *  When the connection has an arrow head at the end (hasArrowEnd=true),
 *  the target endpoint is pushed OUTWARD from the rect by the marker's
 *  apex offset. Combined with marker refX=5, this puts the visual
 *  arrow tip exactly at the rect edge AND ensures the marker's body
 *  (which is widest at the middle, narrowest at the apex) is wider
 *  than the path stroke at every point the stroke renders — so the
 *  line is fully swallowed by the arrow head with no edges peeking out. */
export function bezierBetween(a: Rect, b: Rect, hasArrowEnd: boolean, strokeWidth: number): string {
    const centerA = rectCenter(a);
    const centerB = rectCenter(b);
    const p1 = sideAnchorToward(a, centerB.x, centerB.y);
    const p2Anchor = sideAnchorToward(b, centerA.x, centerA.y);
    const p2 = hasArrowEnd ? pushOutward(p2Anchor, arrowApexOffset(strokeWidth)) : p2Anchor;
    const mag = handleMag(p1, p2);
    const h1 = handleForSide(p1, p1.side, mag);
    const h2 = handleForSide(p2, p2.side, mag);
    return `M ${p1.x} ${p1.y} C ${h1.cx} ${h1.cy}, ${h2.cx} ${h2.cy}, ${p2.x} ${p2.y}`;
}

/** Bezier from rect side to an arbitrary world point — used for
 *  rubber-band preview while the user is picking the second endpoint.
 *  Source side picked the same way as committed arrows; target end is
 *  a free point with a horizontal handle (no side to perpendicular-to).
 *  Preview always shows the arrow marker, so push the cursor endpoint
 *  slightly back from the cursor in the tangent direction to match the
 *  committed-arrow apex-offset look. */
function bezierToPoint(a: Rect, p: { x: number; y: number }, strokeWidth: number): string {
    const p1 = sideAnchorToward(a, p.x, p.y);
    const mag = handleMag(p1, p);
    const h1 = handleForSide(p1, p1.side, mag);
    // Pull the cursor end toward p1 horizontally so the preview curve
    // doesn't fishhook at weird angles. Also shorten the path by the
    // arrow apex offset so the marker's tip aligns with the actual
    // cursor position rather than overshooting it.
    const dx = p.x - p1.x;
    const dir = dx >= 0 ? -1 : 1;
    const apexOffset = arrowApexOffset(strokeWidth);
    const dxFromP1 = p.x - p1.x;
    const dyFromP1 = p.y - p1.y;
    const dist = Math.sqrt(dxFromP1 * dxFromP1 + dyFromP1 * dyFromP1) || 1;
    const endX = p.x - (dxFromP1 / dist) * apexOffset;
    const endY = p.y - (dyFromP1 / dist) * apexOffset;
    const h2 = { cx: endX + dir * mag, cy: endY };
    return `M ${p1.x} ${p1.y} C ${h1.cx} ${h1.cy}, ${h2.cx} ${h2.cy}, ${endX} ${endY}`;
}
