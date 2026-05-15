import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { CustomColorPick } from './CustomColorPick';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Fill-only style panel: No Fill toggle, Recent / Palette color rows,
// Opacity slider (shape-wide — same `opacity` field as today), and a
// Hex input. Split out from the old unified StylePanel so Fill and
// Stroke are two discrete mental models. Preview / commit callbacks
// come from the parent (Toolbar); panel itself is stateless about
// canvas data.

export const PALETTE_COLORS = ['#10b981', '#e8e8ed', '#0a0a0f', '#f5a623', '#ef4444', '#3b82f6', '#a855f7'];
const REVERT_DELAY_MS = 40;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface Props {
    fillColor: string | undefined;      // undefined = mixed
    fillEnabled: boolean | undefined;   // undefined = mixed; false = "No fill"
    opacity: number | undefined;
    recentColors: string[];

    onPreviewColor: (c: string) => void;
    onCommitColor: (c: string) => void;
    onPreviewFillOff: () => void;
    onCommitFillOff: () => void;
    onCommitFillOn: () => void;           // re-enable with the current state.fillColor default
    onPreviewOpacity: (o: number) => void;
    onCommitOpacity: (o: number) => void;

    onRevertPreview: () => void;
}

export const FillPanel = React.forwardRef<HTMLDivElement, Props>(function FillPanel(props, ref) {
    const {
        fillColor, fillEnabled, opacity, recentColors,
        onPreviewColor, onCommitColor,
        onPreviewFillOff, onCommitFillOff, onCommitFillOn,
        onPreviewOpacity, onCommitOpacity,
        onRevertPreview,
    } = props;

    const selfRef = useRef<HTMLDivElement | null>(null);
    const setRefs = (el: HTMLDivElement | null) => {
        selfRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };

    // Auto-reposition so the panel stays in the viewport regardless of
    // which toolbar button opened it. Same pattern as the earlier
    // unified StylePanel — re-runs on any ResizeObserver fire or window
    // resize so conditional rows (Recent, Mixed labels) don't clip.
    const [topOffset, setTopOffset] = useState(0);
    const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
    const [measured, setMeasured] = useState(false);
    const topOffsetRef = useRef(0);
    topOffsetRef.current = topOffset;
    useLayoutEffect(() => {
        const el = selfRef.current;
        if (!el) return;
        // Safe zones around the panel. BOTTOM_PAD is intentionally larger
        // than TOP_PAD to clear KlypixCanvas's bottom-left and bottom-
        // right dock bars (file/save/zoom/etc. at `bottom-3` ≈ 44px tall
        // including padding). Without this the panel visually overlapped
        // those docks at tall selections.
        const TOP_PAD = 8;
        const BOTTOM_PAD = 64;
        const reposition = () => {
            const vh = window.innerHeight;
            const rect = el.getBoundingClientRect();
            const currentShift = topOffsetRef.current;
            const baseTop = rect.top - currentShift;
            const baseBottom = rect.bottom - currentShift;
            let next = 0;
            let cap: number | undefined = undefined;
            if (rect.height + TOP_PAD + BOTTOM_PAD > vh) {
                next = TOP_PAD - baseTop;
                cap = vh - TOP_PAD - BOTTOM_PAD;
            } else if (baseBottom + BOTTOM_PAD > vh) {
                next = (vh - BOTTOM_PAD) - baseBottom;
            }
            setTopOffset(prev => (prev !== next ? next : prev));
            setMaxHeight(prev => (prev !== cap ? cap : prev));
            setMeasured(true);
        };
        reposition();
        const ro = new ResizeObserver(reposition);
        ro.observe(el);
        window.addEventListener('resize', reposition);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', reposition);
        };
    }, []);

    // Debounced revert so transitions between chips in the same row
    // don't flicker back to the pre-hover value.
    const revertTimerRef = useRef<number | null>(null);
    const scheduleRevert = () => {
        if (revertTimerRef.current != null) window.clearTimeout(revertTimerRef.current);
        revertTimerRef.current = window.setTimeout(() => {
            onRevertPreview();
            revertTimerRef.current = null;
        }, REVERT_DELAY_MS);
    };
    const cancelRevert = () => {
        if (revertTimerRef.current != null) {
            window.clearTimeout(revertTimerRef.current);
            revertTimerRef.current = null;
        }
    };
    useEffect(() => () => cancelRevert(), []);

    const noFillActive = fillEnabled === false;
    const mixedOpacity = opacity === undefined;
    const sliderOpacityValue = opacity ?? 1;

    // Hex input is local state so invalid typing doesn't fight React's
    // rerender. Commits via Enter / Apply. Blurring resets to the
    // committed fill color if the input is invalid at the moment of
    // blur, so the UI never ends on a broken value.
    const [hexDraft, setHexDraft] = useState('');
    const hexValid = HEX_RE.test(hexDraft.trim());
    const submitHex = () => {
        const v = hexDraft.trim();
        if (!HEX_RE.test(v)) return;
        onCommitColor(v);
        setHexDraft('');
    };

    return (
        <div
            ref={setRefs}
            data-canvas-ui="1"
            onWheel={(e) => e.stopPropagation()}
            className="absolute left-full ml-2 z-30 w-60 rounded-xl bg-[#12121a] border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
            style={{
                top: topOffset,
                maxHeight,
                overflowY: maxHeight != null ? 'auto' : 'hidden',
                visibility: measured ? 'visible' : 'hidden',
            }}
        >
            <div className="flex flex-col">
                <Section title="Fill">
                    <button
                        onClick={() => { cancelRevert(); if (noFillActive) onCommitFillOn(); else onCommitFillOff(); }}
                        onMouseEnter={() => { if (!noFillActive) { cancelRevert(); onPreviewFillOff(); } }}
                        onMouseLeave={() => { if (!noFillActive) scheduleRevert(); }}
                        className={cn(
                            'w-full text-[11px] font-medium py-1.5 rounded-md flex items-center justify-center gap-1.5 transition-all',
                            noFillActive
                                ? 'bg-emerald-500/25 text-emerald-300'
                                : 'bg-white/5 text-white/65 hover:bg-white/10',
                        )}
                    >
                        <span
                            className="w-3 h-3 rounded-full relative overflow-hidden ring-1 ring-white/30"
                            style={{ background: 'transparent' }}
                        >
                            <span
                                className="absolute inset-0"
                                style={{
                                    background: 'linear-gradient(45deg, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))',
                                }}
                            />
                        </span>
                        No fill
                    </button>
                </Section>

                <Divider />

                {/* See StrokePanel — grid 0fr→1fr animates the panel growing
                    smoothly when the first Recent swatch is added, instead
                    of popping taller and re-snapping via ResizeObserver. */}
                <div
                    className="grid transition-[grid-template-rows] duration-200 ease-out"
                    style={{ gridTemplateRows: recentColors.length > 0 ? '1fr' : '0fr' }}
                    aria-hidden={recentColors.length === 0}
                >
                    <div className="overflow-hidden">
                        <Section title="Recent">
                            <ColorRow
                                colors={recentColors}
                                active={fillEnabled === true ? fillColor : undefined}
                                onPreview={(c) => { cancelRevert(); onPreviewColor(c); }}
                                onCommit={onCommitColor}
                                onLeave={scheduleRevert}
                            />
                        </Section>
                        <Divider />
                    </div>
                </div>

                <Section title="Palette">
                    <ColorRow
                        colors={PALETTE_COLORS}
                        active={fillEnabled === true ? fillColor : undefined}
                        onPreview={(c) => { cancelRevert(); onPreviewColor(c); }}
                        onCommit={onCommitColor}
                        onLeave={scheduleRevert}
                        customPickSeed={fillEnabled === true ? fillColor : undefined}
                        onCustomCommit={onCommitColor}
                    />
                    {fillEnabled === undefined && (
                        <div className="text-[10px] text-white/35 mt-1">Mixed</div>
                    )}
                </Section>

                <Divider />

                <Section title="Opacity">
                    <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={sliderOpacityValue}
                        onChange={(e) => onPreviewOpacity(Number(e.target.value))}
                        onPointerUp={(e) => onCommitOpacity(Number((e.target as HTMLInputElement).value))}
                        onKeyUp={(e) => onCommitOpacity(Number((e.target as HTMLInputElement).value))}
                        className={cn('w-full accent-emerald-500', mixedOpacity && 'opacity-50')}
                    />
                    <div className="text-[10px] text-white/50 text-right mt-1">
                        {mixedOpacity ? 'Mixed' : `${Math.round(sliderOpacityValue * 100)}%`}
                    </div>
                </Section>

                <Divider />

                <Section title="Hex">
                    <div className="flex items-center gap-1.5">
                        <input
                            type="text"
                            spellCheck={false}
                            placeholder="#RRGGBB"
                            value={hexDraft}
                            onChange={(e) => setHexDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); submitHex(); }
                                e.stopPropagation();
                            }}
                            className={cn(
                                'flex-1 bg-white/5 text-white/85 text-[11px] font-mono px-2 py-1 rounded outline-none border',
                                hexDraft.length === 0
                                    ? 'border-white/10'
                                    : hexValid
                                        ? 'border-emerald-400/50'
                                        : 'border-red-400/60',
                            )}
                        />
                        <button
                            onClick={submitHex}
                            disabled={!hexValid}
                            className={cn(
                                'text-[10px] font-medium py-1 px-2 rounded transition-all',
                                hexValid
                                    ? 'bg-emerald-500/25 text-emerald-300 hover:bg-emerald-500/35 cursor-pointer'
                                    : 'bg-white/5 text-white/25 cursor-not-allowed',
                            )}
                        >
                            Apply
                        </button>
                    </div>
                </Section>
            </div>
        </div>
    );
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="px-3 py-2.5">
            <div className="text-[10px] text-white/40 uppercase tracking-widest mb-1.5">{title}</div>
            {children}
        </div>
    );
}

