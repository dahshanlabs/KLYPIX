import { useEffect, useRef, useState } from 'react';

// KLYPIX Eyes — a small floating presence in the bottom-left of the canvas.
// State-driven animations per spec §22F: idle, thinking, reading, working,
// success, error, waiting, sleeping. Pupils track the mouse cursor gently
// (not 1:1 — slight lag, max 4px offset). Sleeps after 30s idle.

export type EyesState = 'idle' | 'thinking' | 'reading' | 'working' | 'success' | 'error' | 'waiting' | 'sleeping';

interface Props {
    state: EyesState;
    /** Optional one-line speech bubble (autofades after ~3s if provided). */
    message?: string | null;
}

const IDLE_SLEEP_MS = 30_000;

export function CanvasEyes({ state: externalState, message }: Props) {
    const [actualState, setActualState] = useState<EyesState>(externalState);
    const [pupil, setPupil] = useState({ x: 0, y: 0 });
    const [bubble, setBubble] = useState<string | null>(message || null);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const eyesRef = useRef<HTMLDivElement>(null);

    // External state always wins. When it returns to 'idle' we start the sleep timer.
    useEffect(() => {
        setActualState(externalState);
        if (idleTimer.current) clearTimeout(idleTimer.current);
        if (externalState === 'idle') {
            idleTimer.current = setTimeout(() => setActualState('sleeping'), IDLE_SLEEP_MS);
        }
    }, [externalState]);

    // Speech bubble: accept new messages, auto-dismiss.
    useEffect(() => {
        if (!message) return;
        setBubble(message);
        const t = setTimeout(() => setBubble(null), 3000);
        return () => clearTimeout(t);
    }, [message]);

    // Mouse tracking for pupil direction.
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const el = eyesRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const dx = e.clientX - cx;
            const dy = e.clientY - cy;
            const len = Math.hypot(dx, dy);
            const MAX = 3.5;
            if (len === 0) return setPupil({ x: 0, y: 0 });
            const scale = Math.min(1, len / 200);
            setPupil({ x: (dx / len) * MAX * scale, y: (dy / len) * MAX * scale });
        };
        window.addEventListener('mousemove', handler, { passive: true });
        return () => window.removeEventListener('mousemove', handler);
    }, []);

    const sleeping = actualState === 'sleeping';
    const thinking = actualState === 'thinking';
    const working = actualState === 'working';
    const success = actualState === 'success';
    const error = actualState === 'error';
    const waiting = actualState === 'waiting';

    // Eyelid height (0 = fully open, 1 = fully closed).
    const topLid =
        sleeping ? 0.5 :
        success ? 0.6 :
        error ? 0 :
        waiting ? 0.25 :
        0;
    const bottomLid =
        sleeping ? 0.5 :
        success ? 0.35 :
        waiting ? 0.25 :
        0;

    const eyeTint = error ? '#ef4444' : sleeping ? '#6b6b80' : '#e8e8ed';
    const opacity = sleeping ? 0.55 : 1;

    return (
        <div
            className="absolute bottom-16 left-3 z-20 no-drag pointer-events-none select-none"
            style={{ width: 72, height: 72, opacity, transition: 'opacity 0.3s ease' }}
        >
            {bubble && (
                <div
                    className="absolute -top-9 left-14 whitespace-nowrap px-3 py-1.5 rounded-xl bg-[#12121a] border border-white/10 text-[11px] text-white/80 animate-in fade-in slide-in-from-bottom-1 duration-200 shadow-lg"
                    style={{ pointerEvents: 'auto' }}
                >
                    {bubble}
                </div>
            )}
            <div ref={eyesRef} className="relative w-full h-full flex items-center justify-center gap-1">
                <Eye pupil={pupil} topLid={topLid} bottomLid={bottomLid} tint={eyeTint} spinning={thinking || working} />
                <Eye pupil={pupil} topLid={topLid} bottomLid={bottomLid} tint={eyeTint} spinning={thinking || working} mirror />
            </div>
            {(thinking || working) && (
                <div
                    className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-[2px] w-14 rounded-full overflow-hidden bg-emerald-500/15"
                >
                    <div className="h-full bg-emerald-400 animate-pulse" style={{ width: '60%' }} />
                </div>
            )}
        </div>
    );
}

interface EyeProps {
    pupil: { x: number; y: number };
    topLid: number;
    bottomLid: number;
    tint: string;
    spinning?: boolean;
    mirror?: boolean;
}

// Match the main-app KlypixEyes visual: rounded-square white frame with dark
// border, blue iris with dark pupil and a tiny highlight. State-driven bits
// from the canvas version stay (pupil tracks cursor via translate, lids
// animate for sleep/success/error/waiting, iris spins while thinking/working,
// red tint on error).
const EYE_SIZE = 18;
const FRAME_COLOR = '#1a2744';
const IRIS_COLOR = '#4a8fbf';
const PUPIL_COLOR = '#1a2744';
const LID_COLOR = '#0a2417';

function Eye({ pupil, topLid, bottomLid, tint, spinning, mirror }: EyeProps) {
    const isErrorTint = tint === '#ef4444';
    const isSleepTint = tint === '#6b6b80';
    // Iris adopts the current tint for error/sleep; otherwise the signature blue.
    const iris = isErrorTint || isSleepTint ? tint : IRIS_COLOR;
    const pupilCol = isErrorTint || isSleepTint ? '#000' : PUPIL_COLOR;

    return (
        <div
            className="relative"
            style={{
                width: EYE_SIZE,
                height: EYE_SIZE,
                borderRadius: 6,
                background: '#fff',
                border: `1.5px solid ${FRAME_COLOR}`,
                overflow: 'hidden',
                transition: 'background 0.3s ease, border-color 0.3s ease',
            }}
        >
            {/* Iris + pupil group — tracks the cursor via translate. Spinning
                (thinking/working) rotates the iris disc in place. */}
            <div
                className={spinning ? 'animate-spin' : ''}
                style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 12,
                    height: 12,
                    marginLeft: -6,
                    marginTop: -6,
                    borderRadius: '50%',
                    background: iris,
                    transform: `translate(${(mirror ? -1 : 1) * pupil.x}px, ${pupil.y}px)`,
                    transition: 'transform 0.15s ease-out, background 0.3s ease',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        width: 5,
                        height: 5,
                        marginLeft: -2.5,
                        marginTop: -2.5,
                        borderRadius: '50%',
                        background: pupilCol,
                        transition: 'background 0.3s ease',
                    }}
                />
                {/* Highlight — a tiny white dot, upper-left of the pupil. */}
                <div
                    style={{
                        position: 'absolute',
                        left: 2,
                        top: 1.5,
                        width: 2.5,
                        height: 2.5,
                        borderRadius: '50%',
                        background: '#fff',
                        opacity: isSleepTint ? 0 : 0.9,
                        transition: 'opacity 0.3s ease',
                    }}
                />
            </div>
            {/* Top / bottom eyelids for blink / sleep / squint. */}
            {topLid > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: `${topLid * 100}%`,
                        background: LID_COLOR,
                        borderBottomLeftRadius: 4,
                        borderBottomRightRadius: 4,
                        transition: 'height 0.2s ease',
                    }}
                />
            )}
            {bottomLid > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: `${bottomLid * 100}%`,
                        background: LID_COLOR,
                        borderTopLeftRadius: 4,
                        borderTopRightRadius: 4,
                        transition: 'height 0.2s ease',
                    }}
                />
            )}
        </div>
    );
}
