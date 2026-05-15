/**
 * KlypixEyes — Shared cartoon eyes component used across the Klypix character system.
 * Renders the signature rounded-square eye frames with animated iris, blink, and bounce.
 *
 * size={18} — compact (suggestions bar, responding indicator)
 * size={24} — standard (ON SCREEN skeleton card)
 */

const dims = {
    18: { w: 18, gap: 2, r: 6, border: 1.5, iris: 9, irisOff: 3, pupil: 4, pupilOff: 2.5, hl: 2, hlTop: 1, hlLeft: 1.5, blidR: 4, lookScale: 0.75 },
    24: { w: 24, gap: 3, r: 8, border: 2, iris: 12, irisOff: 4, pupil: 5, pupilOff: 3.5, hl: 3, hlTop: 1.5, hlLeft: 2, blidR: 6, lookScale: 1 },
} as const;

type EyeSize = keyof typeof dims;

export function KlypixEyes({ size = 18, className = '' }: { size?: EyeSize; className?: string }) {
    const d = dims[size];
    const lookId = `eyesLook_${size}`;
    const blinkId = `eyesBlink_${size}`;
    const bounceId = `eyesBounce_${size}`;

    // Scale the look-around translate values based on size
    const s = d.lookScale;

    const eye = (
        <div className="relative" style={{ width: d.w, height: d.w }}>
            <div className="absolute inset-0 overflow-hidden"
                style={{ borderRadius: d.r, background: '#fff', border: `${d.border}px solid #1a2744` }}>
                {/* Iris + Pupil group */}
                <div className="absolute" style={{ animation: `${lookId} 4s cubic-bezier(0.4, 0, 0.2, 1) infinite` }}>
                    <div className="rounded-full bg-[#4a8fbf] absolute"
                        style={{ width: d.iris, height: d.iris, top: d.irisOff, left: d.irisOff }}>
                        <div className="rounded-full bg-[#1a2744] absolute"
                            style={{ width: d.pupil, height: d.pupil, top: d.pupilOff, left: d.pupilOff }} />
                        <div className="rounded-full bg-white absolute opacity-90"
                            style={{ width: d.hl, height: d.hl, top: d.hlTop, left: d.hlLeft }} />
                    </div>
                </div>
                {/* Blink eyelid */}
                <div className="absolute inset-x-0 top-0 bg-[#0a2417]"
                    style={{ borderBottomLeftRadius: d.blidR, borderBottomRightRadius: d.blidR, animation: `${blinkId} 4s ease-in-out infinite` }} />
            </div>
        </div>
    );

    return (
        <div className={`flex-shrink-0 ${className}`}>
            <div className="flex" style={{ gap: d.gap, animation: `${bounceId} 4s ease-in-out infinite` }}>
                {eye}
                {eye}
            </div>

            <style>{`
                @keyframes ${lookId} {
                    0%, 8%   { transform: translate(0px, 0px); }
                    12%, 22% { transform: translate(${5 * s}px, ${-2 * s}px); }
                    26%, 36% { transform: translate(${-4 * s}px, ${1 * s}px); }
                    40%, 48% { transform: translate(${3 * s}px, ${3 * s}px); }
                    52%, 58% { transform: translate(${-2 * s}px, ${-3 * s}px); }
                    62%, 72% { transform: translate(${4 * s}px, 0px); }
                    76%, 86% { transform: translate(${-3 * s}px, ${2 * s}px); }
                    90%, 100% { transform: translate(0px, 0px); }
                }
                @keyframes ${blinkId} {
                    0%, 14%   { height: 0px; }
                    15%       { height: 100%; }
                    18%       { height: 0px; }
                    38%, 39%  { height: 0px; }
                    40%       { height: 100%; }
                    42%       { height: 0px; }
                    43%       { height: 100%; }
                    45%       { height: 0px; }
                    68%, 69%  { height: 0px; }
                    70%       { height: 100%; }
                    73%       { height: 0px; }
                    100%      { height: 0px; }
                }
                @keyframes ${bounceId} {
                    0%, 100% { transform: translateY(0px); }
                    15%      { transform: translateY(-1px); }
                    30%      { transform: translateY(0px); }
                    50%      { transform: translateY(${size === 24 ? 1 : 0.5}px) scaleY(${size === 24 ? 0.97 : 0.98}); }
                    65%      { transform: translateY(${size === 24 ? -1 : -0.5}px) scaleY(${size === 24 ? 1.02 : 1.01}); }
                    80%      { transform: translateY(0px); }
                }
            `}</style>
        </div>
    );
}
