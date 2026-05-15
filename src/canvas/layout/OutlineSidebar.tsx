import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Image as ImageIcon, File as FileIcon, LayoutGrid, Square, X, Search, Video as VideoIcon, Music as MusicIcon, Code2 as CodeIcon, PenTool, Minus as LineIcon } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { fitToViewport } from '../CanvasEngine';
import type { CanvasItem } from '../items/types';

// Synthetic outline entry for drawings. Drawings aren't CanvasItems so
// they don't flow through state.order / state.items; we materialize them
// here so they appear in the tree under their parent container (or at
// the root for top-level drawings), matching the group header's
// "N ITEMS" count.
interface DrawingEntry {
    kind: 'line' | 'stroke';
    id: string;
    parentId: string | null | undefined;
    bbox: { x: number; y: number; w: number; h: number };
    label: string;
}

interface Props {
    open: boolean;
    onClose: () => void;
}

// Hierarchical item list with search + click-to-jump. Containers are
// expandable; everything else sorted by creation time. Spec §22B.

export function OutlineSidebar({ open, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    const [q, setQ] = useState('');
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    const { topLevel, childrenOf, topLevelDrawings, drawingsByParent } = useMemo(() => {
        const top: CanvasItem[] = [];
        const kids: Record<string, CanvasItem[]> = {};
        for (const id of state.order) {
            const it = state.items[id];
            if (!it) continue;
            if (!it.parentId) top.push(it);
            else (kids[it.parentId] = kids[it.parentId] || []).push(it);
        }
        const topDraw: DrawingEntry[] = [];
        const drawKids: Record<string, DrawingEntry[]> = {};
        const pushDraw = (d: DrawingEntry) => {
            if (d.parentId) (drawKids[d.parentId] = drawKids[d.parentId] || []).push(d);
            else topDraw.push(d);
        };
        for (const [lid, ln] of Object.entries(state.lines)) {
            pushDraw({
                kind: 'line',
                id: lid,
                parentId: ln.parentId,
                bbox: {
                    x: Math.min(ln.x1, ln.x2),
                    y: Math.min(ln.y1, ln.y2),
                    w: Math.max(1, Math.abs(ln.x2 - ln.x1)),
                    h: Math.max(1, Math.abs(ln.y2 - ln.y1)),
                },
                label: 'Line',
            });
        }
        for (const [sid, st] of Object.entries(state.strokes)) {
            if (st.points.length === 0) continue;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of st.points) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }
            pushDraw({
                kind: 'stroke',
                id: sid,
                parentId: st.parentId,
                bbox: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) },
                label: 'Pen stroke',
            });
        }
        return { topLevel: top, childrenOf: kids, topLevelDrawings: topDraw, drawingsByParent: drawKids };
    }, [state.items, state.order, state.lines, state.strokes]);

    const match = (it: CanvasItem): boolean => {
        if (!q.trim()) return true;
        const qq = q.toLowerCase();
        if (it.type === 'text') return it.content.toLowerCase().includes(qq);
        if (it.type === 'file') return it.fileName.toLowerCase().includes(qq);
        if (it.type === 'image') return (it.fileName || '').toLowerCase().includes(qq);
        if (it.type === 'video' || it.type === 'audio') return it.fileName.toLowerCase().includes(qq);
        if (it.type === 'code') return (it.fileName || '').toLowerCase().includes(qq) || it.code.toLowerCase().includes(qq);
        if (it.type === 'container') return it.title.toLowerCase().includes(qq);
        return false;
    };

    const jumpTo = (it: CanvasItem) => {
        dispatch({ type: 'SELECT', ids: [it.id] });
        const view = fitToViewport(
            { x: it.x - 200, y: it.y - 200, w: it.w + 400, h: it.h + 400 },
            { w: window.innerWidth, h: window.innerHeight },
        );
        dispatch({ type: 'SET_VIEW', view });
    };

    const jumpToDrawing = (d: DrawingEntry) => {
        if (d.kind === 'line') dispatch({ type: 'SELECT_LINES', ids: [d.id] });
        else dispatch({ type: 'SELECT_STROKES', ids: [d.id] });
        const view = fitToViewport(
            { x: d.bbox.x - 200, y: d.bbox.y - 200, w: d.bbox.w + 400, h: d.bbox.h + 400 },
            { w: window.innerWidth, h: window.innerHeight },
        );
        dispatch({ type: 'SET_VIEW', view });
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute top-3 left-3 bottom-16 z-30 no-drag w-[260px] rounded-xl bg-[#12121a]/95 border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden animate-in slide-in-from-left-2 fade-in duration-150">
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60 flex-1">Outline</span>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-white/40"><X size={12} /></button>
            </div>
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                <Search size={11} className="text-white/30" />
                <input
                    placeholder="Filter"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="flex-1 bg-transparent outline-none text-[11px] text-white/80 placeholder-white/25"
                />
            </div>
            <div className="flex-1 overflow-auto py-1">
                {topLevel.map(it => (
                    <OutlineRow
                        key={it.id}
                        item={it}
                        childrenOf={childrenOf}
                        drawingsByParent={drawingsByParent}
                        collapsed={collapsed}
                        setCollapsed={setCollapsed}
                        match={match}
                        onJump={jumpTo}
                        onJumpDrawing={jumpToDrawing}
                        selectedItemIds={state.selectedIds}
                        selectedLineIds={state.selectedLineIds}
                        selectedStrokeIds={state.selectedStrokeIds}
                        depth={0}
                        query={q}
                    />
                ))}
                {topLevelDrawings.map(d => (
                    <DrawingRow
                        key={`${d.kind}-${d.id}`}
                        entry={d}
                        onJump={jumpToDrawing}
                        selected={
                            d.kind === 'line'
                                ? state.selectedLineIds.includes(d.id)
                                : state.selectedStrokeIds.includes(d.id)
                        }
                        depth={0}
                    />
                ))}
                {topLevel.length === 0 && topLevelDrawings.length === 0 && (
                    <div className="text-[10px] text-white/30 text-center py-6">empty canvas</div>
                )}
            </div>
            <div className="border-t border-white/5 px-3 py-1.5 text-[9px] uppercase tracking-widest text-white/30">
                {(() => {
                    const total =
                        state.order.length
                        + Object.keys(state.lines).length
                        + Object.keys(state.strokes).length;
                    return `${total} ${total === 1 ? 'item' : 'items'}`;
                })()}
            </div>
        </div>
    );
}

