import { useState, useEffect, useRef } from 'react';
import { KlypixEyes } from './KlypixEyes';
import { t } from '../i18n/strings';

/**
 * RespondingKlypix — Klypix eyes + animated pencil accessory + rotating fun phrases.
 * Shown while the AI is generating/streaming a response.
 *
 * Phrase counts per mode are encoded here so the pool length is known
 * statically; the strings themselves live in i18n under
 * `responding.<mode>.<n>` keys so they switch with the active locale.
 */

const PHRASE_COUNTS = { chat: 8, document: 6, screen: 5 } as const;

type Mode = keyof typeof PHRASE_COUNTS;

export function RespondingKlypix({ mode = 'chat', className = '' }: { mode?: Mode; className?: string }) {
    const count = PHRASE_COUNTS[mode];
    const [idx, setIdx] = useState(() => Math.floor(Math.random() * count));
    const [fading, setFading] = useState(false);
    const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

    useEffect(() => {
        timerRef.current = setInterval(() => {
            setFading(true);
            setTimeout(() => {
                setIdx(prev => (prev + 1) % count);
                setFading(false);
            }, 400); // fade-out duration before swap
        }, 3500);
        return () => clearInterval(timerRef.current);
    }, [count]);

    return (
        <div className={`flex items-center gap-3 py-2 ${className}`}>
            {/* Eyes + pencil accessory */}
            <div className="relative shrink-0">
                <KlypixEyes size={18} />
                {/* Pencil — bottom-right of eyes */}
                <div className="absolute -bottom-[3px] -right-[6px]"
                    style={{ animation: 'pencilWrite 1.8s ease-in-out infinite' }}>
                    {/* Pencil body */}
                    <div className="relative" style={{ width: 12, height: 4, transform: 'rotate(-35deg)' }}>
                        {/* Wood/body */}
                        <div className="absolute inset-0 rounded-[1px] bg-[#FFD93D]" />
                        {/* Tip */}
                        <div className="absolute left-[-3px] top-[0.5px] w-0 h-0"
                            style={{
                                borderTop: '1.5px solid transparent',
                                borderBottom: '1.5px solid transparent',
                                borderRight: '4px solid #B8A08A',
                            }} />
                        {/* Eraser */}
                        <div className="absolute right-0 top-0 w-[3px] h-full rounded-r-[1px] bg-[#FF6B9D]" />
                    </div>
                </div>
            </div>

            {/* Rotating text */}
            <div className="flex flex-col gap-0.5 min-w-0">
                <span className={`text-[13px] text-emerald-400/80 font-medium tracking-wide font-poppins transition-opacity duration-400 ${fading ? 'opacity-0' : 'opacity-100'}`}
                    style={{ animation: fading ? 'none' : 'klypixTextFade 2.8s ease-in-out infinite' }}>
                    {t(`responding.${mode}.${idx}` as any)}
                </span>
                <span className="text-[10px] text-white/25 uppercase tracking-[0.15em] font-poppins">{t('responding.klypix_responding')}</span>
            </div>

            <style>{`
                @keyframes pencilWrite {
                    0%, 100% { transform: rotate(0deg) translateY(0); }
                    25% { transform: rotate(3deg) translateY(-0.5px); }
                    50% { transform: rotate(-2deg) translateY(0.5px); }
                    75% { transform: rotate(4deg) translateY(-0.3px); }
                }
                @keyframes klypixTextFade {
                    0%, 100% { opacity: 0.5; }
                    50% { opacity: 1; }
                }
            `}</style>
        </div>
    );
}
