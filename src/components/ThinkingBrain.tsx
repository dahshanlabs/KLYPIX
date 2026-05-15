import { KlypixEyes } from './KlypixEyes';

/**
 * ThinkingBrain — Klypix eyes + animated lightbulb above.
 * Used as the smart-suggestions loading indicator.
 */
export function ThinkingBrain({ className = '' }: { className?: string }) {
    return (
        <div className={`flex flex-col items-center gap-0 shrink-0 ${className}`}>
            {/* Lightbulb above eyes */}
            <div className="relative w-[14px] h-[14px] mb-[-2px]" style={{ animation: 'bulbFloat 2.5s ease-in-out infinite' }}>
                {/* Glow aura */}
                <div className="absolute inset-[-4px] rounded-full"
                    style={{
                        background: 'radial-gradient(circle, rgba(255,217,61,0.4) 0%, rgba(255,217,61,0) 70%)',
                        animation: 'bulbPulse 2s ease-in-out infinite',
                    }} />
                {/* Bulb body */}
                <div className="absolute top-[1px] left-[2px] w-[10px] h-[10px] rounded-full bg-[#FFD93D]" />
                {/* Bulb base */}
                <div className="absolute bottom-[0px] left-[4px] w-[6px] h-[3px] rounded-b-[2px] bg-[#E6C235]" />
                {/* Highlight */}
                <div className="absolute top-[2.5px] left-[4px] w-[3px] h-[3px] rounded-full bg-[#FFF8DC] opacity-70" />
            </div>

            {/* Eyes */}
            <KlypixEyes size={18} />

            <style>{`
                @keyframes bulbPulse {
                    0%, 100% { opacity: 0.5; transform: scale(1); }
                    50% { opacity: 1; transform: scale(1.3); }
                }
                @keyframes bulbFloat {
                    0%, 100% { transform: translateY(0px); }
                    50% { transform: translateY(-1.5px); }
                }
                @keyframes klypixTextFade {
                    0%, 100% { opacity: 0.5; }
                    50% { opacity: 1; }
                }
                @keyframes suggestFadeIn {
                    0% { opacity: 0; transform: translateY(4px) scale(0.95); }
                    100% { opacity: 1; transform: translateY(0) scale(1); }
                }
            `}</style>
        </div>
    );
}
