import React, { useState } from 'react';
import { Globe, X, Loader2, Check } from 'lucide-react';

interface CdpRestartBannerProps {
    browsers: string[]; // ['chrome', 'edge'] — which browsers need restart
    onDismiss: () => void;
}

export function CdpRestartBanner({ browsers, onDismiss }: CdpRestartBannerProps) {
    const [restarting, setRestarting] = useState<string | null>(null);
    const [completed, setCompleted] = useState<Set<string>>(new Set());

    const browserLabels: Record<string, string> = {
        chrome: 'Chrome', edge: 'Edge', brave: 'Brave',
        vivaldi: 'Vivaldi', opera: 'Opera', firefox: 'Firefox',
    };

    const handleRestart = async (browser: string) => {
        setRestarting(browser);
        try {
            await (window as any).electron.enableCdp();
            await (window as any).electron.restartBrowser(browser);
            setCompleted(prev => new Set([...prev, browser]));
            setRestarting(null);

            // If all browsers are done, auto-dismiss after 5 seconds
            if (completed.size + 1 >= browsers.length) {
                setTimeout(() => onDismiss(), 5000);
            }
        } catch (_) {
            setRestarting(null);
        }
    };

    // All done
    if (completed.size >= browsers.length) {
        return (
            <div className="mx-4 my-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 backdrop-blur-sm p-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <div className="flex items-center gap-2 text-emerald-400 text-xs">
                    <Check size={14} />
                    <span>Browser integration enabled. Your tabs are being restored. This is a one-time setup.</span>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-4 my-2 rounded-xl border border-blue-500/20 bg-blue-500/5 backdrop-blur-sm overflow-hidden" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="p-3">
                <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0">
                        <Globe size={14} className="text-blue-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-white/80 text-xs font-medium mb-1">Enable full browser integration</div>
                        <div className="text-white/35 text-[10px] mb-2.5">
                            KLYPIX can read web pages directly. Restart each browser once to enable. Your tabs will be restored automatically.
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            {browsers.map(browser => {
                                const label = browserLabels[browser] || browser;
                                if (completed.has(browser)) {
                                    return (
                                        <span key={browser} className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-[11px]">
                                            <Check size={10} /> {label} ✓
                                        </span>
                                    );
                                }
                                return (
                                    <button
                                        key={browser}
                                        onClick={() => handleRestart(browser)}
                                        disabled={!!restarting}
                                        className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/60 text-[11px] transition-all cursor-pointer disabled:opacity-50"
                                    >
                                        {restarting === browser ? <Loader2 size={10} className="animate-spin" /> : null}
                                        Restart {label}
                                    </button>
                                );
                            })}
                            <button
                                onClick={onDismiss}
                                className="text-white/25 text-[10px] hover:text-white/40 transition-colors cursor-pointer ml-auto"
                            >
                                {completed.size > 0 ? 'Done' : 'Not now'}
                            </button>
                        </div>
                    </div>
                    <button onClick={onDismiss} className="text-white/20 hover:text-white/40 cursor-pointer p-0.5 shrink-0">
                        <X size={12} />
                    </button>
                </div>
            </div>
        </div>
    );
}
