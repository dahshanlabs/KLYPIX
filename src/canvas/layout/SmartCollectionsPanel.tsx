import { useMemo, useState } from 'react';
import { X, Filter, Tag as TagIcon, CircleDot, ChevronRight, Type, Square, Image as ImageIcon, File as FileIcon, Folder, CheckSquare, Link as LinkIcon, Video, Music, Code, Eye, EyeOff } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import type { ItemStatus, CanvasItem } from '../items/types';
import { fitToViewport, itemsBounds } from '../CanvasEngine';

interface Props {
    open: boolean;
    onClose: () => void;
}

const STATUS_META: Record<Exclude<ItemStatus, 'none'>, { color: string; label: string }> = {
    todo: { color: '#6b6b80', label: 'To do' },
    in_progress: { color: '#f5a623', label: 'In progress' },
    in_review: { color: '#3b82f6', label: 'In review' },
    done: { color: '#2dd4a0', label: 'Done' },
    blocked: { color: '#ef4444', label: 'Blocked' },
    waiting: { color: '#a855f7', label: 'Waiting' },
};

// Smart collections sidebar: aggregates tags + statuses across the current
// canvas with counts. Clicking a group header expands it inline to a list
// of the actual items so 30+ matches don't just collapse into a single
// fit-all zoom nobody can read. Shift+click the header keeps the old
// select-all + fit-all behavior. Data already lives on items (tags[],
// status) — this is just visualization.

// One short line per item. Used for the expanded list rows so the user can
// tell "To do #3" from "To do #7" without opening each one. Truncated to
// ~30 chars, type-specific content. Falls back to '(untitled)' so the row
// is never blank.
function itemLabel(it: CanvasItem): string {
    const CAP = 32;
    const clip = (s: string) => {
        const t = s.replace(/\s+/g, ' ').trim();
        return t.length > CAP ? t.slice(0, CAP - 1) + '…' : t;
    };
    switch (it.type) {
        case 'text':      return clip(it.content) || '(empty text)';
        case 'code':      return clip(it.fileName || it.code) || '(code)';
        case 'file':      return clip(it.fileName);
        case 'image':     return clip(it.fileName);
        case 'video':     return clip(it.fileName);
        case 'audio':     return clip(it.fileName);
        case 'link':      return clip(it.title || it.url);
        case 'canvas-link': return clip(it.title);
        case 'container': return clip(it.title) || '(group)';
        case 'approval':  return clip(it.question) || '(approval)';
        case 'box':       return '(shape)';
        default:          return '(item)';
    }
}

function ItemIcon({ type }: { type: CanvasItem['type'] }) {
    const props = { size: 11, className: 'shrink-0 text-white/45' };
    switch (type) {
        case 'text':        return <Type {...props} />;
        case 'box':         return <Square {...props} />;
        case 'image':       return <ImageIcon {...props} />;
        case 'file':        return <FileIcon {...props} />;
        case 'container':   return <Folder {...props} />;
        case 'approval':    return <CheckSquare {...props} />;
        case 'link':
        case 'canvas-link': return <LinkIcon {...props} />;
        case 'video':       return <Video {...props} />;
        case 'audio':       return <Music {...props} />;
        case 'code':        return <Code {...props} />;
        default:            return <FileIcon {...props} />;
    }
}

