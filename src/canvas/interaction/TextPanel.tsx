import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, Strikethrough, ChevronDown } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AlignmentGrid, type TextAlignH, type TextAlignV } from './AlignmentGrid';
import { CustomColorPick } from './CustomColorPick';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Text-only style panel — surfaced when at least one text item is
// selected. Controls: Font family dropdown, Size slider, Bold / Italic
// / Underline toggles, Text color (recents + palette), Alignment grid
// (reused from the context menu). Fill / stroke have their own panels.

export const PALETTE_COLORS = ['#10b981', '#e8e8ed', '#0a0a0f', '#f5a623', '#ef4444', '#3b82f6', '#a855f7'];
export const FONT_OPTIONS: { label: string; value: string }[] = [
    { label: 'Virgil', value: 'Virgil' },          // canvas default — handwritten / sketch style (Excalidraw's font)
    { label: 'Outfit', value: 'Outfit' },          // legacy default — kept so files saved before Virgil still map cleanly
    { label: 'Inter', value: 'Inter' },
    { label: 'Space Grotesk', value: 'Space Grotesk' },
    { label: 'Newsreader', value: 'Newsreader' },
    { label: 'JetBrains Mono', value: 'JetBrains Mono' },
    { label: 'Caveat', value: 'Caveat' },
    { label: 'Bricolage Grotesque', value: 'Bricolage Grotesque' },
];
const SIZE_MIN = 8;
const SIZE_MAX = 128;
const REVERT_DELAY_MS = 40;

interface Props {
    fontFamily: string | undefined;
    fontSize: number | undefined;
    bold: boolean | undefined;
    italic: boolean | undefined;
    underline: boolean | undefined;
    strikethrough: boolean | undefined;
    color: string | undefined;
    textAlign: TextAlignH | undefined;
    verticalAlign: TextAlignV | undefined;
    recentColors: string[];

    onPreviewFont: (f: string) => void;
    onCommitFont: (f: string) => void;
    onPreviewSize: (s: number) => void;
    onCommitSize: (s: number) => void;
    onCommitBold: (on: boolean) => void;
    onCommitItalic: (on: boolean) => void;
    onCommitUnderline: (on: boolean) => void;
    onCommitStrikethrough: (on: boolean) => void;
    onPreviewColor: (c: string) => void;
    onCommitColor: (c: string) => void;
    onCommitAlignment: (h: TextAlignH, v: TextAlignV) => void;

    onRevertPreview: () => void;
}

