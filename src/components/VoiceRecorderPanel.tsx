// Floating recorder panel shared by Chat and Canvas mics. Renders a
// scrolling time-history waveform driven by live mic amplitude, an
// elapsed timer, and a prominent red stop button — Wispr Flow-style.
//
// Mounted via React portal to document.body and positioned with `fixed`
// relative to a caller-supplied anchor rect. This bypasses every
// `overflow: hidden` ancestor the caller might sit inside (the input
// header, the chat scroll container, etc.) — previously the panel's
// waveform was getting clipped at the top because some intermediate
// ancestor had overflow-hidden and the absolute panel inherited that
// clip box.
//
// Stays a "dumb" presentational component: the parent owns the recorder
// lifecycle and feeds `level` (0..1) each animation frame plus `status`
// transitions. The panel keeps no audio state of its own.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Square } from 'lucide-react';
import { t, useLocale } from '../i18n/strings';

export interface VoiceRecorderPanelProps {
    /** Current amplitude, 0..1. Drives the rightmost bar; older samples scroll left. */
    level: number;
    /** Lifecycle phase. `recording` runs the waveform + timer; `transcribing` freezes
     *  the wave and shows a spinner label; `done`/'error' should unmount the panel. */
    status: 'recording' | 'transcribing';
    /** Optional interim transcript text. When unset, the panel shows a "Listening…"
     *  pulse with the elapsed timer instead. */
    interimText?: string;
    /** Stop button click. Parent should call `recorder.stop()`. */
    onStop: () => void;
    /**
     * Where to anchor the panel. Provide an `anchorRef` to a button or container
     * whose bottom-center the panel should hang under (the panel sits ~8px below
     * it, horizontally centered on its midpoint). If `anchorRef.current` is null
     * the panel falls back to bottom-center of the viewport.
     *
     * Pass `position="above"` to flip it ABOVE the anchor instead (used by the
     * canvas FAB so the recorder doesn't overlap the bottom-edge HUD).
     */
    anchorRef?: React.RefObject<HTMLElement | null>;
    position?: 'below' | 'above';
    /** Visual theme. Chat omits it (the overlay is always dark); the canvas
     *  passes the binary decision derived from its background luminance. The
     *  panel stays presentational — it only needs the dark/light verdict, not
     *  the raw color. */
    appearance?: 'dark' | 'light';
}

// Panel surface per theme. Dark uses a faint emerald hairline (was white/10)
// to tie the panel to the emerald mic FAB; reads fine on the dark chat
// overlay. Light is a warm paper-tinted glass that sits on the cream canvas
// instead of slamming a black slab over it. Non-standard alphas bracketed.
const PANEL_DARK = 'no-drag bg-[#0e0e14]/95 backdrop-blur-xl border border-emerald-400/[0.18] rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.5)] px-3 pt-2 pb-2 w-[220px] flex flex-col items-center gap-1.5 animate-in fade-in zoom-in-95 duration-150';
const PANEL_LIGHT = 'no-drag bg-[#fbf8f2]/95 backdrop-blur-xl border border-emerald-600/30 rounded-2xl shadow-[0_10px_30px_rgba(20,40,30,0.18)] px-3 pt-2 pb-2 w-[220px] flex flex-col items-center gap-1.5 animate-in fade-in zoom-in-95 duration-150';

// Bar count chosen to fill the compact panel's inner width: panel is now
// 220px wide with px-3 (24px) padding → ~196px inner. Each bar is 2px
// wide with a 1.5px gap, so 56 bars + gaps ≈ 196px.
const BAR_COUNT = 56;
const SAMPLE_INTERVAL_MS = 40; // 25 Hz — fast enough to feel reactive, slow enough to scroll readably
const PANEL_HEIGHT = 110;       // approximate rendered height; used by useAnchorCoords for `position="above"`

