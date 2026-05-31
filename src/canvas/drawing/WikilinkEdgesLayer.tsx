import React, { useMemo } from 'react';
import type { CanvasItem } from '../items/types';
import { computeWikilinkEdges } from '../items/wikilinks';
import { bezierBetween } from './ConnectionsLayer';

interface Rect { x: number; y: number; w: number; h: number; }

interface Props {
    items: Record<string, CanvasItem>;
    /** Children of collapsed containers etc. — skip edges touching them so
     *  links don't dangle across empty canvas. */
    hiddenIds?: Set<string>;
}

// 2026-05-31 (Obsidian comfort layer): auto-drawn graph edges derived from
// [[wikilinks]] in text cards. Visually DISTINCT from user-drawn connection
// arrows — softer link-purple, dashed, lower opacity, non-interactive — so an
// intentional arrow always reads stronger than an auto link. Lives inside the
// world-transform layer (same as ConnectionsLayer) so it pans/zooms with the
// canvas. The edges are COMPUTED from card text every render (never stored or
// synced) so they always reflect the current titles + links.
const LINK_COLOR = '#8b9cff';

function WikilinkEdgesLayerImpl({ items, hiddenIds }: Props) {
    const edges = useMemo(() => computeWikilinkEdges(items), [items]);
    if (edges.length === 0) return null;

    const rectOf = (it: CanvasItem): Rect => ({ x: it.x, y: it.y, w: it.w, h: it.h });

    return (
        <svg
            style={{
                position: 'absolute', left: 0, top: 0,
                width: '100000px', height: '100000px',
                overflow: 'visible', pointerEvents: 'none',
            }}
            aria-hidden
        >
            <defs>
                <marker id="klpx-wikilink-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={LINK_COLOR} />
                </marker>
            </defs>
            {edges.map((e) => {
                const a = items[e.fromId];
                const b = items[e.toId];
                if (!a || !b) return null;
                if (hiddenIds && (hiddenIds.has(e.fromId) || hiddenIds.has(e.toId))) return null;
                const d = bezierBetween(rectOf(a), rectOf(b), true, 1.5);
                return (
                    <path
                        key={`${e.fromId}->${e.toId}`}
                        d={d}
                        stroke={LINK_COLOR}
                        strokeWidth={1.5}
                        strokeDasharray="6 5"
                        fill="none"
                        opacity={0.55}
                        markerEnd="url(#klpx-wikilink-arrow)"
                    />
                );
            })}
        </svg>
    );
}

export const WikilinkEdgesLayer = React.memo(WikilinkEdgesLayerImpl);
