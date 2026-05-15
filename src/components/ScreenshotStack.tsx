import React from 'react';
import type { ScreenshotEntry } from '../hooks/useScreenshot';

interface ScreenshotStackProps {
    stack: ScreenshotEntry[];
    onCapture: () => void;
    onCompare: () => void;
    onAskAbout: () => void;
    onRemove: (index: number) => void;
    onClear: () => void;
    onPreview: (base64: string) => void;
}

export function ScreenshotStackBar({ stack, onCapture, onCompare, onAskAbout, onRemove, onClear, onPreview }: ScreenshotStackProps) {
    if (stack.length === 0) return null;

    return (
        <div
            className="mx-4 my-1.5 no-drag animate-in fade-in slide-in-from-top-1 duration-300"
            style={{ WebkitAppRegion: 'no-drag' } as any}
        >
            <div className="flex items-center gap-1.5 overflow-x-auto">
                {/* Thumbnail pills */}
                {stack.map((entry, i) => (
                    <div key={i} className="relative group shrink-0">
                        <div
                            className="h-8 w-12 rounded-lg overflow-hidden border border-white/10 hover:border-indigo-500/40 transition-all cursor-pointer relative"
                            onClick={() => onPreview(entry.base64)}
                        >
                            <img
                                src={`data:image/jpeg;base64,${entry.base64}`}
                                className="h-full w-full object-cover"
                                alt={`Screenshot ${i + 1}`}
                            />
                            <span className="absolute top-0 left-0.5 text-[7px] font-bold text-white/80 drop-shadow-sm">
                                {i + 1}
                            </span>
                        </div>
                        {/* Remove button — visible on hover */}
                        <button
                            onClick={(e) => { e.stopPropagation(); onRemove(i); }}
                            className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center bg-red-500 rounded-full text-white opacity-0 group-hover:opacity-100 transition-all hover:scale-110 cursor-pointer"
                        >
                            <svg width="6" height="6" viewBox="0 0 10 10"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="2.5" /></svg>
                        </button>
                    </div>
                ))}

                {/* Add button */}
                <button
                    onClick={onCapture}
                    className="h-8 w-8 rounded-lg border border-dashed border-indigo-500/30 hover:border-indigo-500/50 hover:bg-indigo-500/10 flex items-center justify-center text-indigo-400/60 hover:text-indigo-400 transition-all cursor-pointer shrink-0"
                    title="Capture another"
                >
                    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>

                {/* Separator */}
                <div className="w-px h-5 bg-white/10 shrink-0 mx-0.5" />

                {/* Compare button — only when 2+ screenshots */}
                {stack.length >= 2 && (
                    <button
                        onClick={onCompare}
                        className="h-7 px-2.5 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 text-[10px] font-medium transition-all cursor-pointer shrink-0 whitespace-nowrap"
                    >
                        Compare
                    </button>
                )}

                {/* Clear all */}
                <button
                    onClick={onClear}
                    className="text-white/15 hover:text-white/40 transition-colors cursor-pointer p-0.5 shrink-0 ml-auto"
                    title="Clear all"
                >
                    <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" /></svg>
                </button>
            </div>
        </div>
    );
}
