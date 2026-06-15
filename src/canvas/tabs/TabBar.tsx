import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';

// A thin strip along the top of the canvas chrome. Each tab shows its current
// title (from filePath or "Untitled") and an unsaved dot. Click to activate;
// middle-click or × to close; + adds a new untitled tab.
//
// Inline (header) variant: the tab strip lives inside the app title bar, in the
// LEFT grid column. Because the Chat/Canvas toggle is window-centered, that
// column is capped at ~half the bar — so when more tabs exist than fit, they
// scroll. This component owns the scroll affordances: a thin CUSTOM scrollbar
// overlaid on the bottom edge (visible + draggable, but zero height cost so it
// never clips the short pills or grows the header), plus wheel-to-horizontal
// and active-tab-into-view.

export interface TabMeta {
    id: string;
    title: string;
    dirty: boolean;
    // True when the tab has items / lines / strokes that would be lost on
    // close — used by the close-confirm prompt so an unsaved-but-recently-
    // autosaved canvas (dirty=false because autosave just ran) still warns
    // before discarding work. Optional for back-compat with callers that
    // haven't been updated.
    hasContent?: boolean;
    // True when the canvas is backed by a saved file path. Combined with
    // hasContent + dirty in the close-confirm: safe-to-close means saved
    // (hasFilePath && !dirty) or empty (!hasContent).
    hasFilePath?: boolean;
}

interface Props {
    tabs: TabMeta[];
    activeId: string;
    onSwitch: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    // 'strip'  = standalone 32px bar (legacy, its own dark background + border).
    // 'inline' = pills sized to sit inline in the app title bar (no background
    //            bar, no bottom border) — the merged-into-header layout.
    variant?: 'strip' | 'inline';
}

export const TAB_BAR_HEIGHT = 32;

// Smallest the draggable thumb is allowed to get, so it stays grabbable even
// with many tabs.
const MIN_THUMB_PX = 28;

