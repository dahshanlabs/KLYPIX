import { Cog } from 'lucide-react';
import { KlypixEyes } from './KlypixEyes';

/**
 * AgentRobot — Klypix eyes (purple tint) + robot helmet with antenna.
 * Working state: animated eyes + swaying antenna + pulsing glow
 * Complete state: static eyes + small smile below + dim antenna
 */
export function AgentRobot({ isWorking = true, className = '' }: { isWorking?: boolean; className?: string }) {
    return (
        <div className={`flex flex-col items-center gap-0 shrink-0 ${className}`}>
            {/* Helmet cap + antenna */}
            <div className="relative flex flex-col items-center mb-[-2px]"
                style={{ animation: isWorking ? 'antennaFloat 1.5s ease-in-out infinite' : 'none' }}>

                {/* Antenna stem + ball */}
                <div className="flex flex-col items-center">
                    {/* Antenna ball */}
                    <div className="relative w-[6px] h-[6px]">
                        {/* Glow aura */}
                        <div className="absolute inset-[-4px] rounded-full"
                            style={{
                                background: 'radial-gradient(circle, rgba(168,85,247,0.5) 0%, rgba(168,85,247,0) 70%)',
                                animation: isWorking ? 'antennaPulse 1.2s ease-in-out infinite' : 'none',
                                opacity: isWorking ? 1 : 0.2,
                            }} />
                        <div className="absolute inset-0 rounded-full"
                            style={{ background: isWorking ? '#a855f7' : '#7c3aed', transition: 'background 0.3s' }} />
                        <div className="absolute top-[0.5px] left-[1.5px] w-[2px] h-[2px] rounded-full bg-[#e9d5ff] opacity-70" />
                    </div>
                    {/* Antenna stem */}
                    <div className="w-[1.5px] h-[6px]"
                        style={{ background: isWorking ? '#a855f7' : '#7c3aed', transition: 'background 0.3s' }} />
                </div>

                {/* Helmet cap — curved arc sitting on top of the eyes */}
                <svg width="42" height="10" viewBox="0 0 42 10" className="block">
                    <path
                        d="M4 10 Q4 2, 21 2 Q38 2, 38 10"
                        fill="none"
                        stroke={isWorking ? '#a855f7' : '#7c3aed'}
                        strokeWidth="2"
                        strokeLinecap="round"
                        style={{ transition: 'stroke 0.3s' }}
                    />
                </svg>
            </div>

            {/* Eyes — KlypixEyes with purple filter (gear renders below as a sibling) */}
            {isWorking ? (
                <div style={{ filter: 'hue-rotate(200deg) saturate(1.3)' }}>
                    <KlypixEyes size={18} />
                </div>
            ) : (
                /* Complete state: static purple eyes (no animation) */
                <div className="flex gap-[2px]">
                    <div className="w-[18px] h-[18px] rounded-[6px] bg-white overflow-hidden"
                        style={{ border: '1.5px solid #5b21b6' }}>
                        <div className="w-[9px] h-[9px] rounded-full bg-[#8b5cf6] relative" style={{ top: 4, left: 4 }}>
                            <div className="w-[4px] h-[4px] rounded-full bg-[#3b0764] absolute" style={{ top: 2.5, left: 2.5 }} />
                            <div className="w-[2px] h-[2px] rounded-full bg-white absolute opacity-80" style={{ top: 1, left: 1.5 }} />
                        </div>
                    </div>
                    <div className="w-[18px] h-[18px] rounded-[6px] bg-white overflow-hidden"
                        style={{ border: '1.5px solid #5b21b6' }}>
                        <div className="w-[9px] h-[9px] rounded-full bg-[#8b5cf6] relative" style={{ top: 4, left: 4 }}>
                            <div className="w-[4px] h-[4px] rounded-full bg-[#3b0764] absolute" style={{ top: 2.5, left: 2.5 }} />
                            <div className="w-[2px] h-[2px] rounded-full bg-white absolute opacity-80" style={{ top: 1, left: 1.5 }} />
                        </div>
                    </div>
                </div>
            )}

            {/* Spinning purple gear — sits centered BELOW the eyes while working */}
            {isWorking && (
                <div
                    className="mt-[2px]"
                    style={{
                        animation: 'agentGearSpin 2s linear infinite',
                        filter: 'drop-shadow(0 0 4px rgba(168,85,247,0.9))',
                        lineHeight: 0,
                    }}
                >
                    <Cog size={14} strokeWidth={2.5} color="#a855f7" />
                </div>
            )}

            {/* Smile — only shown when complete */}
            {!isWorking && (
                <svg width="16" height="8" viewBox="0 0 16 8" className="mt-[1px]">
                    <path
                        d="M3 2 Q8 7, 13 2"
                        fill="none"
                        stroke="#a855f7"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                    />
                </svg>
            )}

            <style>{`
                @keyframes antennaPulse {
                    0%, 100% { opacity: 0.4; transform: scale(1); }
                    50% { opacity: 1; transform: scale(1.4); }
                }
                @keyframes antennaFloat {
                    0%, 100% { transform: translateY(0px) rotate(0deg); }
                    25% { transform: translateY(-1px) rotate(5deg); }
                    50% { transform: translateY(-1.5px) rotate(0deg); }
                    75% { transform: translateY(-1px) rotate(-5deg); }
                }
                @keyframes agentGearSpin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
}
