import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useCanvasStore } from './state/canvasStore';
import { TextItemView } from './items/TextItem';
import { BoxItemView } from './items/BoxItem';
import { ImageItemView } from './items/ImageItem';
import { FileCardView } from './items/FileItem';
import { ApprovalItemView } from './items/ApprovalItem';
import { LinkItemView } from './items/LinkItem';
import { CanvasLinkItemView } from './items/CanvasLinkItem';
import { VideoItemView } from './items/VideoItem';
import { AudioItemView } from './items/AudioItem';
import { CodeItemView } from './items/CodeItem';
import { ContainerItemView, ContainerHeaderView, countChildren, getCollapsedRenderW, getContainerRenderMode, isTabMode, isDottedMode, isLooseItemDottedAtZoom, computeCapsuleRenderMetrics, resolveContainerRenderRect } from './items/ContainerItem';
import { ItemBadges } from './items/ItemBadges';
import { effectiveLayerId } from './layout/LayersPanel';
import { ConnectionsLayer } from './drawing/ConnectionsLayer';
import { StrokeView, LineView } from './drawing/DrawingLayer';
import { MultiSelectionBox } from './interaction/MultiSelectionBox';
import { DotClusterLayer } from './drawing/DotClusterLayer';
import { DrawingResizeHandles } from './interaction/DrawingResizeHandles';
import { rectsIntersect, type Rect } from './CanvasEngine';

// Renders all canvas items on a single transform layer with viewport culling:
// only items whose world bounds intersect the current (visible rect + padding)
// are mounted as React components. This is spec §23 Layer 2 — critical for
// canvases with 100+ items. Items currently being edited are ALWAYS rendered
// even if offscreen (losing the textarea mid-edit would be catastrophic).

const VIEWPORT_PADDING = 200; // pixels in screen space, pre-mount margin for smooth scroll
const CULL_DEBOUNCE_MS = 50;  // re-compute visible set at most every 50ms during pan

function useViewport(): { w: number; h: number } {
    const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
    useEffect(() => {
        const h = () => setVp({ w: window.innerWidth, h: window.innerHeight });
        window.addEventListener('resize', h);
        return () => window.removeEventListener('resize', h);
    }, []);
    return vp;
}

interface CanvasRendererProps {
    /** Connect-tool rubber-band preview: item id of the source + current cursor world coords. */
    connectPendingId?: string | null;
    connectHoverWorld?: { x: number; y: number } | null;
}

