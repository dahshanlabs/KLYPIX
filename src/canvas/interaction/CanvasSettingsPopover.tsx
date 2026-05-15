import React, { useEffect, useRef, useState } from 'react';
import { Settings, Check } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
    useGridSettings,
    setGridSettings,
    isDarkBackground,
    CANVAS_BG_DARK,
    CANVAS_BG_PAPER,
    type GridStyle,
} from '../gridSettings';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Canvas-native settings popover. Opens from a gear button in the
// top-left file-ops cluster. Covers the three things that affect
// the whole canvas surface (not per-item): background, grid style,
// grid tint. Dark/Paper presets live beside a custom color picker —
// preset swatches stay authoritative-looking even when the user picks
// a close-but-not-exact color, so we compare by hex.

const PRESETS: { color: string; label: string }[] = [
    { color: CANVAS_BG_DARK, label: 'Dark' },
    { color: CANVAS_BG_PAPER, label: 'Paper' },
];

export function CanvasSettingsPopover() {
    const grid = useGridSettings();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!anchorRef.current) return;
            if (!anchorRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const bgIsDark = isDarkBackground(grid.background);
    const previewStroke = bgIsDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';

    return (
        <div ref={anchorRef} className="relative">
            <button
                onClick={() => setOpen((v) => !v)}
                title="Canvas settings"
                className={cn(
                    'w-7 h-7 flex items-center justify-center rounded-full transition-colors cursor-pointer',
                    open ? 'text-white bg-white/10' : 'text-white/50 hover:text-white hover:bg-white/10',
                )}
            >
                <Settings size={13} />
            </button>

            {open && (
                <div
                    className="absolute top-full left-0 mt-2 z-50 w-64 p-3 rounded-xl bg-[#1a1a22]/95 backdrop-blur-xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] space-y-3 no-drag"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className="text-[9px] font-bold uppercase tracking-widest text-white/40">Background</div>
                    <div className="flex items-center gap-2">
                        {PRESETS.map((p) => {
                            const active = grid.background.toLowerCase() === p.color.toLowerCase();
                            return (
                                <button
                                    key={p.color}
                                    onClick={() => setGridSettings({ background: p.color })}
                                    title={p.label}
                                    className={cn(
                                        'relative w-8 h-8 rounded-lg transition-all border',
                                        active ? 'border-emerald-400 ring-2 ring-emerald-400/30' : 'border-white/10 hover:border-white/30',
                                    )}
                                    style={{ backgroundColor: p.color }}
                                >
                                    {active && (
                                        <Check size={12} className={cn('absolute inset-0 m-auto', isDarkBackground(p.color) ? 'text-white' : 'text-black')} />
                                    )}
                                </button>
                            );
                        })}
                        <label
                            title="Custom background color"
                            className="relative w-8 h-8 rounded-lg cursor-pointer border border-white/10 hover:border-white/30 flex items-center justify-center"
                            style={{
                                background: 'conic-gradient(from 0deg, #ef4444, #f5a623, #10b981, #3b82f6, #a855f7, #ef4444)',
                            }}
                        >
                            <input
                                type="color"
                                value={grid.background}
                                onChange={(e) => setGridSettings({ background: e.target.value })}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            />
                            <span className="text-white text-[14px] font-semibold leading-none pointer-events-none drop-shadow">+</span>
                        </label>
                        <div className="ml-auto text-[9px] text-white/40 font-mono uppercase">{grid.background}</div>
                    </div>

                    <div className="pt-1 text-[9px] font-bold uppercase tracking-widest text-white/40">Grid</div>
                    <div className="grid grid-cols-3 gap-2">
                        {(['dots', 'lines', 'off'] as GridStyle[]).map((style) => {
                            const active = grid.style === style;
                            const label = style === 'off' ? 'Off' : style === 'dots' ? 'Dots' : 'Lines';
                            const preview =
                                style === 'off'
                                    ? 'none'
                                    : style === 'dots'
                                        ? `radial-gradient(circle, ${previewStroke} 1px, transparent 1px)`
                                        : `linear-gradient(to right, ${previewStroke} 1px, transparent 1px), linear-gradient(to bottom, ${previewStroke} 1px, transparent 1px)`;
                            return (
                                <button
                                    key={style}
                                    onClick={() => setGridSettings({ style })}
                                    className={cn(
                                        'p-1.5 rounded-lg border transition-all flex flex-col items-stretch gap-1',
                                        active ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-white/5 border-white/5 hover:bg-white/10',
                                    )}
                                >
                                    <div
                                        className="h-8 rounded border border-white/10"
                                        style={{
                                            backgroundColor: grid.background,
                                            backgroundImage: preview,
                                            backgroundSize: '6px 6px',
                                        }}
                                    />
                                    <div className={cn('text-[9px] font-bold text-center', active ? 'text-emerald-300' : 'text-white/60')}>{label}</div>
                                </button>
                            );
                        })}
                    </div>

                    <div
                        className={cn(
                            'flex items-center justify-between bg-white/5 border border-white/10 rounded-lg px-3 py-2',
                            grid.style === 'off' && 'opacity-40 pointer-events-none',
                        )}
                    >
                        <div className="text-[10px] text-white/70">Grid color</div>
                        <label
                            className="relative w-5 h-5 rounded-full cursor-pointer ring-1 ring-white/20 hover:ring-white/60 transition-all"
                            style={{ backgroundColor: grid.color }}
                        >
                            <input
                                type="color"
                                value={grid.color}
                                onChange={(e) => setGridSettings({ color: e.target.value })}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            />
                        </label>
                    </div>
                </div>
            )}
        </div>
    );
}
