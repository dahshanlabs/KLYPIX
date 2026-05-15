import React from 'react';
import { Plus, X } from 'lucide-react';

// A thin strip along the top of the canvas chrome. Each tab shows its current
// title (from filePath or "Untitled") and an unsaved dot. Click to activate;
// middle-click or × to close; + adds a new untitled tab.

export interface TabMeta {
    id: string;
    title: string;
    dirty: boolean;
}

interface Props {
    tabs: TabMeta[];
    activeId: string;
    onSwitch: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
}

export const TAB_BAR_HEIGHT = 32;

export function TabBar({ tabs, activeId, onSwitch, onClose, onNew }: Props) {
    return (
        <div
            className="flex items-end gap-0.5 px-2 border-b border-white/5 bg-[#08080c] no-drag"
            style={{ height: TAB_BAR_HEIGHT, minHeight: TAB_BAR_HEIGHT }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
        >
            <div className="flex-1 flex items-end gap-0.5 overflow-x-auto overflow-y-hidden">
                {tabs.map((t) => (
                    <TabPill
                        key={t.id}
                        tab={t}
                        active={t.id === activeId}
                        onSwitch={() => onSwitch(t.id)}
                        onClose={() => onClose(t.id)}
                    />
                ))}
                <button
                    onClick={onNew}
                    title="New canvas tab"
                    className="flex items-center justify-center w-6 h-6 mb-1 ml-1 rounded text-white/40 hover:text-emerald-300 hover:bg-white/5 transition-colors shrink-0"
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
    onSwitch: () => void;
    onClose: () => void;
}

function TabPill({ tab, active, onSwitch, onClose }: TabPillProps) {
    const bg = active ? '#12121a' : 'transparent';
    const border = active ? 'border-white/10' : 'border-transparent';
    const text = active ? 'text-white/85' : 'text-white/55';
    return (
        <div
            role="tab"
            aria-selected={active}
            onClick={onSwitch}
            onMouseDown={(e) => {
                // Middle-click closes (common browser convention)
                if (e.button === 1) { e.preventDefault(); onClose(); }
            }}
            className={`flex items-center gap-1.5 pl-2.5 pr-1 h-7 rounded-t-md border ${border} ${text} cursor-pointer transition-colors hover:text-white`}
            style={{ background: bg, minWidth: 110, maxWidth: 180 }}
            title={tab.title}
        >
            <span className="flex-1 truncate text-[11.5px] font-medium">{tab.title}</span>
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