export const TextPanel = React.forwardRef<HTMLDivElement, Props>(function TextPanel(props, ref) {
    const {
        fontFamily, fontSize, bold, italic, underline, strikethrough, color,
        textAlign, verticalAlign, recentColors,
        onPreviewFont, onCommitFont,
        onPreviewSize, onCommitSize,
        onCommitBold, onCommitItalic, onCommitUnderline, onCommitStrikethrough,
        onPreviewColor, onCommitColor,
        onCommitAlignment,
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

    const [fontMenuOpen, setFontMenuOpen] = useState(false);
    const fontMenuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!fontMenuOpen) return;
        const handler = (e: PointerEvent) => {
            if (fontMenuRef.current && fontMenuRef.current.contains(e.target as Node)) return;
            setFontMenuOpen(false);
        };
        const t = setTimeout(() => window.addEventListener('pointerdown', handler), 0);
        return () => { clearTimeout(t); window.removeEventListener('pointerdown', handler); };
    }, [fontMenuOpen]);

    const mixedSize = fontSize === undefined;
    const sliderSize = Math.min(SIZE_MAX, Math.max(SIZE_MIN, fontSize ?? 16));

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
                <Section title="Font">
                    <div className="relative" ref={fontMenuRef}>
                        <button
                            onClick={() => setFontMenuOpen(v => !v)}
                            className="w-full flex items-center justify-between gap-2 bg-white/5 hover:bg-white/10 rounded px-2 py-1.5 text-[11px] text-white/85 transition-all"
                            style={{ fontFamily: fontFamily ? `"${fontFamily}", sans-serif` : undefined }}
                        >
                            <span>{fontFamily ?? 'Mixed'}</span>
                            <ChevronDown size={12} className="text-white/40 shrink-0" />
                        </button>
                        {fontMenuOpen && (
                            <div
                                className="absolute left-0 right-0 top-full mt-1 z-40 rounded-md bg-[#0d0d14] border border-white/10 shadow-lg max-h-64 overflow-y-auto"
                                onWheel={(e) => e.stopPropagation()}
                            >
                                {FONT_OPTIONS.map(f => (
                                    <button
                                        key={f.value}
                                        onMouseEnter={() => { cancelRevert(); onPreviewFont(f.value); }}
                                        onMouseLeave={scheduleRevert}
                                        onClick={() => { cancelRevert(); onCommitFont(f.value); setFontMenuOpen(false); }}
                                        className={cn(
                                            'w-full text-left px-3 py-1.5 text-[12px] transition-all',
                                            fontFamily === f.value
                                                ? 'bg-emerald-500/20 text-emerald-300'
                                                : 'text-white/75 hover:bg-white/10',
                                        )}
                                        style={{ fontFamily: `"${f.value}", sans-serif` }}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </Section>

                <Divider />

                <Section title="Size">
                    <input
                        type="range"
                        min={SIZE_MIN}
                        max={SIZE_MAX}
                        step={1}
                        value={sliderSize}
                        onChange={(e) => onPreviewSize(Number(e.target.value))}
                        onPointerUp={(e) => onCommitSize(Number((e.target as HTMLInputElement).value))}
                        onKeyUp={(e) => onCommitSize(Number((e.target as HTMLInputElement).value))}
                        className={cn('w-full accent-emerald-500', mixedSize && 'opacity-50')}
                    />
                    <div className="text-[10px] text-white/50 text-right mt-1">
                        {mixedSize ? 'Mixed' : `${Math.round(sliderSize)}px`}
                    </div>
                </Section>

                <Divider />

                <Section title="Style">
                    <div className="flex gap-1">
                        <ToggleButton
                            active={bold === true}
                            mixed={bold === undefined}
                            onClick={() => onCommitBold(!(bold === true))}
                            title="Bold"
                        ><Bold size={12} /></ToggleButton>
                        <ToggleButton
                            active={italic === true}
                            mixed={italic === undefined}
                            onClick={() => onCommitItalic(!(italic === true))}
                            title="Italic"
                        ><Italic size={12} /></ToggleButton>
                        <ToggleButton
                            active={underline === true}
                            mixed={underline === undefined}
                            onClick={() => onCommitUnderline(!(underline === true))}
                            title="Underline"
                        ><Underline size={12} /></ToggleButton>
                        <ToggleButton
                            active={strikethrough === true}
                            mixed={strikethrough === undefined}
                            onClick={() => onCommitStrikethrough(!(strikethrough === true))}
                            title="Strikethrough"
                        ><Strikethrough size={12} /></ToggleButton>
                    </div>
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
                                active={color}
                                onPreview={(c) => { cancelRevert(); onPreviewColor(c); }}
                                onCommit={onCommitColor}
                                onLeave={scheduleRevert}
                            />
                        </Section>
                        <Divider />
                    </div>
                </div>

                <Section title="Color">
                    <ColorRow
                        colors={PALETTE_COLORS}
                        active={color}
                        onPreview={(c) => { cancelRevert(); onPreviewColor(c); }}
                        onCommit={onCommitColor}
                        onLeave={scheduleRevert}
                        customPickSeed={color}
                        onCustomCommit={onCommitColor}
                    />
                    {color === undefined && (
                        <div className="text-[10px] text-white/35 mt-1">Mixed</div>
                    )}
                </Section>

                <Divider />

                <Section title="Alignment">
                    <AlignmentGrid
                        currentH={textAlign ?? 'left'}
                        currentV={verticalAlign ?? 'top'}
                        onChange={onCommitAlignment}
                    />
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

function ToggleButton({ active, mixed, onClick, title, children }: { active: boolean; mixed?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            title={title + (mixed ? ' (mixed)' : '')}
            className={cn(
                'flex-1 flex items-center justify-center py-1.5 rounded-md transition-all cursor-pointer',
                active
                    ? 'bg-emerald-500/25 text-emerald-300'
                    : mixed
                        ? 'bg-white/5 text-white/35'
                        : 'bg-white/5 text-white/55 hover:bg-white/10 hover:text-white',
            )}
        >
            {children}
        </button>
    );
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