export function TabBar({ tabs, activeId, onSwitch, onClose, onNew, variant = 'strip' }: Props) {
    const inline = variant === 'inline';
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLDivElement>(null);
    // Custom-scrollbar geometry in px. overflow=false → no bar (everything fits).
    const [bar, setBar] = useState<{ overflow: boolean; thumbW: number; thumbX: number }>(
        { overflow: false, thumbW: 0, thumbX: 0 }
    );

    const measure = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const { scrollLeft, scrollWidth, clientWidth } = el;
        if (scrollWidth <= clientWidth + 1) {
            setBar((p) => (p.overflow ? { overflow: false, thumbW: 0, thumbX: 0 } : p));
            return;
        }
        const thumbW = Math.max((clientWidth / scrollWidth) * clientWidth, MIN_THUMB_PX);
        const maxScroll = scrollWidth - clientWidth;
        const maxThumbX = clientWidth - thumbW;
        const thumbX = maxScroll > 0 ? (scrollLeft / maxScroll) * maxThumbX : 0;
        setBar({ overflow: true, thumbW, thumbX });
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        measure();
        el.addEventListener('scroll', measure, { passive: true });
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    }, [measure]);

    // Re-measure when tabs are added / removed (content width changed).
    useEffect(() => { measure(); }, [tabs.length, measure]);

    // Switching to a tab that's scrolled off-screen brings it into view.
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeId]);

    const onWheel = (e: React.WheelEvent) => {
        // Mouse users have no horizontal wheel — translate vertical wheel into
        // horizontal tab scroll. Only when there's actual overflow, so a normal
        // (non-overflowing) strip doesn't swallow the gesture.
        const el = scrollRef.current;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        if (e.deltaY !== 0 && !e.shiftKey) el.scrollLeft += e.deltaY;
    };

    // Drag the thumb → scroll. Maps thumb-track px to scroll px so the tabs
    // track the pointer 1:1 with the thumb.
    const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const el = scrollRef.current;
        if (!el) return;
        const startX = e.clientX;
        const startScroll = el.scrollLeft;
        const maxScroll = el.scrollWidth - el.clientWidth;
        const maxThumbX = el.clientWidth - bar.thumbW;
        const ratio = maxThumbX > 0 ? maxScroll / maxThumbX : 0;
        const thumb = e.currentTarget;
        thumb.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => { el.scrollLeft = startScroll + (ev.clientX - startX) * ratio; };
        const up = () => {
            try { thumb.releasePointerCapture(e.pointerId); } catch { /* already released by a cancel */ }
            thumb.removeEventListener('pointermove', move);
            thumb.removeEventListener('pointerup', up);
            thumb.removeEventListener('pointercancel', up);
        };
        thumb.addEventListener('pointermove', move);
        thumb.addEventListener('pointerup', up);
        thumb.addEventListener('pointercancel', up); // touch/OS interruption must also tear down
    };

    return (
        <div
            className={inline
                ? "flex items-center gap-1 h-full min-w-0 no-drag"
                : "flex items-end gap-0.5 px-2 border-b border-white/5 bg-[#08080c] no-drag"}
            style={inline ? undefined : { height: TAB_BAR_HEIGHT, minHeight: TAB_BAR_HEIGHT }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
        >
            {/* Positioning context for the overlaid scrollbar. */}
            <div className="relative flex-1 min-w-0">
                <div
                    ref={scrollRef}
                    className={(inline
                        ? "flex items-center gap-1 w-full overflow-x-auto overflow-y-hidden min-w-0"
                        : "flex items-end gap-0.5 w-full overflow-x-auto overflow-y-hidden min-w-0") + " klypix-tabscroll"}
                    onWheel={onWheel}
                >
                    {tabs.map((t) => (
                        <TabPill
                            key={t.id}
                            tab={t}
                            active={t.id === activeId}
                            inline={inline}
                            pillRef={t.id === activeId ? activeRef : undefined}
                            onSwitch={() => onSwitch(t.id)}
                            onClose={() => onClose(t.id)}
                        />
                    ))}
                </div>
                {/* Thin custom scrollbar — overlays the bottom edge so it costs no
                    height. The track is pointer-events-none (clicks pass through to
                    the tabs); only the thumb is grabbable. */}
                {bar.overflow && (
                    <div className="pointer-events-none absolute left-0 right-0 bottom-0 h-[6px] no-drag">
                        {/* Faint rail — keeps the scroll channel visible AT REST so
                            users can see the strip is scrollable without hovering.
                            Bracket opacity (/[0.06]) on purpose: a bare /6 silently
                            drops to no rule in this Tailwind setup. */}
                        <div className="absolute left-0 right-0 bottom-0 h-[3px] rounded-full bg-white/[0.06]" />
                        {/* Brighter draggable thumb on top. */}
                        <div
                            onPointerDown={onThumbDown}
                            className="pointer-events-auto absolute bottom-0 h-[3px] rounded-full bg-white/30 hover:bg-white/50 active:bg-white/60 cursor-grab active:cursor-grabbing transition-colors"
                            style={{ left: bar.thumbX, width: bar.thumbW }}
                            title="Scroll tabs"
                        />
                    </div>
                )}
            </div>
            {/* + lives OUTSIDE the scroll container so it's always reachable —
                it never scrolls away. */}
            <button
                onClick={onNew}
                title="New canvas tab"
                className={inline
                    ? "flex items-center justify-center w-6 h-6 ml-0.5 rounded text-white/40 hover:text-emerald-300 hover:bg-white/10 transition-colors shrink-0"
                    : "flex items-center justify-center w-6 h-6 mb-1 ml-1 rounded text-white/40 hover:text-emerald-300 hover:bg-white/5 transition-colors shrink-0"}
            >
                <Plus size={13} />
            </button>
        </div>
    );
}

interface TabPillProps {
    tab: TabMeta;
    active: boolean;
    inline?: boolean;
    // Set on the active pill so the strip can scroll it into view on switch.
    pillRef?: React.Ref<HTMLDivElement>;
    onSwitch: () => void;
    onClose: () => void;
}

function TabPill({ tab, active, inline = false, pillRef, onSwitch, onClose }: TabPillProps) {
    // Inline (header) active uses a translucent white wash so it reads on the
    // emerald title-bar gradient; the strip variant keeps its solid dark fill.
    const bg = active ? (inline ? 'rgba(255,255,255,0.12)' : '#12121a') : 'transparent';
    const border = active ? 'border-white/10' : 'border-transparent';
    const text = active ? 'text-white/90' : 'text-white/55';
    return (
        <div
            ref={pillRef}
            role="tab"
            aria-selected={active}
            onClick={onSwitch}
            onMouseDown={(e) => {
                // Middle-click closes (common browser convention)
                if (e.button === 1) { e.preventDefault(); onClose(); }
            }}
            className={`flex items-center gap-1.5 pl-2.5 pr-1 border ${inline ? 'h-6 rounded-md' : 'h-7 rounded-t-md'} ${border} ${text} cursor-pointer transition-colors hover:text-white shrink-0`}
            style={{ background: bg, minWidth: inline ? 88 : 110, maxWidth: 180 }}
            title={tab.title}
        >
            {/* div, NOT span: `.title-bar span` force-styles every span white+bold,
                which would erase the active/inactive contrast once portaled into
                the header. A div is immune to that global rule. */}
            <div className="flex-1 truncate text-[11.5px] font-medium">{tab.title}</div>
            {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Unsaved changes" />}
            <button
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                title="Close tab"
                className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
            >
                <X size={11} />
            </button>
        </div>
    );
}