function Divider() {
    return <div className="h-px bg-white/5" />;
}

interface ColorRowProps {
    colors: string[];
    active: string | undefined;
    onPreview: (c: string) => void;
    onCommit: (c: string) => void;
    onLeave: () => void;
    // Optional trailing "+" custom color picker. When onCustomCommit is
    // provided the row renders a CustomColorPick after the presets; the
    // seed is the color the native picker opens to.
    customPickSeed?: string;
    onCustomCommit?: (c: string) => void;
}

function ColorRow({ colors, active, onPreview, onCommit, onLeave, customPickSeed, onCustomCommit }: ColorRowProps) {
    return (
        <div className="flex items-center gap-1.5 flex-wrap" onMouseLeave={onLeave}>
            {colors.map(c => {
                const isActive = active === c;
                return (
                    <button
                        key={c}
                        onMouseEnter={() => onPreview(c)}
                        onClick={() => onCommit(c)}
                        className={cn(
                            'w-4 h-4 rounded-full transition-all',
                            isActive
                                ? 'ring-2 ring-white scale-110'
                                : 'ring-1 ring-white/20 hover:ring-white/60',
                        )}
                        style={{ background: c }}
                        title={c}
                    />
                );
            })}
            {onCustomCommit && (
                <CustomColorPick onCommit={onCustomCommit} seed={customPickSeed} />
            )}
        </div>
    );
}
