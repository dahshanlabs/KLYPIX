import React, { useMemo, useRef } from 'react';
import { useCanvasStore } from '../state/canvasStore';
import {
    getContainerRenderMode,
    isDottedMode,
    isLooseItemDottedAtZoom,
    DOT_SCREEN_PX,
} from '../items/ContainerItem';
import { animateView } from '../interaction/viewAnimate';
import type { CanvasItem } from '../items/types';

// Canvas overlay that renders dotted containers as screen-constant
// colored circles, clustering nearby dots into a single count-badged
// dot so the overview reads as "a handful of things here" rather than
// a mess of individual points.
//
// Layout: rendered INSIDE the world-transform layer in CanvasRenderer,
// so dot positions inherit the pan/zoom transform like any other canvas
// child. Sizes are world-px = SCREEN_PX / zoom so they stay the same
// visual size at any zoom level.

// Screen-px distance under which two dots are considered "close enough"
// to merge into one cluster. Small enough that distinct groups with
// room between them stay separate; large enough that 3 dots visible
// at 2% zoom with no gap between them become one.
const CLUSTER_DISTANCE_SCREEN_PX = 40;

// Palette for cluster dots. Stable hash of a member ID picks the
// color so (a) dots don't all come out the same emerald when every
// container inherits the default brand color, and (b) a given cluster
// gets the same color every render (no flicker). The palette lines
// up roughly with the nested-frame hues used elsewhere in the canvas
// so the visual language is consistent.
const DOT_PALETTE: readonly string[] = [
    'rgba(16,185,129,0.85)',   // emerald
    'rgba(56,189,248,0.85)',   // sky
    'rgba(251,113,133,0.85)',  // rose
    'rgba(192,132,252,0.85)',  // violet
    'rgba(245,158,11,0.85)',   // amber
    'rgba(236,72,153,0.85)',   // pink
    'rgba(45,212,191,0.85)',   // teal
];

function dotColorFor(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    return DOT_PALETTE[Math.abs(hash) % DOT_PALETTE.length];
}

interface DottedItem {
    id: string;
    cx: number;  // world-space center
    cy: number;
    item: CanvasItem;
}

interface Cluster {
    members: DottedItem[];          // containers + loose items, clustered uniformly
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    cx: number;
    cy: number;
    count: number;                  // = members.length
}

function computeClusters(
    candidates: DottedItem[],
    zoom: number,
): Cluster[] {
    if (candidates.length === 0) return [];
    const worldDist = CLUSTER_DISTANCE_SCREEN_PX / Math.max(0.01, zoom);
    const worldDistSq = worldDist * worldDist;

    // BFS clustering across all candidates uniformly — a container dot
    // and a lone-text dot are the same kind of thing at this zoom, so
    // proximity merges them into one cluster. O(n²) worst case, fine
    // for the handful of dotted items a typical canvas has; if it ever
    // grows into thousands, swap to a spatial hash.
    const assigned = new Set<string>();
    const groups: DottedItem[][] = [];
    for (const seed of candidates) {
        if (assigned.has(seed.id)) continue;
        const queue: DottedItem[] = [seed];
        const members: DottedItem[] = [];
        while (queue.length > 0) {
            const cur = queue.shift()!;
            if (assigned.has(cur.id)) continue;
            assigned.add(cur.id);
            members.push(cur);
            for (const other of candidates) {
                if (assigned.has(other.id)) continue;
                const dx = other.cx - cur.cx;
                const dy = other.cy - cur.cy;
                if (dx * dx + dy * dy < worldDistSq) queue.push(other);
            }
        }
        groups.push(members);
    }

    return groups.map(members => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const m of members) {
            minX = Math.min(minX, m.item.x);
            minY = Math.min(minY, m.item.y);
            maxX = Math.max(maxX, m.item.x + m.item.w);
            maxY = Math.max(maxY, m.item.y + m.item.h);
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        return {
            members,
            bbox: { minX, minY, maxX, maxY },
            cx,
            cy,
            count: members.length,
        };
    });
}

