import React, { useLayoutEffect, useRef, useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Multiplier presets. 1× is intentionally absent — clicking "scale by 1"
// is a no-op. Each click is a relative multiplier applied around the
// selection's bounding-box center.
const PRESETS: { label: string; factor: number }[] = [
    { label: '0.25×', factor: 0.25 },
    { label: '0.5×', factor: 0.5 },
    { label: '0.75×', factor: 0.75 },
    { label: '1.5×', factor: 1.5 },
    { label: '2×', factor: 2 },
    { label: '3×', factor: 3 },
];

interface Props {
    hasSelection: boolean;
    onApply: (factor: number) => void;
}

export const ScalePanel = React.forwardRef<HTMLDivElement, Props>(function ScalePanel({ hasSelection, onApply }, ref) {
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

    const [customText, setCustomText] = useState('');
    const customNum = (() => {
        const n = parseFloat(customText);
        if (!isFinite(n) || n <= 0) return null;
        return n;
    })();

    const apply = (f: number) => {
        if (!hasSelection) return;
        onApply(f);
    };

    const submitCustom = () => {
        if (customNum == null) return;
        apply(customNum);
    };

    return (
        <div
            ref={setRefs}
            data-canvas-ui="1"
            onWheel={(e) => e.stopPropagation()}
            className="absolute left-full ml-2 z-30 w-56 rounded-xl bg-[#12121a] border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
            style={{
                top: topOffset,
                maxHeight,
                overflowY: maxHeight != null ? 'auto' : 'hidden',
                visibility: measured ? 'visible' : 'hidden',
            }}
        >
            <div className="flex flex-col">
                <div className="px-3 py-2.5">
                    <div className="text-[10px] text-white/40 uppercase tracking-widest mb-1.5">Scale</div>
                    {!hasSelection && (
                        <div className="text-[10px] text-white/35 mb-2">Select something first.</div>
                    )}
                    <div className="grid grid-cols-3 gap-1">
                        {PRESETS.map(p => (
                            <button
                                key={p.label}
                                onClick={() => apply(p.factor)}
                                disabled={!hasSelection}
                                className={cn(
                                    'text-[11px] font-medium py-1.5 rounded-md transition-all',
                                    hasSelection
                                        ? 'bg-white/5 text-white/65 hover:bg-emerald-500/20 hover:text-emerald-300'
                                        : 'bg-white/5 text-white/25 cursor-not-allowed',
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="h-px bg-white/5" />

                <div className="px-3 py-2.5">
                    <div className="text-[10px] text-white/40 uppercase tracking-widest mb-1.5">Custom</div>
                    <div className="flex items-center gap-1.5">
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="e.g. 1.25"
                            value={customText}
                            onChange={(e) => setCustomText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    submitCustom();
                                }
                            }}
                            className="flex-1 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[12px] text-white/85 placeholder-white/25 focus:outline-none focus:border-emerald-500/40"
                        />
                        <span className="text-[11px] text-white/40">×</span>
                        <button
                            onClick={submitCustom}
                            disabled={!hasSelection || customNum == null}
                            className={cn(
                                'text-[11px] font-medium px-2 py-1 rounded-md transition-all',
                                hasSelection && customNum != null
                                    ? 'bg-emerald-500/25 text-emerald-300 hover:bg-emerald-500/35'
                                    : 'bg-white/5 text-white/25 cursor-not-allowed',
                            )}
                        >
                            Apply
                        </button>
                    </div>
                    <div className="text-[10px] text-white/35 mt-1.5">
                        Each apply multiplies. Center stays the selection's center.
                    </div>
                </div>
            </div>
        </div>
    );
});