interface RowProps {
    item: CanvasItem;
    childrenOf: Record<string, CanvasItem[]>;
    drawingsByParent: Record<string, DrawingEntry[]>;
    collapsed: Record<string, boolean>;
    setCollapsed: (fn: (s: Record<string, boolean>) => Record<string, boolean>) => void;
    match: (it: CanvasItem) => boolean;
    onJump: (it: CanvasItem) => void;
    onJumpDrawing: (d: DrawingEntry) => void;
    selectedItemIds: string[];
    selectedLineIds: string[];
    selectedStrokeIds: string[];
    depth: number;
    query: string;
}

function OutlineRow({
    item, childrenOf, drawingsByParent, collapsed, setCollapsed,
    match, onJump, onJumpDrawing,
    selectedItemIds, selectedLineIds, selectedStrokeIds,
    depth, query,
}: RowProps) {
    const kids = childrenOf[item.id] || [];
    const drawKids = drawingsByParent[item.id] || [];
    const isContainer = item.type === 'container';
    const selected = selectedItemIds.includes(item.id);
    const show = match(item) || (query.trim() && kids.some(c => match(c)));
    if (!show) return null;
    const isCollapsed = collapsed[item.id];
    // Total child count for the badge = items + drawings (matches the
    // header "N ITEMS" the user sees on the group frame).
    const totalKids = kids.length + drawKids.length;

    const Icon =
        item.type === 'text' ? FileText :
        item.type === 'image' ? ImageIcon :
        item.type === 'file' ? FileIcon :
        item.type === 'video' ? VideoIcon :
        item.type === 'audio' ? MusicIcon :
        item.type === 'code' ? CodeIcon :
        item.type === 'container' ? LayoutGrid : Square;

    const label =
        item.type === 'text' ? (item.content || '(empty)').slice(0, 40) :
        item.type === 'file' ? item.fileName :
        item.type === 'image' ? (item.fileName || 'image') :
        item.type === 'video' ? item.fileName :
        item.type === 'audio' ? item.fileName :
        item.type === 'code' ? (item.fileName || `${item.language} snippet`) :
        item.type === 'container' ? item.title :
        'box';

    return (
        <>
            <button
                onClick={() => onJump(item)}
                className={`w-full text-left pl-${2 + depth * 3} pr-3 py-1 flex items-center gap-1.5 hover:bg-white/5 transition-colors ${selected ? 'bg-emerald-500/15' : ''}`}
                style={{ paddingLeft: 8 + depth * 12 }}
            >
                {isContainer && totalKids > 0 ? (
                    <span
                        onClick={(e) => { e.stopPropagation(); setCollapsed(s => ({ ...s, [item.id]: !s[item.id] })); }}
                        className="text-white/40 hover:text-white/70"
                    >
                        {isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                    </span>
                ) : (
                    <span className="w-2.5" />
                )}
                <Icon size={11} className={item.createdBy === 'agent' ? 'text-emerald-400' : 'text-white/50'} />
                <span className={`text-[11px] truncate flex-1 ${selected ? 'text-emerald-200' : 'text-white/75'}`}>{label}</span>
                {totalKids > 0 && <span className="text-[9px] text-white/30">{totalKids}</span>}
            </button>
            {isContainer && !isCollapsed && kids.map(c => (
                <OutlineRow
                    key={c.id}
                    item={c}
                    childrenOf={childrenOf}
                    drawingsByParent={drawingsByParent}
                    collapsed={collapsed}
                    setCollapsed={setCollapsed}
                    match={match}
                    onJump={onJump}
                    onJumpDrawing={onJumpDrawing}
                    selectedItemIds={selectedItemIds}
                    selectedLineIds={selectedLineIds}
                    selectedStrokeIds={selectedStrokeIds}
                    depth={depth + 1}
                    query={query}
                />
            ))}
            {isContainer && !isCollapsed && drawKids.map(d => (
                <DrawingRow
                    key={`${d.kind}-${d.id}`}
                    entry={d}
                    onJump={onJumpDrawing}
                    selected={
                        d.kind === 'line'
                            ? selectedLineIds.includes(d.id)
                            : selectedStrokeIds.includes(d.id)
                    }
                    depth={depth + 1}
                />
            ))}
        </>
    );
}

interface DrawingRowProps {
    entry: DrawingEntry;
    onJump: (d: DrawingEntry) => void;
    selected: boolean;
    depth: number;
}

function DrawingRow({ entry, onJump, selected, depth }: DrawingRowProps) {
    const Icon = entry.kind === 'line' ? LineIcon : PenTool;
    return (
        <button
            onClick={() => onJump(entry)}
            className={`w-full text-left pr-3 py-1 flex items-center gap-1.5 hover:bg-white/5 transition-colors ${selected ? 'bg-emerald-500/15' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 }}
        >
            <span className="w-2.5" />
            <Icon size={11} className="text-white/50" />
            <span className={`text-[11px] truncate flex-1 ${selected ? 'text-emerald-200' : 'text-white/75'}`}>
                {entry.label}
            </span>
        </button>
    );
}