export function DotClusterLayer() {
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    // Drag state held in a ref so mid-drag pointer-move doesn't
    // re-render the component. We only read it on pointer events.
    const dragRef = useRef<{
        startClientX: number;
        startClientY: number;
        startPositions: Array<{ id: string; x: number; y: number }>;
        moved: boolean;
    } | null>(null);

    const clusters = useMemo(() => {
        // Collect every item that should render as a dot at the current
        // zoom — containers that are in dotted render mode, and loose
        // top-level items whose max dimension × zoom is below the dot
        // threshold. They all go through the same clustering pass, so
        // a lone text next to a group clusters naturally with it.
        const candidates: DottedItem[] = [];
        for (const id of state.order) {
            const it = state.items[id];
            if (!it) continue;
            if (it.type === 'container') {
                const mode = getContainerRenderMode(it, state.view.zoom, state.items, {
                    zoomCollapsedIds: state.zoomCollapsedIds,
                    userOverrideExpandedIds: state.userOverrideExpandedIds,
                });
                if (!isDottedMode(mode)) continue;
            } else if (!isLooseItemDottedAtZoom(it, state.view.zoom, state.editingId === id, state.drawingId === id)) {
                continue;
            }
            candidates.push({
                id,
                cx: it.x + it.w / 2,
                cy: it.y + it.h / 2,
                item: it,
            });
        }
        return computeClusters(candidates, state.view.zoom);
    }, [state.order, state.items, state.view.zoom, state.zoomCollapsedIds, state.userOverrideExpandedIds]);

    if (clusters.length === 0) return null;

    const z = Math.max(0.01, state.view.zoom);
    const baseDotWorld = DOT_SCREEN_PX / z;

    const zoomToCluster = (c: Cluster) => (e: React.MouseEvent) => {
        e.stopPropagation();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const padFill = 0.7;
        const bboxW = Math.max(1, c.bbox.maxX - c.bbox.minX);
        const bboxH = Math.max(1, c.bbox.maxY - c.bbox.minY);
        const targetZoom = Math.max(0.1, Math.min(2, Math.min(
            (vw * padFill) / bboxW,
            (vh * padFill) / bboxH,
        )));
        animateView({
            from: state.view,
            centerWorld: { x: c.cx, y: c.cy },
            zoom: targetZoom,
            viewport: { w: vw, h: vh },
            onFrame: (v) => dispatch({ type: 'SET_VIEW', view: v }),
        });
    };

    // Click-vs-drag threshold in screen-px. Below this, the pointerup
    // is treated as a click (zoom to fit). Above, as a drag (move all
    // members + nearby items together). Matches typical OS drag-start
    // tolerance so accidental twitches don't become unintended moves.
    const MOVE_THRESHOLD_PX = 4;

    const onDotPointerDown = (c: Cluster) => (e: React.PointerEvent) => {
        e.stopPropagation();
        // Pre-select the cluster's contents on every pointer-down
        // (left-click zoom, right-click context menu, drag). This is
        // what makes Ctrl+C / Ctrl+X / Ctrl+V and the context menu's
        // Copy / Duplicate / Delete actions operate on the whole
        // cluster without any new plumbing. Right-click: the native
        // contextmenu event bubbles to the canvas surface which opens
        // the menu at the click position; the selection is already in
        // place by then. Members now include both dotted containers
        // and dotted loose items (clustered uniformly).
        const selectIds = c.members.map(m => m.id);
        dispatch({ type: 'SELECT', ids: selectIds });
        // Only primary button starts a drag. Right-click continues
        // along the contextmenu path; middle-click is reserved.
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = {
            startClientX: e.clientX,
            startClientY: e.clientY,
            startPositions: c.members.map(m => ({ id: m.id, x: m.item.x, y: m.item.y })),
            moved: false,
        };
    };

    const onDotPointerMove = (e: React.PointerEvent) => {
        const ds = dragRef.current;
        if (!ds) return;
        const dx = e.clientX - ds.startClientX;
        const dy = e.clientY - ds.startClientY;
        if (!ds.moved) {
            if (Math.abs(dx) < MOVE_THRESHOLD_PX && Math.abs(dy) < MOVE_THRESHOLD_PX) return;
            ds.moved = true;
            // Snapshot only once an actual drag starts so a plain
            // click-to-zoom doesn't pollute the undo stack.
            pushSnapshot();
        }
        const zoom = Math.max(0.01, state.view.zoom);
        const dxWorld = dx / zoom;
        const dyWorld = dy / zoom;
        for (const p of ds.startPositions) {
            dispatch({ type: 'UPDATE_ITEM', id: p.id, patch: { x: p.x + dxWorld, y: p.y + dyWorld } });
        }
    };

    const onDotPointerUp = (c: Cluster) => (e: React.PointerEvent) => {
        const ds = dragRef.current;
        dragRef.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
        if (ds && !ds.moved) {
            // Below-threshold — treat as a click: zoom to fit. The
            // pre-selection in onDotPointerDown was to give context-menu
            // and Ctrl+C/V something to act on; after the user commits
            // to "zoom in to look at this," they want a clean canvas to
            // pick from next, not the entire cluster left highlighted.
            // Drop selection BEFORE animating so the post-zoom view has
            // no leftover selection rings or floating capsules.
            dispatch({ type: 'SELECT', ids: [] });
            zoomToCluster(c)(e as any);
        }
    };

    return (
        <>
            {clusters.map((c, i) => {
                const isCluster = c.count > 1;
                // Cluster weight: slightly bigger dot for bigger counts.
                // Log-scale keeps it readable — a 50-item cluster isn't
                // 50× the size of a singleton.
                const sizeMult = isCluster ? Math.min(1.8, 1 + Math.log2(c.count) * 0.18) : 1;
                const size = baseDotWorld * sizeMult;
                const firstItem = c.members[0].item as any;
                const dotColor = dotColorFor(c.members[0].id);
                // Selection: cluster is "selected" when any of its members
                // is in state.selectedIds. Renders a brighter emerald ring
                // around the dot so selection is visually obvious; also
                // prevents the confusing scattered tiny ring artifact that
                // used to appear when selection overlays drew at raw
                // world-px bounds of tiny members.
                const isSelected = c.members.some(m => state.selectedIds.includes(m.id));
                // Badge sized as a fraction of the dot so the two scale
                // together; dimensions stay in world-px so the transform
                // layer handles zoom consistency.
                const badgeSize = size * 0.85;
                // Tooltip: cluster count, or a description of the solo
                // member. Containers have a title; text items have
                // content; other types fall back to the type name.
                const soloLabel: string = firstItem.title
                    ?? firstItem.content
                    ?? firstItem.fileName
                    ?? firstItem.type
                    ?? 'Item';
                const labelText = isCluster ? String(c.count) : String(soloLabel).slice(0, 40);

                return (
                    <div
                        key={`cluster-${i}`}
                        style={{
                            position: 'absolute',
                            left: c.cx - size / 2,
                            top: c.cy - size / 2,
                            width: size,
                            height: size,
                            pointerEvents: 'none',
                        }}
                    >
                        <div
                            onPointerDown={onDotPointerDown(c)}
                            onPointerMove={onDotPointerMove}
                            onPointerUp={onDotPointerUp(c)}
                            onPointerCancel={onDotPointerUp(c)}
                            title={labelText}
                            style={{
                                position: 'absolute',
                                inset: 0,
                                borderRadius: '50%',
                                background: dotColor,
                                boxShadow: isSelected
                                    ? `0 0 0 ${2 / z}px rgba(16,185,129,0.85), 0 0 ${8 / z}px ${2 / z}px rgba(16,185,129,0.4)`
                                    : `0 0 0 ${1 / z}px rgba(255,255,255,0.2)`,
                                cursor: 'grab',
                                pointerEvents: 'auto',
                                // Prevent the native image-drag ghost
                                // from appearing if the dot is dragged
                                // across a bordered region.
                                touchAction: 'none',
                                userSelect: 'none',
                            }}
                        />
                        {/* Always show the count badge — consistent whether
                            the dot represents 1, 2, or many items. User
                            asked for a solo "1" badge so it's clear the
                            dot is an item-count indicator at any count. */}
                        <div
                            style={{
                                position: 'absolute',
                                top: -badgeSize * 0.35,
                                right: -badgeSize * 0.35,
                                minWidth: badgeSize,
                                height: badgeSize,
                                padding: `0 ${badgeSize * 0.22}px`,
                                borderRadius: badgeSize,
                                background: 'rgba(18,18,26,0.95)',
                                border: `${1 / z}px solid rgba(255,255,255,0.3)`,
                                color: '#e8e8ed',
                                fontSize: badgeSize * 0.65,
                                fontWeight: 600,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                lineHeight: 1,
                                pointerEvents: 'none',
                                fontFamily: 'inherit',
                            }}
                        >
                            {c.count}
                        </div>
                    </div>
                );
            })}
        </>
    );
}
