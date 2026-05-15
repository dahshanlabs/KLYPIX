import React, { useMemo } from 'react';
import { useCanvasStore } from '../state/canvasStore';
import { fitToViewport, itemsBounds } from '../CanvasEngine';
import {
    TITLE_BAR_HEIGHT,
    getCollapsedRenderW,
    getContainerRenderMode,
    isTabMode,
} from '../items/ContainerItem';

const W = 148;
const H = 100;
const PADDING = 6;

// Bottom-right miniature of the canvas. Dot per item colored by type. A
// rectangle marks the current viewport. Click to jump, drag to pan.

export function Minimap() {
    const { state, dispatch } = useCanvasStore();

    // Transitive "hidden under a tab-mode container" set. Mirrors the
    // walk in CanvasRenderer.tsx: any item/drawing whose parent chain
    // passes through a collapsed or collapsed-visual container doesn't
    // render on the main canvas, so the minimap must skip it too —
    // otherwise closing a group leaves its contents visible in the
    // miniature even though the canvas is clean.
    const hiddenByCollapse = useMemo(() => {
        const hidden = new Set<string>();
        const tabModeContainers = new Set<string>();
        for (const id of state.order) {
            const it = state.items[id];
            if (it?.type !== 'container') continue;
            if (isTabMode(getContainerRenderMode(it, state.view.zoom, state.items, {
                zoomCollapsedIds: state.zoomCollapsedIds,
                userOverrideExpandedIds: state.userOverrideExpandedIds,
            }))) tabModeContainers.add(id);
        }
        // Seed: direct children of tab-mode containers.
        for (const [id, it] of Object.entries(state.items)) {
            if (it?.parentId && tabModeContainers.has(it.parentId)) hidden.add(id);
        }
        for (const [id, ln] of Object.entries(state.lines)) {
            if (ln.parentId && tabModeContainers.has(ln.parentId)) hidden.add(`ln:${id}`);
        }
        for (const [id, st] of Object.entries(state.strokes)) {
            if (st.parentId && tabModeContainers.has(st.parentId)) hidden.add(`st:${id}`);
        }
        // Fixed-point cascade for nested containers: an item whose parent
        // container is itself hidden is also hidden. Drawings follow the
        // same rule via their parentId.
        let changed = true;
        while (changed) {
            changed = false;
            for (const [id, it] of Object.entries(state.items)) {
                if (hidden.has(id)) continue;
                if (it?.parentId && hidden.has(it.parentId)) {
                    hidden.add(id);
                    changed = true;
                }
            }
            for (const [id, ln] of Object.entries(state.lines)) {
                const key = `ln:${id}`;
                if (hidden.has(key)) continue;
                if (ln.parentId && hidden.has(ln.parentId)) {
                    hidden.add(key);
                    changed = true;
                }
            }
            for (const [id, st] of Object.entries(state.strokes)) {
                const key = `st:${id}`;
                if (hidden.has(key)) continue;
                if (st.parentId && hidden.has(st.parentId)) {
                    hidden.add(key);
                    changed = true;
                }
            }
        }
        return hidden;
    }, [state.items, state.order, state.lines, state.strokes, state.view.zoom]);

    const data = useMemo(() => {
        const itemsArr = state.order
            .map(id => state.items[id])
            .filter(it => !!it && !hiddenByCollapse.has(it.id));
        // Drawings rendered as bbox rectangles — small enough that a
        // polyline representation at minimap scale reads as noise.
        const linesArr = Object.entries(state.lines)
            .filter(([id]) => !hiddenByCollapse.has(`ln:${id}`))
            .map(([, ln]) => ({
                kind: 'line' as const,
                x: Math.min(ln.x1, ln.x2),
                y: Math.min(ln.y1, ln.y2),
                w: Math.max(1, Math.abs(ln.x2 - ln.x1)),
                h: Math.max(1, Math.abs(ln.y2 - ln.y1)),
            }));
        const strokesArr = Object.entries(state.strokes)
            .filter(([id]) => !hiddenByCollapse.has(`st:${id}`))
            .map(([, st]) => {
                if (st.points.length === 0) return null;
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of st.points) {
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                }
                return { kind: 'stroke' as const, x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
            })
            .filter((s): s is { kind: 'stroke'; x: number; y: number; w: number; h: number } => s !== null);

        const boundsInputs = [
            ...itemsArr.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h })),
            ...linesArr,
            ...strokesArr,
        ];
        const bounds = itemsBounds(boundsInputs);
        if (!bounds) return null;

        // Always include the current viewport in the bounds so the viewport
        // rectangle is visible even when panned far from content.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const zoom = Math.max(state.view.zoom, 0.0001);
        const viewWorld = {
            x: -state.view.panX / zoom,
            y: -state.view.panY / zoom,
            w: vw / zoom,
            h: vh / zoom,
        };
        const fullBounds = {
            x: Math.min(bounds.x, viewWorld.x),
            y: Math.min(bounds.y, viewWorld.y),
            w: Math.max(bounds.x + bounds.w, viewWorld.x + viewWorld.w) - Math.min(bounds.x, viewWorld.x),
            h: Math.max(bounds.y + bounds.h, viewWorld.y + viewWorld.h) - Math.min(bounds.y, viewWorld.y),
        };

        const sx = (W - PADDING * 2) / Math.max(fullBounds.w, 1);
        const sy = (H - PADDING * 2) / Math.max(fullBounds.h, 1);
        const s = Math.min(sx, sy);
        const toMini = (wx: number, wy: number) => ({
            x: PADDING + (wx - fullBounds.x) * s,
            y: PADDING + (wy - fullBounds.y) * s,
        });

        return { items: itemsArr, drawings: [...linesArr, ...strokesArr], bounds: fullBounds, viewWorld, scale: s, toMini };
    }, [state.items, state.order, state.lines, state.strokes, state.view, hiddenByCollapse]);

    const jumpTo = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!data) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const mx = e.clientX - rect.left - PADDING;
        const my = e.clientY - rect.top - PADDING;
        const worldX = data.bounds.x + mx / data.scale;
        const worldY = data.bounds.y + my / data.scale;
        // Center viewport on (worldX, worldY).
        const zoom = state.view.zoom;
        const panX = window.innerWidth / 2 - worldX * zoom;
        const panY = window.innerHeight / 2 - worldY * zoom;
        dispatch({ type: 'SET_VIEW', view: { panX, panY, zoom } });
    };

    return (
        <div
            data-canvas-ui="1"
            onClick={jumpTo}
            title="Minimap — click to jump"
            className="absolute bottom-16 right-3 z-20 no-drag rounded-lg bg-[#12121a]/85 border border-white/10 backdrop-blur-md shadow-[0_4px_16px_rgba(0,0,0,0.4)] cursor-crosshair"
            style={{ width: W, height: H }}
        >
            {data && (
                <svg width={W} height={H} style={{ display: 'block' }}>
                    {data.items.map(it => {
                        const p = data.toMini(it.x, it.y);
                        // Containers in tab mode (collapsed or collapsed-visual
                        // at current zoom) render just their tab in the
                        // minimap — same dimensions as on-canvas, so the
                        // minimap matches what the user actually sees.
                        let renderW = it.w;
                        let renderH = it.h;
                        if (it.type === 'container') {
                            const mode = getContainerRenderMode(it as any, state.view.zoom, state.items, {
                                zoomCollapsedIds: state.zoomCollapsedIds,
                                userOverrideExpandedIds: state.userOverrideExpandedIds,
                            });
                            if (isTabMode(mode)) {
                                renderW = getCollapsedRenderW(it as any, state.view.zoom);
                                renderH = TITLE_BAR_HEIGHT;
                            }
                        }
                        const w = Math.max(1, renderW * data.scale);
                        const h = Math.max(1, renderH * data.scale);
                        const fill =
                            it.type === 'text' ? '#e8e8ed55' :
                            it.type === 'box' ? '#f5a62355' :
                            it.type === 'image' ? '#3b82f655' :
                            it.type === 'file' ? '#10b98155' :
                            it.type === 'container' ? '#10b98133' : '#ffffff33';
                        return <rect key={it.id} x={p.x} y={p.y} width={w} height={h} fill={fill} rx={1} />;
                    })}
                    {/* Drawings (pen strokes + straight lines) — rendered as
                        small bbox rectangles. Detail at minimap scale is
                        noise; the rect is enough to convey "there's ink
                        here" and stays in the user's mental map. */}
                    {data.drawings.map((d, i) => {
                        const p = data.toMini(d.x, d.y);
                        const w = Math.max(1, d.w * data.scale);
                        const h = Math.max(1, d.h * data.scale);
                        const fill = d.kind === 'line' ? '#a855f755' : '#ec489955';
                        return <rect key={`d${i}`} x={p.x} y={p.y} width={w} height={h} fill={fill} rx={1} />;
                    })}
                    {/* Viewport rectangle */}
                    <rect
                        x={data.toMini(data.viewWorld.x, data.viewWorld.y).x}
                        y={data.toMini(data.viewWorld.x, data.viewWorld.y).y}
                        width={data.viewWorld.w * data.scale}
                        height={data.viewWorld.h * data.scale}
                        fill="none"
                        stroke="#10b981"
                        strokeWidth={1}
                    />
                </svg>
            )}
            {!data && (
                <div className="w-full h-full flex items-center justify-center text-[9px] text-white/50 tracking-widest uppercase">
                    empty
                </div>
            )}
        </div>
    );
}
