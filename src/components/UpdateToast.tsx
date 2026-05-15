import React from 'react';
import { X, Download, RefreshCw, Loader2, AlertTriangle } from 'lucide-react';
import type { UpdateState } from '../hooks/useUpdater';

interface UpdateToastProps {
    state: UpdateState;
    onInstall: () => void;
    onDismiss: () => void;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateToast({ state, onInstall, onDismiss }: UpdateToastProps) {
    return (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 w-[340px] bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden animate-in slide-in-from-bottom-4">

            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <div className="flex items-center gap-2">
                    {state.status === 'downloading' ? (
                        <Loader2 size={14} className="text-emerald-400 animate-spin" />
                    ) : state.status === 'ready' ? (
                        <Download size={14} className="text-emerald-400" />
                    ) : (
                        <RefreshCw size={14} className="text-emerald-400" />
                    )}
                    <span className="text-white/80 text-xs font-medium uppercase tracking-wider">
                        {state.status === 'downloading' ? 'Downloading Update' :
                         state.status === 'ready' ? 'Update Ready' :
                         'Update Available'}
                    </span>
                </div>
                {!state.mandatory && (
                    <button onClick={onDismiss} className="text-white/30 hover:text-white/60 transition-colors p-1 cursor-pointer">
                        <X size={12} />
                    </button>
                )}
            </div>

            {/* Body */}
            <div className="px-4 py-2">
                <p className="text-white text-sm font-medium">
                    v{state.version}
                </p>

                {state.mandatory && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                        <AlertTriangle size={12} className="text-amber-400" />
                        <span className="text-amber-400/80 text-xs">Required update</span>
                    </div>
                )}

                {/* Progress bar (downloading) */}
                {state.status === 'downloading' && (
                    <div className="mt-3">
                        <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                                style={{ width: `${state.progress}%` }}
                            />
                        </div>
                        <div className="flex justify-between mt-1.5">
                            <span className="text-white/30 text-xs">{state.progress}%</span>
                            <span className="text-white/30 text-xs">
                                {formatBytes(state.transferred)} / {formatBytes(state.total)}
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="px-4 pb-3 pt-1 flex gap-2">
                {state.status === 'ready' ? (
                    <>
                        <button
                            onClick={onInstall}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg py-2 transition-all cursor-pointer"
                        >
                            Restart Now
                        </button>
                        {!state.mandatory && (
                            <button
                                onClick={onDismiss}
                                className="flex-1 bg-white/5 hover:bg-white/10 text-white/60 text-xs font-medium rounded-lg py-2 transition-all cursor-pointer"
                            >
                                Later
                            </button>
                        )}
                    </>
                ) : state.status === 'available' ? (
                    <p className="text-white/30 text-xs">Downloading...</p>
                ) : null}
            </div>
        </div>
    );
}
