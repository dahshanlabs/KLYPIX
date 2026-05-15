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
                <marker id="klpx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                </marker>
                <marker id="klpx-arrow-emerald" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
                </marker>
                <marker id="klpx-arrow-blue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6" />
                </marker>
                <marker id="klpx-arrow-purple" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#a855f7" />
                </marker>
                <marker id="klpx-arrow-gray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
                </marker>
                <marker id="klpx-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#ef4444" />
                </marker>
                <marker id="klpx-arrow-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
                </marker>
                <marker id="klpx-arrow-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#f97316" />
                </marker>
            </defs>
            {list.map(c => {
                const a = items[c.fromId];
                const b = items[c.toId];
                if (!a || !b) return null;
                // Skip connections touching hidden items (e.g. inside a
                // collapsed container) — otherwise arrows dangle in empty
                // space where the items used to be.
                if (hiddenIds && (hiddenIds.has(c.fromId) || hiddenIds.has(c.toId))) return null;
                const aRect = rectOf(a);
                const bRect = rectOf(b);
                const path = bezierBetween(aRect, bRect);
                const isSelected = selectedIds?.has(c.id) ?? false;
                const rel = styleForConnection(c);
                // Stroke color: explicit c.color wins (user-customized connection),
                // otherwise fall back to relationship color. Selection is shown
                // via the +1.5 width boost and opacity=1 below — we intentionally
                // DON'T override the color here, so palette picks are visible
                // while the connection stays selected.
                const hasExplicitColor = !!c.color && c.color !== '#10b981';
                const stroke = hasExplicitColor ? c.color : rel.color;
                // Dash pattern: the user's explicit dashed style wins; otherwise
                // the relationship's own dashing decides. (Plain solid
                // connections inherit relationship dashing for free.)
                const dashed = c.style === 'dashed' || rel.dashed;
                const dashPattern = dashed ? '8 4' : undefined;
                const connScale = sharedContainerScale(a, b, items);
                // Authored width + style boost scaled by the shared
                // container. isSelected adds a flat +1.5 AFTER scaling
                // so the selection highlight stays visible even at
                // heavily-shrunk group scales.
                const baseWidth = (c.width || 2) + rel.widthBoost;
                const width = baseWidth * connScale + (isSelected ? 1.5 : 0);
                const mid = midpoint(aRect, bRect);
                // Arrow marker inherits the path's stroke color via the
                // context-stroke marker. Prior behavior locked user-colored
                // connections to an emerald arrowhead regardless of the
                // line color, which was visibly wrong.
                const arrowMarker = !c.arrowHead ? undefined : 'klpx-arrow';
                return (
                    <g key={c.id}>
                        {/* Invisible wide stroke for click targeting — makes
                            the arrow easier to click without visually thickening it.
                            data-canvas-connection lets the surface onContextMenu
                            identify connections (items use data-canvas-item). */}
                        <path
                            d={path}
                            data-canvas-connection={c.id}
                            stroke="transparent"
                            strokeWidth={Math.max(12, (c.width || 2) + 10)}
                            fill="none"
                            pointerEvents={onPickConnection ? 'stroke' : 'none'}
                            onPointerDown={(e) => {
                                if (!onPickConnection) return;
                                // Right-click: select this connection but let
                                // the event bubble to the surface so the
                                // canvas context menu opens at the cursor.
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
            })}
            {hasPreview && previewFrom && previewToWorld && (
                <path
                    d={bezierToPoint(rectOf(previewFrom), previewToWorld)}
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

/** Point on the rect's border along the line from the rect's center
 *  toward (tx, ty). Used so connections anchor to the edge of each
 *  endpoint instead of the center. */
function edgePointTowardRect(r: Rect, tx: number, ty: number): { x: number; y: number } {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const hw = r.w / 2;
    const hh = r.h / 2;
    // Parametric line: center + t × (dx, dy). Smallest t that hits
    // either the vertical or horizontal edge wins. Infinity-clamp a
    // zero delta so the OTHER axis wins.
    const tX = dx === 0 ? Infinity : hw / Math.abs(dx);
    const tY = dy === 0 ? Infinity : hh / Math.abs(dy);
    const t = Math.min(tX, tY);
    return { x: cx + dx * t, y: cy + dy * t };
}

/** Handle magnitude along the line from p1 to p2 — used by the cubic
 *  bezier control points so the curve bows outward on its own half of
 *  the span. Floor of 40 keeps short-distance curves from flattening
 *  into a straight line. */
function handleMag(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
    const dx = p2.x - p1.x;
    return Math.max(40, Math.abs(dx) * 0.5);
}

/** Midpoint of the cubic bezier at t=0.5 — used to anchor the
 *  relationship icon on top of the arrow. Takes RECTs (rendered
 *  bounds) so collapsed containers anchor to the capsule, not the
 *  phantom expanded frame. */
function midpoint(a: Rect, b: Rect): { x: number; y: number } {
    const centerA = rectCenter(a);
    const centerB = rectCenter(b);
    const p1 = edgePointTowardRect(a, centerB.x, centerB.y);
    const p2 = edgePointTowardRect(b, centerA.x, centerA.y);
    const dir = p2.x >= p1.x ? 1 : -1;
    const h = handleMag(p1, p2);
    const c1x = p1.x + dir * h;
    const c2x = p2.x - dir * h;
    const x = (p1.x + 3 * c1x + 3 * c2x + p2.x) / 8;
    const y = (p1.y + 3 * p1.y + 3 * p2.y + p2.y) / 8;
    return { x, y };
}

/** S-curve between the two rect EDGES. Arrowhead lands on the target
 *  rect's border, not its interior. */
function bezierBetween(a: Rect, b: Rect): string {
    const centerA = rectCenter(a);
    const centerB = rectCenter(b);
    const p1 = edgePointTowardRect(a, centerB.x, centerB.y);
    const p2 = edgePointTowardRect(b, centerA.x, centerA.y);
    const dir = p2.x >= p1.x ? 1 : -1;
    const h = handleMag(p1, p2);
    const c1x = p1.x + dir * h;
    const c2x = p2.x - dir * h;
    return `M ${p1.x} ${p1.y} C ${c1x} ${p1.y}, ${c2x} ${p2.y}, ${p2.x} ${p2.y}`;
}

/** Bezier from rect edge to an arbitrary world point — used for
 *  rubber-band preview while the user is picking the second endpoint. */
function bezierToPoint(a: Rect, p: { x: number; y: number }): string {
    const p1 = edgePointTowardRect(a, p.x, p.y);
    const dir = p.x >= p1.x ? 1 : -1;
    const h = handleMag(p1, p);
    const c1x = p1.x + dir * h;
    const c2x = p.x - dir * h;
    return `M ${p1.x} ${p1.y} C ${c1x} ${p1.y}, ${c2x} ${p.y}, ${p.x} ${p.y}`;
}
