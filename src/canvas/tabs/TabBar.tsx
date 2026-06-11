import React from 'react';
import { Plus, X } from 'lucide-react';

// A thin strip along the top of the canvas chrome. Each tab shows its current
// title (from filePath or "Untitled") and an unsaved dot. Click to activate;
// middle-click or × to close; + adds a new untitled tab.

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

export function TabBar({ tabs, activeId, onSwitch, onClose, onNew, variant = 'strip' }: Props) {
    const inline = variant === 'inline';
    return (
        <div
            className={inline
                ? "flex items-center gap-1 h-full min-w-0 no-drag"
                : "flex items-end gap-0.5 px-2 border-b border-white/5 bg-[#08080c] no-drag"}
            style={inline ? undefined : { height: TAB_BAR_HEIGHT, minHeight: TAB_BAR_HEIGHT }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
        >
            <div className={inline
                ? "flex-1 flex items-center gap-1 overflow-x-auto overflow-y-hidden min-w-0"
                : "flex-1 flex items-end gap-0.5 overflow-x-auto overflow-y-hidden"}>
                {tabs.map((t) => (
                    <TabPill
                        key={t.id}
                        tab={t}
                        active={t.id === activeId}
                        inline={inline}
                        onSwitch={() => onSwitch(t.id)}
                        onClose={() => onClose(t.id)}
                    />
                ))}
                <button
                    onClick={onNew}
                    title="New canvas tab"
                    className={inline
                        ? "flex items-center justify-center w-6 h-6 rounded text-white/40 hover:text-emerald-300 hover:bg-white/10 transition-colors shrink-0"
                        : "flex items-center justify-center w-6 h-6 mb-1 ml-1 rounded text-white/40 hover:text-emerald-300 hover:bg-white/5 transition-colors shrink-0"}
                >
                    <Plus size={13} />
                </button>
            </div>
        </div>
    );
}

interface TabPillProps {
    tab: TabMeta;
    active: boolean;
    inline?: boolean;
    onSwitch: () => void;
    onClose: () => void;
}

function TabPill({ tab, active, inline = false, onSwitch, onClose }: TabPillProps) {
    // Inline (header) active uses a translucent white wash so it reads on the
    // emerald title-bar gradient; the strip variant keeps its solid dark fill.
    const bg = active ? (inline ? 'rgba(255,255,255,0.12)' : '#12121a') : 'transparent';
    const border = active ? 'border-white/10' : 'border-transparent';
    const text = active ? 'text-white/90' : 'text-white/55';
    return (
        <div
            role="tab"
            aria-selected={active}
            onClick={onSwitch}
            onMouseDown={(e) => {
                // Middle-click closes (common browser convention)
                if (e.button === 1) { e.preventDefault(); onClose(); }
            }}
            className={`flex items-center gap-1.5 pl-2.5 pr-1 border ${inline ? 'h-6 rounded-md' : 'h-7 rounded-t-md'} ${border} ${text} cursor-pointer transition-colors hover:text-white`}
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
