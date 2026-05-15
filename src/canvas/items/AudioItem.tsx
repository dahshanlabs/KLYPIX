import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, ExternalLink, Music } from 'lucide-react';
import type { AudioItem as AudioItemType } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { getAsset } from '../file/assetRegistry';
import { useCanvasStore } from '../state/canvasStore';

interface Props {
    item: AudioItemType;
    selected: boolean;
}

const PERSIST_INTERVAL_MS = 1500;

export const AudioItemView = React.memo(AudioItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${ss}`;
}

function AudioItemViewImpl({ item, selected }: Props) {
    const { dispatch } = useCanvasStore();
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [t, setT] = useState(item.currentTimeSec || 0);
    const [dur, setDur] = useState(item.durationSec || 0);
    const lastPersistRef = useRef<number>(0);

    const src = item.assetId ? getAsset(item.assetId)?.blobUrl : undefined;

    useEffect(() => {
        const el = audioRef.current;
        if (!el || !src) return;
        const initial = item.currentTimeSec || 0;
        if (initial > 0 && Math.abs(el.currentTime - initial) > 0.25) {
            try { el.currentTime = initial; } catch { /* ignore */ }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src]);

    const onLoadedMetadata = () => {
        const el = audioRef.current;
        if (!el) return;
        if (!item.durationSec && isFinite(el.duration)) {
            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { durationSec: el.duration } as any });
            setDur(el.duration);
        } else {
            setDur(el.duration || item.durationSec || 0);
        }
        if ((item.currentTimeSec || 0) > 0) {
            try { el.currentTime = item.currentTimeSec!; } catch { /* ignore */ }
        }
    };

    const onTimeUpdate = () => {
        const el = audioRef.current;
        if (!el) return;
        setT(el.currentTime);
        const now = performance.now();
        if (now - lastPersistRef.current > PERSIST_INTERVAL_MS) {
            lastPersistRef.current = now;
            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { currentTimeSec: el.currentTime } as any });
        }
    };

    const toggle = () => {
        const el = audioRef.current;
        if (!el) return;
        if (el.paused) { el.play().catch(() => { /* ignore */ }); setPlaying(true); }
        else { el.pause(); setPlaying(false); }
    };

    const seek = (fraction: number) => {
        const el = audioRef.current;
        if (!el || !dur) return;
        const next = Math.max(0, Math.min(dur, fraction * dur));
        el.currentTime = next;
        setT(next);
        dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { currentTimeSec: next } as any });
    };

    const peaks = item.waveformPeaks || [];
    const progress = dur ? t / dur : 0;

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 10,
        background: '#12121a',
        border: `1px solid ${selected ? 'rgba(16,185,129,0.7)' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.2)' : '0 4px 16px rgba(0,0,0,0.3)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: 'Outfit, system-ui, sans-serif',
        color: '#e8e8ed',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    return (
        <>
            <div data-canvas-item={item.id} style={style} className="no-drag">
                {/* Hidden audio element drives playback. */}
                {src && (
                    <audio
                        ref={audioRef}
                        src={src}
                        preload="metadata"
                        onLoadedMetadata={onLoadedMetadata}
                        onTimeUpdate={onTimeUpdate}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                    />
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{
                        width: 32, height: 32, borderRadius: 6,
                        background: 'rgba(16,185,129,0.12)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#10b981',
                    }}>
                        <Music size={16} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.fileName}
                        </div>
                        <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
                            Audio · {item.extension.toUpperCase()}
                        </div>
                    </div>
                    {item.originalPath && (
                        <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                e.stopPropagation();
                                (window as any).electron?.canvas?.openPath?.(item.originalPath);
                            }}
                            title="Open externally"
                            style={{ padding: 4, color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
                        >
                            <ExternalLink size={12} />
                        </button>
                    )}
                </div>
                {/* Waveform strip — click anywhere to seek. */}
                <div
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                        seek((e.clientX - rect.left) / rect.width);
                    }}
                    style={{
                        position: 'relative',
                        flex: 1,
                        minHeight: 40,
                        background: 'rgba(255,255,255,0.04)',
                        borderRadius: 6,
                        overflow: 'hidden',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                    }}
                >
                    {peaks.length > 0 ? (
                        <Waveform peaks={peaks} progress={progress} />
                    ) : (
                        <div style={{
                            position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'rgba(255,255,255,0.2)', fontSize: 11,
                        }}>
                            (no waveform)
                        </div>
                    )}
                    {/* Progress overlay */}
                    <div style={{
                        position: 'absolute',
                        left: 0, top: 0, bottom: 0,
                        width: `${progress * 100}%`,
                        background: 'rgba(16,185,129,0.18)',
                        pointerEvents: 'none',
                    }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); toggle(); }}
                        title={playing ? 'Pause' : 'Play'}
                        style={{ padding: 5, borderRadius: 6, background: 'rgba(16,185,129,0.15)', color: '#10b981', cursor: 'pointer' }}
                    >
                        {playing ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
                        {formatTime(t)} / {formatTime(dur)}
                    </div>
                </div>
            </div>
            {selected && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    minW={260} minH={120}
                />
            )}
        </>
    );
}

function Waveform({ peaks, progress }: { peaks: number[]; progress: number }) {
    const barCount = peaks.length;
    return (
        <svg
            viewBox={`0 0 ${barCount} 100`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: '100%', display: 'block' }}
        >
            {peaks.map((p, i) => {
                const h = Math.max(2, Math.min(100, p * 100));
                const y = (100 - h) / 2;
                const passed = i / barCount <= progress;
                return (
                    <rect
                        key={i}
                        x={i + 0.1}
                        y={y}
                        width={0.8}
                        height={h}
                        fill={passed ? '#10b981' : 'rgba(255,255,255,0.35)'}
                    />
                );
            })}
        </svg>
    );
}