export function SmartCollectionsPanel({ open, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    // Per-group expand state. Keyed by `status:<name>` or `tag:<name>` so the
    // two namespaces can't collide if a user ever names a tag 'todo'.
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const toggle = (key: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const { tagCounts, statusCounts, byStatus, byTag } = useMemo(() => {
        const tags = new Map<string, number>();
        const statuses = new Map<ItemStatus, number>();
        const byStatus = new Map<ItemStatus, string[]>();
        const byTag = new Map<string, string[]>();
        for (const id of state.order) {
            const it = state.items[id];
            if (!it) continue;
            if (it.tags) for (const t of it.tags) {
                tags.set(t, (tags.get(t) || 0) + 1);
                (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(id);
            }
            if (it.status && it.status !== 'none') {
                statuses.set(it.status, (statuses.get(it.status) || 0) + 1);
                (byStatus.get(it.status) ?? byStatus.set(it.status, []).get(it.status)!).push(id);
            }
        }
        const tagCounts = Array.from(tags.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const statusCounts = Array.from(statuses.entries()).sort((a, b) => b[1] - a[1]);
        return { tagCounts, statusCounts, byStatus, byTag };
    }, [state.items, state.order]);

    // Single-item focus: select just that one and zoom to it. Lets the user
    // step through a large collection one by one instead of fit-all zooming
    // 30 items to a blur.
    const focusItem = (id: string) => {
        const it = state.items[id];
        if (!it) return;
        dispatch({ type: 'SELECT', ids: [id] });
        const view = fitToViewport(
            { x: it.x, y: it.y, w: it.w, h: it.h },
            { w: window.innerWidth, h: window.innerHeight },
        );
        dispatch({ type: 'SET_VIEW', view });
    };

    const selectAll = (ids: string[]) => {
        if (ids.length === 0) return;
        dispatch({ type: 'SELECT', ids });
        const rects = ids.map(id => state.items[id]).filter(Boolean);
        const bounds = itemsBounds(rects as { x: number; y: number; w: number; h: number }[]);
        if (!bounds) return;
        const view = fitToViewport(bounds, { w: window.innerWidth, h: window.innerHeight });
        dispatch({ type: 'SET_VIEW', view });
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute top-3 right-3 bottom-16 z-30 no-drag w-[260px] rounded-xl bg-[#12121a]/95 border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden animate-in slide-in-from-right-2 fade-in duration-150">
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                <Filter size={12} className="text-emerald-400" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60 flex-1">Smart collections</span>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-white/40"><X size={12} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-4">
                <section>
                    <div className="flex items-center gap-1.5 mb-2 text-[10px] uppercase tracking-wider text-white/40">
                        <CircleDot size={11} />
                        <span className="flex-1">Status</span>
                        {state.statusFilterHidden.length > 0 && (
                            <button
                                onClick={() => dispatch({ type: 'SET_STATUS_FILTER_HIDDEN', statuses: [] })}
                                className="text-[9.5px] normal-case tracking-normal px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-300 transition-colors"
                                title="Clear status filter — show items of every status"
                            >
                                Show all
                            </button>
                        )}
                    </div>
                    {statusCounts.length === 0 && (
                        <div className="text-[11px] text-white/30 italic">No statuses set yet. Right-click any item → Set status.</div>
                    )}
                    <div className="flex flex-col gap-0.5">
                        {statusCounts.map(([status, count]) => {
                            const meta = STATUS_META[status as Exclude<ItemStatus, 'none'>];
                            if (!meta) return null;
                            const key = `status:${status}`;
                            const isOpen = expanded.has(key);
                            const ids = byStatus.get(status) || [];
                            const isHidden = state.statusFilterHidden.includes(status as ItemStatus);
                            const toggleVisibility = () => {
                                const next = isHidden
                                    ? state.statusFilterHidden.filter(s => s !== status)
                                    : [...state.statusFilterHidden, status as ItemStatus];
                                dispatch({ type: 'SET_STATUS_FILTER_HIDDEN', statuses: next });
                            };
                            return (
                                <div key={status}>
                                    <div className="flex items-center w-full rounded-md hover:bg-white/5 transition-colors">
                                        <button
                                            title="Click to expand · Shift-click to select all"
                                            onClick={(e) => {
                                                if (e.shiftKey) selectAll(ids);
                                                else toggle(key);
                                            }}
                                            className="flex items-center gap-2 flex-1 text-left px-2 py-1.5"
                                        >
                                            <ChevronRight
                                                size={11}
                                                className={`shrink-0 text-white/30 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                                            />
                                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
                                            <span className={`flex-1 text-[11.5px] ${isHidden ? 'text-white/35 line-through' : 'text-white/75'}`}>{meta.label}</span>
                                            <span className="text-[10px] text-white/40 tabular-nums">{count}</span>
                                        </button>
                                        <button
                                            onClick={toggleVisibility}
                                            title={isHidden ? `Show ${meta.label} on canvas` : `Hide ${meta.label} from canvas`}
                                            className={`shrink-0 p-1.5 mr-1 rounded transition-colors ${isHidden ? 'text-white/30 hover:text-white/70' : 'text-emerald-300/80 hover:text-emerald-300'}`}
                                        >
                                            {isHidden ? <EyeOff size={11} /> : <Eye size={11} />}
                                        </button>
                                    </div>
                                    {isOpen && (
                                        <div className="ml-5 mt-0.5 mb-1 pl-2 border-l border-white/5 max-h-[200px] overflow-y-auto flex flex-col gap-0.5">
                                            {ids.map(id => {
                                                const it = state.items[id];
                                                if (!it) return null;
                                                return (
                                                    <button
                                                        key={id}
                                                        onClick={() => focusItem(id)}
                                                        className="flex items-center gap-1.5 w-full text-left px-1.5 py-1 rounded hover:bg-emerald-500/10 hover:text-emerald-200 text-[11px] text-white/65 transition-colors"
                                                        title={itemLabel(it)}
                                                    >
                                                        <ItemIcon type={it.type} />
                                                        <span className="truncate">{itemLabel(it)}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>

                <section>
                    <div className="flex items-center gap-1.5 mb-2 text-[10px] uppercase tracking-wider text-white/40">
                        <TagIcon size={11} />
                        <span>Tags</span>
                    </div>
                    {tagCounts.length === 0 && (
                        <div className="text-[11px] text-white/30 italic">No tags yet. Drop a file — auto-tagger fills these in.</div>
                    )}
                    <div className="flex flex-col gap-0.5">
                        {tagCounts.map(([tag, count]) => {
                            const key = `tag:${tag}`;
                            const isOpen = expanded.has(key);
                            const ids = byTag.get(tag) || [];
                            return (
                                <div key={tag}>
                                    <button
                                        title="Click to expand · Shift-click to select all"
                                        onClick={(e) => {
                                            if (e.shiftKey) selectAll(ids);
                                            else toggle(key);
                                        }}
                                        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors"
                                    >
                                        <ChevronRight
                                            size={11}
                                            className={`shrink-0 text-white/30 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                                        />
                                        <TagIcon size={10} className="shrink-0 text-white/40" />
                                        <span className="flex-1 text-[11.5px] text-white/75 tracking-wide truncate">{tag}</span>
                                        <span className="text-[10px] text-white/40 tabular-nums">{count}</span>
                                    </button>
                                    {isOpen && (
                                        <div className="ml-5 mt-0.5 mb-1 pl-2 border-l border-white/5 max-h-[200px] overflow-y-auto flex flex-col gap-0.5">
                                            {ids.map(id => {
                                                const it = state.items[id];
                                                if (!it) return null;
                                                return (
                                                    <button
                                                        key={id}
                                                        onClick={() => focusItem(id)}
                                                        className="flex items-center gap-1.5 w-full text-left px-1.5 py-1 rounded hover:bg-emerald-500/10 hover:text-emerald-200 text-[11px] text-white/65 transition-colors"
                                                        title={itemLabel(it)}
                                                    >
                                                        <ItemIcon type={it.type} />
                                                        <span className="truncate">{itemLabel(it)}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>
        </div>
    );
}
