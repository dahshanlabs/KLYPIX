/**
 * KlypixMascot — Single animated mascot placed left of the input textarea.
 *
 * Visual accessories based on active modes:
 * - Agent ON → helmet cap + antenna (same style as AgentRobot)
 * - On Screen ON → 4 emerald corner brackets (viewfinder/screenshot frame)
 * - Both ON → helmet + corners, blended colors, most alert animation
 * - Both OFF → sleeping (closed eyes + zZz)
 *
 * Two small clickable dots below the eyes toggle each mode independently.
 */

interface KlypixMascotProps {
    onScreenEnabled: boolean;
    agentMode: boolean;
    onToggleOnScreen: () => void;
    onToggleAgent: () => void;
    className?: string;
}

export function KlypixMascot({ onScreenEnabled, agentMode, onToggleOnScreen, onToggleAgent, className = '' }: KlypixMascotProps) {
    const isAwake = onScreenEnabled || agentMode;
    const isBoth = onScreenEnabled && agentMode;

    // Eye color based on active modes
    const irisColor = isBoth ? '#8b6fbf' : agentMode ? '#8b5cf6' : onScreenEnabled ? '#4a8fbf' : '#4a6a8f';
    const pupilColor = isBoth ? '#2d1b4e' : agentMode ? '#3b0764' : '#1a2744';
    const borderColor = isBoth ? '#3b2066' : agentMode ? '#5b21b6' : '#1a2744';
    const cornerColor = isBoth ? '#6ee7b7' : '#10b981';

    const eye = (
        <div className="relative" style={{ width: 16, height: 16 }}>
            <div className="absolute inset-0 overflow-hidden"
                style={{ borderRadius: 5, background: '#fff', border: `1.5px solid ${borderColor}` }}>
                {/* Iris + Pupil — only animate when awake */}
                {isAwake && (
                    <div className="absolute" style={{ animation: 'mascotLook 8s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}>
                        <div className="rounded-full absolute"
                            style={{ width: 8, height: 8, top: 3, left: 3, background: irisColor, transition: 'background 0.4s' }}>
                            <div className="rounded-full absolute"
                                style={{ width: 3.5, height: 3.5, top: 2, left: 2, background: pupilColor, transition: 'background 0.4s' }} />
                            <div className="rounded-full bg-white absolute opacity-90"
                                style={{ width: 2, height: 2, top: 0.5, left: 1 }} />
                        </div>
                    </div>
                )}
                {/* Sleeping eyelids — shown when both modes off */}
                {!isAwake && (
                    <>
                        <div className="absolute inset-0" style={{ background: '#e8e0d4', borderRadius: 5 }} />
                        <div className="absolute w-full" style={{ top: '50%', height: 1.5, background: borderColor, borderRadius: 1 }} />
                    </>
                )}
                {/* Blink eyelid — only when awake */}
                {isAwake && (
                    <div className="absolute inset-x-0 top-0"
                        style={{
                            background: '#0a2417',
                            borderBottomLeftRadius: 4,
                            borderBottomRightRadius: 4,
                            animation: 'mascotBlink 6s ease-in-out infinite',
                        }} />
                )}
            </div>
        </div>
    );

    // Corner bracket length & thickness
    const cLen = 6;
    const cThick = 1.5;
    // Eyes container width: 16 + 2(gap) + 16 = 34
    const eyesWidth = 34;

    return (
        <div className={`flex-shrink-0 no-drag ${className}`} style={{ marginTop: agentMode ? 10 : 4 }}>
            <div className="flex flex-col items-center gap-1">
                {/* Main mascot area — includes helmet/antenna + eyes + corners */}
                <div className="relative cursor-default" title={
                    isBoth ? 'On Screen + Agent active' :
                    onScreenEnabled ? 'On Screen active' :
                    agentMode ? 'Agent active' :
                    'All modes off'
                }>
                    {/* ── Helmet cap + Antenna (Agent mode) ── */}
                    {agentMode && (
                        <div className="absolute"
                            style={{
                                bottom: '100%',
                                left: 0,
                                right: 0,
                                marginBottom: onScreenEnabled ? 2 : -1,
                                animation: 'antennaFloat 1.5s ease-in-out infinite',
                            }}>
                            <div className="flex flex-col items-center" style={{ width: '100%' }}>
                                {/* Antenna stem + ball */}
                                <div className="flex flex-col items-center">
                                    {/* Antenna ball */}
                                    <div className="relative" style={{ width: 5, height: 5 }}>
                                        <div className="absolute rounded-full"
                                            style={{
                                                inset: -3,
                                                background: 'radial-gradient(circle, rgba(168,85,247,0.5) 0%, rgba(168,85,247,0) 70%)',
                                                animation: 'antennaPulse 1.2s ease-in-out infinite',
                                            }} />
                                        <div className="absolute inset-0 rounded-full" style={{ background: '#a855f7' }} />
                                        <div className="absolute rounded-full bg-[#e9d5ff] opacity-70"
                                            style={{ width: 2, height: 2, top: 0.5, left: 1 }} />
                                    </div>
                                    {/* Antenna stem */}
                                    <div style={{ width: 1.5, height: 5, background: '#a855f7' }} />
                                </div>

                                {/* Helmet cap — curved arc sitting on top of the eyes */}
                                <svg width={eyesWidth} height="7" viewBox={`0 0 ${eyesWidth} 7`} className="block">
                                    <path
                                        d={`M3 7 Q3 1.5, ${eyesWidth / 2} 1.5 Q${eyesWidth - 3} 1.5, ${eyesWidth - 3} 7`}
                                        fill="none"
                                        stroke="#a855f7"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                    />
                                </svg>
                            </div>
                        </div>
                    )}

                    {/* ── Viewfinder corners (On Screen mode) ── */}
                    {onScreenEnabled && (
                        <div className="absolute pointer-events-none"
                            style={{
                                inset: -5,
                                animation: 'cornersAppear 0.3s ease-out forwards',
                            }}>
                            {/* Top-left */}
                            <div className="absolute top-0 left-0" style={{ width: cLen, height: cThick, background: cornerColor, borderRadius: 1 }} />
                            <div className="absolute top-0 left-0" style={{ width: cThick, height: cLen, background: cornerColor, borderRadius: 1 }} />
                            {/* Top-right */}
                            <div className="absolute top-0 right-0" style={{ width: cLen, height: cThick, background: cornerColor, borderRadius: 1 }} />
                            <div className="absolute top-0 right-0" style={{ width: cThick, height: cLen, background: cornerColor, borderRadius: 1 }} />
                            {/* Bottom-left */}
                            <div className="absolute bottom-0 left-0" style={{ width: cLen, height: cThick, background: cornerColor, borderRadius: 1 }} />
                            <div className="absolute bottom-0 left-0" style={{ width: cThick, height: cLen, background: cornerColor, borderRadius: 1 }} />
                            {/* Bottom-right */}
                            <div className="absolute bottom-0 right-0" style={{ width: cLen, height: cThick, background: cornerColor, borderRadius: 1 }} />
                            <div className="absolute bottom-0 right-0" style={{ width: cThick, height: cLen, background: cornerColor, borderRadius: 1 }} />
                        </div>
                    )}

                    {/* ── Eyes ── */}
                    <div className="flex" style={{
                        gap: 2,
                        animation: isAwake
                            ? (isBoth ? 'mascotBounceAlert 3s ease-in-out infinite' : 'mascotBounce 6s ease-in-out infinite')
                            : 'mascotSleep 3s ease-in-out infinite',
                    }}>
                        {eye}
                        {eye}
                    </div>

                    {/* zZz particles when sleeping — larger & brighter */}
                    {!isAwake && (
                        <div className="absolute -top-3 -right-2 pointer-events-none select-none">
                            <span className="text-[9px] text-white/50 font-bold" style={{ animation: 'mascotZzz 3s ease-in-out infinite' }}>z</span>
                            <span className="text-[7px] text-white/40 font-bold absolute -top-2.5 left-2" style={{ animation: 'mascotZzz 3s ease-in-out infinite 0.7s' }}>z</span>
                            <span className="text-[5px] text-white/30 font-bold absolute -top-4 left-3.5" style={{ animation: 'mascotZzz 3s ease-in-out infinite 1.4s' }}>z</span>
                        </div>
                    )}

                    {/* Glow effect when both modes active */}
                    {isBoth && (
                        <div className="absolute -inset-1 rounded-lg pointer-events-none"
                            style={{
                                background: 'radial-gradient(circle, rgba(16,185,129,0.15) 0%, rgba(139,92,246,0.15) 50%, transparent 70%)',
                                animation: 'mascotGlow 2s ease-in-out infinite',
                            }} />
                    )}
                </div>

                {/* Mode indicator dots with letters — S for Screen, A for Agent */}
                <div className="flex items-center gap-1.5" style={{ marginTop: 3 }}>
                    <button
                        onClick={onToggleOnScreen}
                        className="group relative cursor-pointer flex items-center justify-center"
                        style={{ width: 16, height: 16 }}
                        title={onScreenEnabled ? 'On Screen ON — click to disable' : 'On Screen OFF — click to enable'}
                    >
                        <div
                            className="absolute inset-0 rounded-full transition-all duration-300"
                            style={{
                                background: onScreenEnabled ? '#10b981' : 'rgba(255,255,255,0.12)',
                                boxShadow: onScreenEnabled ? '0 0 6px rgba(16,185,129,0.5)' : 'none',
                                transform: onScreenEnabled ? 'scale(1)' : 'scale(0.9)',
                            }}
                        />
                        <span className="relative transition-all duration-300" style={{
                            fontSize: 9,
                            fontWeight: 800,
                            lineHeight: 1,
                            color: onScreenEnabled ? '#fff' : 'rgba(255,255,255,0.3)',
                        }}>S</span>
                        <div className="absolute -inset-0.5 rounded-full border border-transparent group-hover:border-emerald-500/30 transition-all duration-200" />
                    </button>
                    <button
                        onClick={onToggleAgent}
                        className="group relative cursor-pointer flex items-center justify-center"
                        style={{ width: 16, height: 16 }}
                        title={agentMode ? 'Agent ON — click to disable' : 'Agent OFF — click to enable'}
                    >
                        <div
                            className="absolute inset-0 rounded-full transition-all duration-300"
                            style={{
                                background: agentMode ? '#a855f7' : 'rgba(255,255,255,0.12)',
                                boxShadow: agentMode ? '0 0 6px rgba(168,85,247,0.5)' : 'none',
                                transform: agentMode ? 'scale(1)' : 'scale(0.9)',
                            }}
                        />
                        <span className="relative transition-all duration-300" style={{
                            fontSize: 9,
                            fontWeight: 800,
                            lineHeight: 1,
                            color: agentMode ? '#fff' : 'rgba(255,255,255,0.3)',
                        }}>A</span>
                        <div className="absolute -inset-0.5 rounded-full border border-transparent group-hover:border-purple-500/30 transition-all duration-200" />
                    </button>
                </div>
            </div>

            <style>{`
                @keyframes mascotLook {
                    0%, 10%  { transform: translate(0px, 0px); }
                    14%, 24% { transform: translate(3px, -1.5px); }
                    28%, 40% { transform: translate(-3px, 1px); }
                    44%, 54% { transform: translate(2px, 2px); }
                    58%, 66% { transform: translate(-1.5px, -2px); }
                    70%, 80% { transform: translate(3px, 0px); }
                    84%, 92% { transform: translate(-2px, 1.5px); }
                    96%, 100% { transform: translate(0px, 0px); }
                }
                @keyframes mascotBlink {
                    0%, 18%   { height: 0px; }
                    19%       { height: 100%; }
                    22%       { height: 0px; }
                    48%, 49%  { height: 0px; }
                    50%       { height: 100%; }
                    52%       { height: 0px; }
                    78%, 79%  { height: 0px; }
                    80%       { height: 100%; }
                    83%       { height: 0px; }
                    100%      { height: 0px; }
                }
                @keyframes mascotBounce {
                    0%, 100% { transform: translateY(0px); }
                    15%      { transform: translateY(-0.5px); }
                    50%      { transform: translateY(0.5px) scaleY(0.98); }
                    65%      { transform: translateY(-0.5px) scaleY(1.01); }
                }
                @keyframes mascotBounceAlert {
                    0%, 100% { transform: translateY(0px) rotate(0deg); }
                    15%      { transform: translateY(-1px) rotate(2deg); }
                    35%      { transform: translateY(0px) rotate(0deg); }
                    50%      { transform: translateY(-0.5px) rotate(-2deg); }
                    70%      { transform: translateY(0px) rotate(0deg); }
                    85%      { transform: translateY(-1px) rotate(1deg); }
                }
                @keyframes mascotSleep {
                    0%, 100% { transform: translateY(0px); }
                    50%      { transform: translateY(1px); }
                }
                @keyframes mascotZzz {
                    0%       { opacity: 0; transform: translate(0, 0) scale(0.7); }
                    20%      { opacity: 1; transform: translate(-1px, -3px) scale(1); }
                    60%      { opacity: 0.7; transform: translate(-3px, -8px) scale(1.1); }
                    100%     { opacity: 0; transform: translate(-4px, -14px) scale(0.8); }
                }
                @keyframes mascotGlow {
                    0%, 100% { opacity: 0.5; }
                    50%      { opacity: 1; }
                }
                @keyframes antennaPulse {
                    0%, 100% { opacity: 0.4; transform: scale(1); }
                    50% { opacity: 1; transform: scale(1.4); }
                }
                @keyframes antennaFloat {
                    0%, 100% { transform: translateY(0px) rotate(0deg); }
                    25% { transform: translateY(-1px) rotate(4deg); }
                    50% { transform: translateY(-1.5px) rotate(0deg); }
                    75% { transform: translateY(-1px) rotate(-4deg); }
                }
                @keyframes cornersAppear {
                    0% { opacity: 0; transform: scale(1.3); }
                    100% { opacity: 1; transform: scale(1); }
                }
            `}</style>
        </div>
    );
}
