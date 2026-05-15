import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { fitToViewport } from '../CanvasEngine';

interface Props {
    open: boolean;
    onClose: () => void;
}

// Present selected items (or all items if none selected) in order, zooming
// smoothly to each one. Arrow keys navigate, Esc exits. Spec §20G.

export function PresentationMode({ open, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    const [idx, setIdx] = useState(0);

    // Slide POOL is captured once when presentation opens. Recomputing it
    // from selectedIds on every render is a bug: the per-slide effect
    // below dispatches SELECT [currentSlide.id] to highlight which item
    // is being focused, which would collapse a multi-selection down to
    // one — and the slide list with it (2/2 → 1/1 on the first slide).
    // Reading via a ref avoids making selectedIds an effect dependency,
    // so the capture genuinely happens once per open.
    const stateRef = useRef(state);
    stateRef.current = state;
    const [slideIds, setSlideIds] = useState<string[]>([]);

    useEffect(() => {
        if (!open) {
            setSlideIds([]);
            setIdx(0);
            return;
        }
        const cur = stateRef.current;
        const pool = cur.selectedIds.length > 0 ? cur.selectedIds : cur.order;
        setSlideIds([...pool]);
        setIdx(0);
    }, [open]);

    // Slides resolve from the captured ids against current items so
    // edits / moves during a presentation still update the focused frame.
    const slides = useMemo(() => {
        return slideIds.map(id => state.items[id]).filter(Boolean);
    }, [slideIds, state.items]);

    useEffect(() => {
        if (!open || slides.length === 0) return;
        const s = slides[Math.max(0, Math.min(idx, slides.length - 1))];
        if (!s) return;
        const view = fitToViewport(
            { x: s.x - 60, y: s.y - 60, w: s.w + 120, h: s.h + 120 },
            { w: window.innerWidth, h: window.innerHeight },
        );
        dispatch({ type: 'SET_VIEW', view });
        dispatch({ type: 'SELECT', ids: [s.id] });
    }, [open, idx, slides, dispatch]);

    useEffect(() => {
        if (!open) return;
        const h = (e: KeyboardEvent) => {
            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
                e.preventDefault();
                setIdx(i => Math.min(slides.length - 1, i + 1));
            } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                e.preventDefault();
                setIdx(i => Math.max(0, i - 1));
            } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [open, slides.length, onClose]);

    if (!open) return null;

    return (
        <div className="absolute inset-x-0 bottom-3 z-40 no-drag flex items-center justify-center pointer-events-none">
            <div data-canvas-ui="1" className="pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-full bg-black/70 border border-white/10 backdrop-blur-xl shadow-xl">
                <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0} className="p-1 rounded text-white/60 hover:text-white disabled:opacity-30"><ChevronLeft size={16} /></button>
                <span className="text-[11px] text-white/60 tabular-nums">{slides.length === 0 ? '—' : `${idx + 1} / ${slides.length}`}</span>
                <button onClick={() => setIdx(i => Math.min(slides.length - 1, i + 1))} disabled={idx === slides.length - 1} className="p-1 rounded text-white/60 hover:text-white disabled:opacity-30"><ChevronRight size={16} /></button>
                <span className="w-px h-4 bg-white/10" />
                <span className="text-[10px] uppercase tracking-widest text-emerald-300">presenting</span>
                <button onClick={onClose} className="p-1 rounded text-white/40 hover:text-white"><X size={13} /></button>
            </div>
        </div>
    );
}