export function CanvasRenderer({ connectPendingId, connectHoverWorld }: CanvasRendererProps = {}) {
    const { state, dispatch } = useCanvasStore();
    const selectedConnectionSet = useMemo(() => new Set(state.selectedConnectionIds), [state.selectedConnectionIds]);
    // "Enter group" focus mode: ids that are IN the focused container's
    // subtree (the container itself + direct + nested children). Everything
    // else renders dimmed and is non-interactive.
    const focusedId = state.focusedContainerId;
    const inFocusSet = useMemo(() => {
        if (!focusedId) return null;
        // Defensive: if the focused id no longer resolves to a real
        // container item (e.g. it got deleted or the doc was loaded with
        // a stale reference), treat focus as inactive. Otherwise EVERY
        // visible item would fail the in-focus check and render at 25%
        // opacity — the "overall group is faded" bug.
        const target = state.items[focusedId];
        if (!target || target.type !== 'container') return null;
        const set = new Set<string>();
        set.add(focusedId);
        // Walk until no new descendants are added (supports nested containers).
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of Object.keys(state.items)) {
                const it = state.items[id];
                if (!it || set.has(id)) continue;
                if (it.parentId && set.has(it.parentId)) {
                    set.add(id);
                    changed = true;
                }
            }
        }
        return set;
    }, [focusedId, state.items]);
    const { items, order, view, selectedIds, editingId, connections, lines, strokes, zoomCollapsedIds, userOverrideExpandedIds } = state;
    const semanticInputs = { zoomCollapsedIds, userOverrideExpandedIds };
    const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
    const viewport = useViewport();

    // Visible-world rect. Debounced so fast pan doesn't thrash the culling math.
    const [visibleRect, setVisibleRect] = useState<Rect>(() => computeVisibleRect(view, viewport));
    useEffect(() => {
        const t = setTimeout(() => setVisibleRect(computeVisibleRect(view, viewport)), CULL_DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [view, viewport]);

    // Always-render set: the item currently being edited. Prevents the textarea
    // from unmounting if the user pans it out of view.
    const pinnedIds = useMemo(() => {
        const s = new Set<string>();
        if (editingId) s.add(editingId);
        return s;
    }, [editingId]);

    // Status filter: ids the user has hidden via Smart Collections eye toggles.
    // An item is hidden iff its status is in the hidden set; items without an
    // explicit status are always visible. Consulted by the three render passes
    // below so they all stay consistent.
    const statusHiddenSet = useMemo(() => new Set(state.statusFilterHidden), [state.statusFilterHidden]);
    const isStatusHidden = useCallback((id: string): boolean => {
        if (statusHiddenSet.size === 0) return false;
        const it = state.items[id];
        const st = it?.status;
        return !!st && st !== 'none' && statusHiddenSet.has(st);
    }, [statusHiddenSet, state.items]);

    // Collapsed containers hide their descendants transitively. ALSO covers
    // 'collapsed-visual' (expanded state, but zoom too far out). Without
    // transitive hiding, closing an outer group that contains a nested
    // group leaves the inner group's items visible on canvas — spec Issue
    // 3. Fixed via fixed-point iteration: every container whose ancestor
    // chain passes through a tab-mode container is marked hidden, and
    // every item whose parent is in that set is hidden.
    // Misnamed historically — this set hides the BODY/children of any
    // container that isn't 'expanded'. tab-mode (capsule) and dot-mode
    // both qualify: in either case children aren't visible and should
    // not be rendered. Keeping the name for now since it propagates
    // across the file, but `isTabMode || isDottedMode` captures the
    // real intent.
    const tabModeContainers = useMemo(() => {
        const tab = new Set<string>();
        for (const id of order) {
            const it = items[id];
            if (it?.type !== 'container') continue;
            const m = getContainerRenderMode(it, view.zoom, items, semanticInputs);
            if (isTabMode(m) || isDottedMode(m)) tab.add(id);
        }
        return tab;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [order, items, view.zoom, zoomCollapsedIds, userOverrideExpandedIds]);

    const hiddenByCollapse = useMemo(() => {
        const hidden = new Set<string>();
        // Seed with direct children of tab-mode containers.
        for (const [id, it] of Object.entries(items)) {
            if (it?.parentId && tabModeContainers.has(it.parentId)) hidden.add(id);
        }
        // Fixed point: an item whose parent is hidden is also hidden.
        let changed = true;
        while (changed) {
            changed = false;
            for (const [id, it] of Object.entries(items)) {
                if (hidden.has(id)) continue;
                if (it?.parentId && hidden.has(it.parentId)) {
                    hidden.add(id);
                    changed = true;
                }
            }
        }
        return hidden;
    }, [items, tabModeContainers]);

    // Drawings hidden if parentId is EITHER a tab-mode container directly
    // OR an already-hidden item (descendant of a tab-mode container).
    // Previously this only consulted `hiddenByCollapse` which contains
    // descendants of tab-mode containers, NOT the containers themselves —
    // so a stroke parented DIRECTLY to a collapsed group slipped through
    // and stayed visible while its siblings vanished.
    const visibleLines = useMemo(() => {
        const out: typeof lines = {} as any;
        for (const [lid, ln] of Object.entries(lines)) {
            const p = ln.parentId;
            if (p && (tabModeContainers.has(p) || hiddenByCollapse.has(p))) continue;
            out[lid] = ln;
        }
        return out;
    }, [lines, hiddenByCollapse, tabModeContainers]);
    const visibleStrokes = useMemo(() => {
        const out: typeof strokes = {} as any;
        for (const [sid, st] of Object.entries(strokes)) {
            const p = st.parentId;
            if (p && (tabModeContainers.has(p) || hiddenByCollapse.has(p))) continue;
            out[sid] = st;
        }
        return out;
    }, [strokes, hiddenByCollapse, tabModeContainers]);

    // Sort so containers render first (behind children), then cull by viewport.
    const sortedOrder = useMemo(() => {
        // Walk the parent chain to count container ancestors. Matches
        // containerDepth() in ContainerItem but inlined to avoid a
        // cross-module call inside a hot sort comparator.
        const containerDepthOf = (id: string): number => {
            let d = 0;
            let cur = items[id];
            const seen = new Set<string>();
            while (cur?.parentId && !seen.has(cur.parentId)) {
                seen.add(cur.parentId);
                const p = items[cur.parentId];
                if (!p) break;
                if (p.type === 'container') d++;
                cur = p;
            }
            return d;
        };
        return order
            .slice()
            .sort((a, b) => {
                const ta = items[a]?.type === 'container' ? 0 : 1;
                const tb = items[b]?.type === 'container' ? 0 : 1;
                if (ta !== tb) return ta - tb;
                // Among containers: render parents before their nested
                // children so the child's frame paints ON TOP of the
                // parent's (previously a later-created outer group would
                // render after its children, painting over them and
                // hiding the sky-blue depth-1 border under the emerald
                // depth-0 frame). Non-containers keep their original
                // stable insertion order.
                if (ta === 0) return containerDepthOf(a) - containerDepthOf(b);
                return 0;
            });
    }, [order, items]);

    // v3 unified render order: containers first (depth-sorted as a frame
    // backdrop), then non-container items + drawings (lines + pen strokes)
    // interleaved by zKey. This is what allows the Arrange menu to send a
    // stroke behind a box — pre-v3, drawings were a single layer on top of
    // every item, so "send to back" couldn't actually move them down.
    //
    // Caveat: when a CONTAINER is reordered, its descendants' zKeys aren't
    // updated to follow it. Their old zKeys may sort them between unrelated
    // siblings of the moved container. Same limitation existed pre-v3 (the
    // old state.order shuffle had the same blind spot for nested children),
    // so this isn't a regression — just a known edge case to fix when the
    // need arises.
    const renderList = useMemo(() => {
        type Kind = 'item' | 'line' | 'stroke';
        interface Entry { kind: Kind; id: string }
        const containerEntries: Entry[] = [];
        const nonContainerWithKeys: Array<{ entry: Entry; zKey: string }> = [];

        for (const id of sortedOrder) {
            const it = items[id];
            if (!it) continue;
            if (it.type === 'container') {
                containerEntries.push({ kind: 'item', id });
            } else {
                nonContainerWithKeys.push({ entry: { kind: 'item', id }, zKey: it.zKey ?? '' });
            }
        }
        for (const [id, ln] of Object.entries(visibleLines)) {
            nonContainerWithKeys.push({ entry: { kind: 'line', id }, zKey: ln.zKey ?? '' });
        }
        for (const [id, st] of Object.entries(visibleStrokes)) {
            nonContainerWithKeys.push({ entry: { kind: 'stroke', id }, zKey: st.zKey ?? '' });
        }
        // Stable-ish lex sort by zKey. Pre-migration entries (no zKey) sort
        // first as the empty string, which puts them at the bottom of the
        // stack — conservative fallback, no worse than today's behavior.
        nonContainerWithKeys.sort((a, b) => (a.zKey < b.zKey ? -1 : a.zKey > b.zKey ? 1 : 0));

        return [...containerEntries, ...nonContainerWithKeys.map(x => x.entry)];
    }, [sortedOrder, items, visibleLines, visibleStrokes]);

    // Selection rings are rendered in a SEPARATE screen-space overlay
    // (outside the pan/zoom transform) so the ring is always a consistent
    // 1 screen-px border + 2 screen-px shadow at any zoom level. Old
    // approach counter-zoomed world-px borders which visually worked but
    // broke dash spacing, border radius, and SVG-rasterized AA at extreme
    // zooms. Now: items draw themselves; the ring layer draws a clean
    // 1-2px outline on top in screen coords.

    // Which container ids are visible (not culled, not hidden by a
    // collapsed ancestor, not on a hidden layer). Used to render the
    // top-layer ContainerHeaderView for each visible container AFTER
    // all items so headers always sit above their children visually.
    // Sorted by depth ascending — same rationale as the frame sort: a
    // nested child's header must render on top of its parent's header
    // and frame so the inner title/controls aren't painted over by the
    // outer group's later-paint pass.
    const visibleContainerIds = useMemo(() => {
        const list: string[] = [];
        for (const id of order) {
            const it = items[id];
            if (!it || it.type !== 'container') continue;
            if (hiddenByCollapse.has(id)) continue;
            if (state.hiddenLayers.includes(effectiveLayerId(it))) continue;
            if (isStatusHidden(id)) continue;
            if (!pinnedIds.has(id)) {
                const bounds: Rect = { x: it.x, y: it.y, w: it.w, h: it.h };
                if (!rectsIntersect(bounds, visibleRect)) continue;
            }
            list.push(id);
        }
        list.sort((a, b) => {
            const depthOf = (id: string): number => {
                let d = 0;
                let cur = items[id];
                const seen = new Set<string>();
                while (cur?.parentId && !seen.has(cur.parentId)) {
                    seen.add(cur.parentId);
                    const p = items[cur.parentId];
                    if (!p) break;
                    if (p.type === 'container') d++;
                    cur = p;
                }
                return d;
            };
            return depthOf(a) - depthOf(b);
        });
        return list;
    }, [order, items, hiddenByCollapse, state.hiddenLayers, isStatusHidden, pinnedIds, visibleRect]);

    // Selection rects (in screen coords) for the overlay. Computed from
    // world coords × view so the ring is always a consistent 1-2 screen-px
    // regardless of zoom. Skipped for items that are out of focus or
    // offscreen — the ring only renders where the item actually does.
    // Memoized so non-item state changes (focus toggle, panel open/close,
    // tool switch) don't pay the per-render iteration cost.
    const selRects = useMemo(() => {
    const out: { id: string; x: number; y: number; w: number; h: number }[] = [];
    const TITLE_BAR = 28; void TITLE_BAR;
    for (const id of selectedIds) {
        const it = items[id];
        if (!it) continue;
        if (hiddenByCollapse.has(id)) continue;
        if (state.hiddenLayers.includes(effectiveLayerId(it))) continue;
        if (isStatusHidden(id)) continue;
        if (inFocusSet !== null && !inFocusSet.has(id)) continue;
        // Skip the ring for the item currently being edited. The textarea
        // uses fieldSizing:'content' and grows with each keystroke while
        // item.w / item.h in the store only catch up on blur — so the
        // screen-space ring would render at the stale committed width
        // and trail behind the text being typed. The focused textarea's
        // own cursor is the editing indicator; no external ring needed.
        if (editingId === id) continue;
        const z = view.zoom;
        // Collapsed container: rendered width = collapsedW (cosmetic tab
        // width, falls back to w if not set), rendered height = titleBar ×
        // titleScale (with the MIN_HEADER_SCREEN_PX floor so the ring
        // matches the readable header chrome at extreme zoom-out).
        let screenH: number;
        let renderWidthWorld = it.w;
        // For containers, selection ring follows RENDER MODE — not
        // raw state.collapsed. A container in collapsed-visual mode
        // is rendered as a tab; the ring hugs the tab, not the
        // phantom expanded body that isn't drawn at this zoom.
        if (it.type === 'container') {
            const mode = getContainerRenderMode(it, z, items, semanticInputs);
            // Dotted container: its own dot in DotClusterLayer is the
            // selection indicator. Skip the separate ring here.
            if (isDottedMode(mode)) continue;
            if (isTabMode(mode)) {
                // Use the SAME metrics the capsule itself renders with,
                // so the selection ring hugs the visible shape at any
                // zoom. Prior formula (TITLE_BAR × groupScale × zoom)
                // diverged from the capsule's own titleBarH and produced
                // a selection rect ~2-4× the capsule's height at high
                // zoom (e.g. 112 px vs 28 px at 400%).
                renderWidthWorld = getCollapsedRenderW(it as any, z);
                const metrics = computeCapsuleRenderMetrics(it as any, z, items, false);
                screenH = metrics.titleBarH * z;
            } else {
                screenH = it.h * z;
            }
        } else {
            // Loose item in dot mode: DotClusterLayer draws the dot and
            // owns the selection visual. Drawing a world-coord ring at
            // the item's raw bounds would put a tiny stray ring offset
            // from the cluster dot's position — confusing at low zoom.
            if (isLooseItemDottedAtZoom(it, z, editingId === id, state.drawingId === id)) continue;
            screenH = it.h * z;
        }
        out.push({
            id,
            x: view.panX + it.x * z,
            y: view.panY + it.y * z,
            w: renderWidthWorld * z,
            h: screenH,
        });
    }
    // Selection rings for drawings (pen strokes + straight lines). Same
    // screen-space overlay pattern as items — bbox in world coords ×
    // zoom, with a small world-px pad so the ring never clips the stroke.
    const DRAWING_RING_PAD = 4; // screen-px padding on the bbox
    for (const lid of state.selectedLineIds) {
        const ln = state.lines[lid];
        if (!ln) continue;
        const pad = Math.max(2, ln.width / 2);
        const minX = Math.min(ln.x1, ln.x2) - pad;
        const minY = Math.min(ln.y1, ln.y2) - pad;
        const w = (Math.abs(ln.x2 - ln.x1) + pad * 2) * view.zoom;
        const h = (Math.abs(ln.y2 - ln.y1) + pad * 2) * view.zoom;
        out.push({
            id: `ln-${lid}`,
            x: view.panX + minX * view.zoom - DRAWING_RING_PAD,
            y: view.panY + minY * view.zoom - DRAWING_RING_PAD,
            w: w + DRAWING_RING_PAD * 2,
            h: h + DRAWING_RING_PAD * 2,
        });
    }
    for (const sid of state.selectedStrokeIds) {
        const st = state.strokes[sid];
        if (!st || st.points.length === 0) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of st.points) {
            if (pt.x < minX) minX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y > maxY) maxY = pt.y;
        }
        const pad = Math.max(2, st.width / 2);
        out.push({
            id: `st-${sid}`,
            x: view.panX + (minX - pad) * view.zoom - DRAWING_RING_PAD,
            y: view.panY + (minY - pad) * view.zoom - DRAWING_RING_PAD,
            w: (maxX - minX + pad * 2) * view.zoom + DRAWING_RING_PAD * 2,
            h: (maxY - minY + pad * 2) * view.zoom + DRAWING_RING_PAD * 2,
        });
    }
    return out;
    }, [selectedIds, items, hiddenByCollapse, state.hiddenLayers, isStatusHidden, inFocusSet, editingId, view.panX, view.panY, view.zoom, state.zoomCollapsedIds, state.userOverrideExpandedIds, state.drawingId, state.selectedLineIds, state.selectedStrokeIds, state.lines, state.strokes]);

    return (
        <>
        <div
            className="absolute inset-0 origin-top-left"
            style={{
                transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
                transformOrigin: '0 0',
                // NO will-change: transform here. will-change promotes
                // this element to a GPU-composited layer, which causes
                // Chromium to rasterize the content at its natural
                // size and then UPSCALE the texture via GPU — that's
                // the "scaled-up group is very blurry" bug. Without
                // will-change, text and SVG render directly at the
                // final transformed size. Pan/zoom may be microseconds
                // slower but the visual quality is dramatically better.
                pointerEvents: 'none',
            }}
        >
            {renderList.map(entry => {
                // Drawings render as standalone SVGs at their zKey position
                // in the unified order. visibleLines/visibleStrokes have
                // already filtered out hidden-by-collapse / hidden-layer
                // entries; per-stroke viewport culling is intentionally
                // omitted here (drawings are usually small in count).
                if (entry.kind === 'line') {
                    const ln = visibleLines[entry.id];
                    if (!ln) return null;
                    return <LineView key={`ln-${entry.id}`} line={ln} />;
                }
                if (entry.kind === 'stroke') {
                    const st = visibleStrokes[entry.id];
                    if (!st) return null;
                    return <StrokeView key={`st-${entry.id}`} stroke={st} />;
                }
                const id = entry.id;
                const item = items[id];
                if (!item) return null;
                // Skip children of collapsed containers.
                if (hiddenByCollapse.has(id)) return null;
                // Skip items on hidden layers.
                if (state.hiddenLayers.includes(effectiveLayerId(item))) return null;
                // Skip items the user has filtered out by status.
                if (isStatusHidden(id)) return null;
                // Skip loose items that are too small to render meaningfully
                // at current zoom — DotClusterLayer represents them as dots
                // (clustered if near other dotted things, solo otherwise).
                // Containers handle this via ContainerItemView returning
                // null for dotted mode; this covers everything else.
                if (isLooseItemDottedAtZoom(item, view.zoom, editingId === id, state.drawingId === id)) return null;
                // Cull: skip if offscreen AND not pinned.
                if (!pinnedIds.has(id)) {
                    const bounds: Rect = { x: item.x, y: item.y, w: item.w, h: item.h };
                    if (!rectsIntersect(bounds, visibleRect)) return null;
                }
                const isSelected = selected.has(id);
                const isEditing = editingId === id;
                let body: React.ReactNode;
                switch (item.type) {
                    case 'text':
                        body = <TextItemView item={item} selected={isSelected} editing={isEditing} />; break;
                    case 'box':
                        body = <BoxItemView item={item} selected={isSelected} />; break;
                    case 'image':
                        body = <ImageItemView item={item} selected={isSelected} />; break;
                    case 'file':
                        body = <FileCardView item={item} selected={isSelected} />; break;
                    case 'container':
                        body = <ContainerItemView item={item} selected={isSelected} childCount={countChildren(id, items, lines, strokes)} />; break;
                    case 'approval':
                        body = <ApprovalItemView item={item} selected={isSelected} />; break;
                    case 'link':
                        body = <LinkItemView item={item} selected={isSelected} />; break;
                    case 'canvas-link':
                        body = <CanvasLinkItemView item={item} selected={isSelected} />; break;
                    case 'video':
                        body = <VideoItemView item={item} selected={isSelected} />; break;
                    case 'audio':
                        body = <AudioItemView item={item} selected={isSelected} />; break;
                    case 'code':
                        body = <CodeItemView item={item} selected={isSelected} editing={isEditing} />; break;
                    default:
                        body = null;
                }
                // Suppress badges when the container itself is rendered as
                // a dot by DotClusterLayer — the status/tag/comment pips
                // otherwise float in world-coords right on top of (or next
                // to) the cluster dot, leaking through the dot-tier UI.
                const containerRenderMode = item.type === 'container'
                    ? getContainerRenderMode(item, view.zoom, items, semanticInputs)
                    : null;
                const isContainerInDotMode = containerRenderMode !== null
                    && isDottedMode(containerRenderMode);
                const hasBadges = !isContainerInDotMode
                    && ((item.status && item.status !== 'none')
                        || (item.tags && item.tags.length > 0)
                        || (item.comments && item.comments.length > 0));
                // Containers in capsule mode auto-fit their rendered width to
                // the header content, but item.w still stores the expanded
                // size. Resolve the visible rect so badges anchor to the
                // capsule's edges, not to invisible expanded bounds.
                const badgeRect = item.type === 'container'
                    ? resolveContainerRenderRect(item, view.zoom, items, semanticInputs)
                    : undefined;
                // In focus mode, items outside the focused container's
                // subtree render dimmed and with pointer-events:none so they
                // can't be accidentally manipulated. The dim wrapper doesn't
                // remove them from the canvas — just visually steps back.
                const outOfFocus = inFocusSet !== null && !inFocusSet.has(id);
                if (outOfFocus) {
                    return (
                        <div
                            key={id}
                            style={{
                                opacity: 0.25,
                                pointerEvents: 'none',
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                width: 0,
                                height: 0,
                            }}
                        >
                            {body}
                            {hasBadges && <ItemBadges item={item} renderRect={badgeRect} />}
                        </div>
                    );
                }
                return (
                    <React.Fragment key={id}>
                        {body}
                        {hasBadges && <ItemBadges item={item} renderRect={badgeRect} />}
                    </React.Fragment>
                );
            })}
            {/* Connections — rendered AFTER item bodies so arrows / lines
                cross container frames without the dashed frame painting
                on top of them. Previously this lived before items and a
                connection passing through a group's border was visually
                cut by the frame. Drawings and container headers are
                still layered above connections. */}
            <ConnectionsLayer
                connections={connections}
                items={items}
                hiddenIds={hiddenByCollapse}
                selectedIds={selectedConnectionSet}
                onPickConnection={(id, additive) => dispatch({ type: 'SELECT_CONNECTIONS', ids: [id], additive })}
                previewFromId={connectPendingId ?? null}
                previewToWorld={connectHoverWorld ?? null}
                previewWidth={state.strokeWidth}
                previewColor={state.color}
                viewZoom={view.zoom}
                zoomCollapsedIds={zoomCollapsedIds}
                userOverrideExpandedIds={userOverrideExpandedIds}
            />
            {/* v3: drawings now render inline via renderList above so the
                Arrange menu can interleave them with items by zKey. The
                old single-DrawingLayer pass that pinned everything above
                items has been removed — see renderList useMemo for the
                unified ordering. */}
            {/* Container headers — rendered AFTER drawings so the title
                bar + resize handles always sit on top of child items,
                regardless of child stacking order. Gives the group a
                consistent "chrome on top" feel at any zoom. */}
            {visibleContainerIds.map(id => {
                const item = items[id];
                if (!item || item.type !== 'container') return null;
                const isSelected = selected.has(id);
                const outOfFocus = inFocusSet !== null && !inFocusSet.has(id);
                if (outOfFocus) return null;
                return (
                    <ContainerHeaderView
                        key={`header-${id}`}
                        item={item}
                        selected={isSelected}
                        childCount={countChildren(id, items, lines, strokes)}
                    />
                );
            })}
            {/* Tier-3 dot layer. Renders AFTER headers so dots sit on top
                at extreme zoom-out. Self-computes which containers are
                in dotted mode; others pay nothing here. */}
            <DotClusterLayer />
            {/* Outer bounding box + handles for multi-selection. Renders
                only when 2+ entities are selected. Per-item handles stay
                visible but are inert while this is showing — drag is
                routed exclusively through the outer handles. */}
            <MultiSelectionBox />
        </div>
        {/* Screen-space selection ring overlay. Sits above the transform
            layer with fixed 1-px border + 2-px shadow — consistent at
            any view zoom. Not counter-zoomed world-px math anymore. */}
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
            {selRects.map(r => (
                <div
                    key={`sel-${r.id}`}
                    style={{
                        position: 'absolute',
                        left: r.x - 2,
                        top: r.y - 2,
                        width: r.w + 4,
                        height: r.h + 4,
                        border: '1px dashed rgba(16,185,129,0.75)',
                        boxShadow: '0 0 0 2px rgba(16,185,129,0.22)',
                        borderRadius: 6,
                    }}
                />
            ))}
        </div>
        {/* Drawing resize handles — only when exactly ONE drawing is
            selected. Multi-select shows rings only; single select adds
            the 8 interactive handles for scale / stretch. Items already
            render their own ResizeHandle inline; this parallel component
            exists because drawings live in state.lines / state.strokes,
            not state.items, and need their own mutation actions. */}
        {(() => {
            const totalDrawings = state.selectedLineIds.length + state.selectedStrokeIds.length;
            if (totalDrawings !== 1 || state.selectedIds.length > 0) return null;
            if (state.selectedLineIds.length === 1) {
                const lid = state.selectedLineIds[0];
                const ln = state.lines[lid];
                if (!ln) return null;
                const pad = Math.max(2, ln.width / 2);
                const minX = Math.min(ln.x1, ln.x2) - pad;
                const minY = Math.min(ln.y1, ln.y2) - pad;
                const maxX = Math.max(ln.x1, ln.x2) + pad;
                const maxY = Math.max(ln.y1, ln.y2) + pad;
                return (
                    <DrawingResizeHandles
                        kind="line"
                        id={lid}
                        bounds={{ x: minX, y: minY, w: maxX - minX, h: maxY - minY }}
                        view={view}
                    />
                );
            }
            const sid = state.selectedStrokeIds[0];
            const st = state.strokes[sid];
            if (!st || st.points.length === 0) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of st.points) {
                if (pt.x < minX) minX = pt.x;
                if (pt.y < minY) minY = pt.y;
                if (pt.x > maxX) maxX = pt.x;
                if (pt.y > maxY) maxY = pt.y;
            }
            const pad = Math.max(2, st.width / 2);
            return (
                <DrawingResizeHandles
                    kind="stroke"
                    id={sid}
                    bounds={{ x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 }}
                    view={view}
                />
            );
        })()}
        </>
    );
}

/** Translate current pan/zoom into a world-space rect that represents the
 * visible viewport plus a padding cushion on all sides. */
function computeVisibleRect(view: { panX: number; panY: number; zoom: number }, viewport: { w: number; h: number }): Rect {
    const z = Math.max(view.zoom, 0.0001);
    // screen (0,0) → world: (-panX/z, -panY/z)
    const x = -view.panX / z - VIEWPORT_PADDING / z;
    const y = -view.panY / z - VIEWPORT_PADDING / z;
    const w = (viewport.w + VIEWPORT_PADDING * 2) / z;
    const h = (viewport.h + VIEWPORT_PADDING * 2) / z;
    return { x, y, w, h };
}
