import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { CustomColorPick } from './CustomColorPick';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Stroke-only style panel: No Stroke toggle, Recent / Palette color
// rows, Width slider, Line Style (solid / dashed / dotted). Fill-only
// concerns (opacity, hex) live in FillPanel instead.

export const PALETTE_COLORS = ['#10b981', '#e8e8ed', '#0a0a0f', '#f5a623', '#ef4444', '#3b82f6', '#a855f7'];
const STROKE_MIN = 1;
const STROKE_MAX = 20;
const REVERT_DELAY_MS = 40;

interface Props {
    strokeColor: string | undefined;            // undefined = mixed
    strokeEnabled: boolean | undefined;         // undefined = mixed; false = "No stroke"
    strokeWidth: number | undefined;
    lineStyle: 'solid' | 'dashed' | 'dotted' | undefined;
    recentColors: string[];

    onPreviewColor: (c: string) => void;
    onCommitColor: (c: string) => void;
    onPreviewStrokeOff: () => void;
    onCommitStrokeOff: () => void;
    onCommitStrokeOn: () => void;               // re-enable with state.color default
    onPreviewWidth: (w: number) => void;
    onCommitWidth: (w: number) => void;
    onPreviewLineStyle: (s: 'solid' | 'dashed' | 'dotted') => void;
    onCommitLineStyle: (s: 'solid' | 'dashed' | 'dotted') => void;

    onRevertPreview: () => void;
}

export const StrokePanel = React.forwardRef<HTMLDivElement, Props>(function StrokePanel(props, ref) {
    const {
        strokeColor, strokeEnabled, strokeWidth, lineStyle, recentColors,
        onPreviewColor, onCommitColor,
        onPreviewStrokeOff, onCommitStrokeOff, onCommitStrokeOn,
        onPreviewWidth, onCommitWidth,
        onPreviewLineStyle, onCommitLineStyle,
        onRevertPreview,
    } = props;

    const selfRef = useRef<HTMLDivElement | null>(null);
    const setRefs = (el: HTMLDivElement | null) => {
        selfRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };

    const [topOffset, setTopOffset] = useState(0);
    const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
    const [measured, setMeasured] = useState(false);
    const topOffsetRef = useRef(0);
    topOffsetRef.current = topOffset;
    useLayoutEffect(() => {
        const el = selfRef.current;
        if (!el) return;
        // Extra bottom padding to clear the canvas's bottom-left and
        // bottom-right dock bars (see FillPanel for the same constant).
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

    const noStrokeActive = strokeEnabled === false;
    const mixedWidth = strokeWidth === undefined;
    const sliderWidthValue = Math.min(STROKE_MAX, Math.max(STROKE_MIN, strokeWidth ?? STROKE_MIN));

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
                <Section title="Stroke">
                    <button
                        onClick={() => { cancelRevert(); if (noStrokeActive) onCommitStrokeOn(); else onCommitStrokeOff(); }}
                        onMouseEnter={() => { if (!noStrokeActive) { cancelRevert(); onPreviewStrokeOff(); } }}
                        onMouseLeave={() => { if (!noStrokeActive) scheduleRevert(); }}
                        className={cn(
                            'w-full text-[11px] font-medium py-1.5 rounded-md flex items-center justify-center gap-1.5 transition-all',
                            noStrokeActive
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
                        No stroke
                    </button>
                </Section>

                <Divider />

                {/* Recent — always mounted so growing from zero swatches to
                    one doesn't pop the panel taller mid-frame (ResizeObserver
                    re-snap caused a visible flicker). The grid-rows 0fr→1fr
                    trick is the standard "animate to height auto" approach
                    that works without measuring the section. */}
                <div
                    className="grid transition-[grid-template-rows] duration-200 ease-out"
                    style={{ gridTemplateRows: recentColors.length > 0 ? '1fr' : '0fr' }}
                    aria-hidden={recentColors.length === 0}
                >
                    <div className="overflow-hidden">
                        <Section title="Recent">
                            <ColorRow
                                colors={recentColors}
                                active={strokeEnabled === true ? strokeColor : undefined}
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
                        active={strokeEnabled === true ? strokeColor : undefined}
                        onPreview={(c) => { cancelRevert(); onPreviewColor(c); }}
                        onCommit={onCommitColor}
                        onLeave={scheduleRevert}
                        customPickSeed={strokeEnabled === true ? strokeColor : undefined}
                        onCustomCommit={onCommitColor}
                    />
                    {strokeEnabled === undefined && (
                        <div className="text-[10px] text-white/35 mt-1">Mixed</div>
                    )}
                </Section>

                <Divider />

                <Section title="Width">
                    <input
                        type="range"
                        min={STROKE_MIN}
                        max={STROKE_MAX}
                        step={1}
                        value={sliderWidthValue}
                        onChange={(e) => onPreviewWidth(Number(e.target.value))}
                        onPointerUp={(e) => onCommitWidth(Number((e.target as HTMLInputElement).value))}
                        onKeyUp={(e) => onCommitWidth(Number((e.target as HTMLInputElement).value))}
                        className={cn('w-full accent-emerald-500', mixedWidth && 'opacity-50')}
                    />
                    <div className="flex items-center justify-between mt-1">
                        <div className="text-[10px] text-white/50">
                            {mixedWidth ? 'Mixed' : `${Math.round(sliderWidthValue)}px`}
                        </div>
                        <div
                            style={{
                                width: 48,
                                height: Math.max(1, Math.min(12, sliderWidthValue)),
                                background: strokeColor ?? '#e8e8ed',
                                borderRadius: 2,
                                opacity: mixedWidth ? 0.4 : 1,
                            }}
                        />
                    </div>
                </Section>

                <Divider />

                <Section title="Line style">
                    <div className="flex gap-1" onMouseLeave={scheduleRevert}>
                        {(['solid', 'dashed', 'dotted'] as const).map(ls => {
                            const isActive = lineStyle === ls;
                            return (
                                <button
                                    key={ls}
                                    onMouseEnter={() => { cancelRevert(); onPreviewLineStyle(ls); }}
                                    onClick={() => { cancelRevert(); onCommitLineStyle(ls); }}
                                    className={cn(
                                        'flex-1 text-[10px] font-medium py-1.5 rounded-md transition-all',
                                        isActive
                                            ? 'bg-emerald-500/25 text-emerald-300'
                                            : 'bg-white/5 text-white/55 hover:bg-white/10',
                                    )}
                                >
                                    {ls}
                                </button>
                            );
                        })}
                    </div>
                    {lineStyle === undefined && (
                        <div className="text-[10px] text-white/35 mt-1">Mixed</div>
                    )}
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