export function VoiceRecorderPanel({ level, status, interimText, onStop, anchorRef, position = 'below', appearance = 'dark' }: VoiceRecorderPanelProps) {
    const history = useScrollingWaveform(level, status === 'recording');
    const elapsed = useElapsedSeconds(status === 'recording');
    const coords = useAnchorCoords(anchorRef, position);
    // Subscribe to locale so the panel re-renders when language toggles.
    const [locale] = useLocale();
    const isRtl = locale === 'ar';
    const light = appearance === 'light';

    const panel = (
        <div
            // Fixed positioning sidesteps every overflow-hidden ancestor.
            // `.no-drag` is required because the Electron renderer treats
            // un-marked regions as drag regions when overlaying frameless
            // areas — without it, clicks on the stop button become window
            // drag intents and never reach React.
            className="no-drag"
            style={{
                position: 'fixed',
                left: coords.left,
                top: coords.top,
                transform: 'translateX(-50%)',
                zIndex: 9999,
            }}
            dir={isRtl ? 'rtl' : 'ltr'}
        >
            <div
                className={light ? PANEL_LIGHT : PANEL_DARK}
                role="dialog"
                aria-label={t('chat.voice_stop')}
            >
                {/* Scrolling waveform. Bar positions are fixed — what changes
                    is each bar's HEIGHT as the ring buffer shifts new samples
                    in from the right and the oldest sample drops off the
                    left. Visually this still reads as "scrolling left."
                    `justify-center` keeps the bar group centered in the box.
                    No `overflow-hidden` — bars are capped at 28px inside
                    h-9 (36px) with `items-center` so they never exceed the
                    container. */}
                <div className="w-full h-9 flex items-center justify-center gap-[1.5px]">
                    {history.map((v, i) => {
                        const h = Math.max(2, Math.min(28, v * 28));
                        return (
                            <span
                                key={i}
                                className={`w-[2px] rounded-full ${light ? 'bg-emerald-600' : 'bg-emerald-400'}`}
                                style={{
                                    height: `${h}px`,
                                    opacity: 0.35 + Math.min(1, v) * 0.55,
                                    transition: 'height 60ms linear, opacity 60ms linear',
                                }}
                            />
                        );
                    })}
                </div>

                {/* Status / interim transcript line. Fixed min-height so the
                    panel doesn't jump when the transcript appears. */}
                <div className="w-full min-h-[16px] text-center text-[11px] leading-tight px-1">
                    {status === 'recording' ? (
                        interimText ? (
                            <span className={`${light ? 'text-emerald-900/85' : 'text-white/85'} line-clamp-2`}>{interimText}</span>
                        ) : (
                            <span className={`${light ? 'text-emerald-900/65' : 'text-white/55'} italic inline-flex items-center justify-center gap-1.5`}>
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                                {t('chat.voice_listening')} {formatTime(elapsed)}
                            </span>
                        )
                    ) : (
                        <span className={`${light ? 'text-emerald-700' : 'text-emerald-300/85'} italic`}>{t('chat.voice_transcribing')}</span>
                    )}
                </div>

                {/* Stop button — uses onPointerDown not onClick. In some
                    Electron + portal + transparent-window scenarios the
                    synthetic onClick chain doesn't fire reliably; pointerdown
                    is dispatched earlier in the event lifecycle and is the
                    most direct way to capture the user's intent. Static glow
                    instead of `animate-ping` to avoid any chance of the
                    growing halo (even with pointer-events-none) interfering
                    with hit-testing in Chromium. */}
                <button
                    onPointerDown={(e) => {
                        if (status !== 'recording') return;
                        e.preventDefault();
                        e.stopPropagation();
                        onStop();
                    }}
                    disabled={status !== 'recording'}
                    title={t('chat.voice_stop')}
                    aria-label={t('chat.voice_stop')}
                    className="relative w-9 h-9 rounded-full bg-red-500 hover:bg-red-400 active:scale-95 transition-all flex items-center justify-center shadow-[0_4px_14px_rgba(239,68,68,0.55)] ring-2 ring-red-500/30 disabled:opacity-60 disabled:cursor-wait disabled:bg-red-500/70 cursor-pointer"
                >
                    <Square size={11} className="text-white fill-white" />
                </button>
            </div>
        </div>
    );

    return createPortal(panel, document.body);
}

/** Pushes the current `level` into a fixed-length ring buffer every 40ms.
 *  Reads `level` through a ref so re-renders don't reset the interval. */
function useScrollingWaveform(level: number, active: boolean): number[] {
    const [history, setHistory] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
    const levelRef = useRef(level);
    levelRef.current = level;

    useEffect(() => {
        if (!active) {
            setHistory(new Array(BAR_COUNT).fill(0));
            return;
        }
        const id = window.setInterval(() => {
            setHistory(prev => {
                const next = prev.slice(1);
                next.push(levelRef.current);
                return next;
            });
        }, SAMPLE_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [active]);

    return history;
}

function useElapsedSeconds(active: boolean): number {
    const [n, setN] = useState(0);
    useEffect(() => {
        if (!active) { setN(0); return; }
        const start = Date.now();
        setN(0);
        const id = window.setInterval(
            () => setN(Math.floor((Date.now() - start) / 1000)),
            500,
        );
        return () => window.clearInterval(id);
    }, [active]);
    return n;
}

function formatTime(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/** Tracks the anchor element's screen rect and returns the {left, top} screen
 *  coords where the panel's top-center should sit. Re-measures on window
 *  resize and on every animation frame while the panel is mounted (cheap,
 *  ~250 reads/s) so the panel follows the anchor through autosize / scroll
 *  transitions without lag. */
function useAnchorCoords(
    anchorRef: React.RefObject<HTMLElement | null> | undefined,
    position: 'below' | 'above',
): { left: number; top: number } {
    const [coords, setCoords] = useState(() => ({
        left: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
        top: typeof window !== 'undefined' ? window.innerHeight - 200 : 0,
    }));

    useLayoutEffect(() => {
        let raf = 0;
        const measure = () => {
            const el = anchorRef?.current ?? null;
            // Half the panel's rendered width — used to clamp `left` so the
            // 220px panel can't slip off either viewport edge when the anchor
            // sits near a corner. 8px gutter keeps it visually breathing.
            const halfPanel = 110;
            const gutter = 8;
            if (el) {
                const r = el.getBoundingClientRect();
                const rawLeft = r.left + r.width / 2;
                const minLeft = halfPanel + gutter;
                const maxLeft = window.innerWidth - halfPanel - gutter;
                const left = Math.max(minLeft, Math.min(maxLeft, rawLeft));
                // Panel's own height varies slightly; we hang it 8px off the
                // anchor edge. For 'above', shift up by the approximate
                // rendered height so the panel's BOTTOM (not top) sits 8px
                // above the anchor.
                const top = position === 'below' ? r.bottom + 8 : r.top - 8 - PANEL_HEIGHT;
                setCoords({ left, top });
            } else {
                setCoords({
                    left: window.innerWidth / 2,
                    top: window.innerHeight - 200,
                });
            }
            raf = window.requestAnimationFrame(measure);
        };
        measure();
        return () => window.cancelAnimationFrame(raf);
    }, [anchorRef, position]);

    return coords;
}
