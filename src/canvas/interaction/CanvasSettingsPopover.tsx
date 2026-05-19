import React, { useEffect, useRef, useState } from 'react';
import { Settings, Check, LogIn, LogOut, User } from 'lucide-react';
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
import { t, useLocale } from '../../i18n/strings';
import { useAuth } from '../../components/AuthProvider';

const GRID_LABEL_KEY = {
    off: 'panel.grid_off',
    lines: 'panel.grid_lines',
    dots: 'panel.grid_dots',
} as const;

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
    useLocale();
    const grid = useGridSettings();
    const auth = useAuth();
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
                    className="absolute top-full left-0 mt-2 z-50 w-72 p-3 rounded-xl bg-[#1a1a22]/95 backdrop-blur-xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] space-y-3 no-drag"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    {/* Account — mirrors the chat Settings panel so users can
                        sign in / out without leaving Canvas mode. Trial users
                        who haven't signed in yet still see a CTA. */}
                    <div className="flex items-center gap-2 text-white/40">
                        <User size={11} />
                        <span className="text-[9px] uppercase font-bold tracking-widest">{t('settings.account')}</span>
                    </div>
                    {auth.isAuthenticated ? (
                        <div className="bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                            <div className="flex items-center gap-2.5">
                                <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-[11px] font-bold">
                                    {auth.user?.displayName?.[0]?.toUpperCase() || auth.user?.email?.[0]?.toUpperCase() || '?'}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[11px] font-medium text-white truncate">{auth.user?.displayName || 'User'}</div>
                                    <div className="text-[9px] text-white/40 truncate">{auth.user?.email}</div>
                                </div>
                                <button
                                    onClick={() => { setOpen(false); void auth.signOut(); }}
                                    title={t('settings.signout')}
                                    className="flex items-center gap-1 text-[10px] text-red-400/70 hover:text-red-400 transition-colors cursor-pointer"
                                >
                                    <LogOut size={10} />
                                    {t('settings.signout')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            onClick={() => { setOpen(false); (window as any).klypixShowSignIn?.(); }}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-[11px] font-medium transition-colors cursor-pointer"
                        >
                            <LogIn size={11} />
                            {t('settings.signin_cta_button')}
                        </button>
                    )}

                    <div className="h-px bg-white/5" />

                    <div className="text-[9px] font-bold uppercase tracking-widest text-white/40">{t('panel.background')}</div>
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

                    <div className="pt-1 text-[9px] font-bold uppercase tracking-widest text-white/40">{t('panel.grid')}</div>
                    <div className="grid grid-cols-3 gap-2">
                        {(['dots', 'lines', 'off'] as GridStyle[]).map((style) => {
                            const active = grid.style === style;
                            const label = t(GRID_LABEL_KEY[style]);
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
                        <div className="text-[10px] text-white/70">{t('panel.grid_color')}</div>
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
