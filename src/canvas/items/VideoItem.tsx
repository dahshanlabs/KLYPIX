import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, ExternalLink, Video as VideoIcon } from 'lucide-react';
import type { VideoItem as VideoItemType } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { getAsset } from '../file/assetRegistry';
import { useCanvasStore } from '../state/canvasStore';

interface Props {
    item: VideoItemType;
    selected: boolean;
}

// Periodic currentTime persist while playing — dispatched into the store so
// reloading the canvas resumes at roughly the same spot. Debounced so we
// don't push a patch every timeupdate tick.
const PERSIST_INTERVAL_MS = 1500;

export const VideoItemView = React.memo(VideoItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${ss}`;
}

function VideoItemViewImpl({ item, selected }: Props) {
    const { dispatch } = useCanvasStore();
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [t, setT] = useState(item.currentTimeSec || 0);
    const [dur, setDur] = useState(item.durationSec || 0);
    const lastPersistRef = useRef<number>(0);

    const src = item.assetId ? getAsset(item.assetId)?.blobUrl : undefined;

    // Restore last scrub position on mount / when the blob first resolves.
    useEffect(() => {
        const el = videoRef.current;
        if (!el || !src) return;
        const initial = item.currentTimeSec || 0;
        if (initial > 0 && Math.abs(el.currentTime - initial) > 0.25) {
            try { el.currentTime = initial; } catch { /* seek before metadata */ }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src]);

    const onLoadedMetadata = () => {
        const el = videoRef.current;
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
        const el = videoRef.current;
        if (!el) return;
        setT(el.currentTime);
        const now = performance.now();
        if (now - lastPersistRef.current > PERSIST_INTERVAL_MS) {
            lastPersistRef.current = now;
            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { currentTimeSec: el.currentTime } as any });
        }
    };

    const toggle = () => {
        const el = videoRef.current;
        if (!el) return;
        if (el.paused) { el.play().catch(() => { /* ignored */ }); setPlaying(true); }
        else { el.pause(); setPlaying(false); }
    };

    const seek = (clientFraction: number) => {
        const el = videoRef.current;
        if (!el || !dur) return;
        const next = Math.max(0, Math.min(dur, clientFraction * dur));
        el.currentTime = next;
        setT(next);
        dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { currentTimeSec: next } as any });
    };

    const openExternal = async () => {
        const api: any = (window as any).electron?.canvas;
        if (!api) return;
        if (item.originalPath) {
            const res = await api.openPath(item.originalPath);
            if (res?.ok) return;
        }
        // No bytes-fallback here (videos are potentially huge) — the main
        // process can extract from the ZIP via the same openAssetBytes bridge
        // FileItem uses, but only if the caller has the base64. Defer that
        // round-trip unless users actually hit it.
    };

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 10,
        background: '#0a0a0f',
        border: `1px solid ${selected ? 'rgba(16,185,129,0.7)' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.2)' : '0 4px 16px rgba(0,0,0,0.3)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    return (
        <>
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <div style={{ position: 'relative', flex: 1, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
                    {src ? (
                        <video
                            ref={videoRef}
                            src={src}
                            poster={item.posterDataUrl}
                            muted={muted}
                            preload="metadata"
                            onLoadedMetadata={onLoadedMetadata}
                            onTimeUpdate={onTimeUpdate}
                            onPlay={() => setPlaying(true)}
                            onPause={() => setPlaying(false)}
                            style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'auto' }}
                        />
                    ) : (
                        <div style={{ color: 'rgba(255,255,255,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                            <VideoIcon size={28} />
                            <div style={{ fontSize: 11 }}>Video unavailable</div>
                        </div>
                    )}
                </div>
                <div
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                        padding: '6px 8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        background: '#12121a',
                        borderTop: '1px solid rgba(255,255,255,0.05)',
                        fontFamily: 'Outfit, system-ui, sans-serif',
                    }}
                >
                    <button
                        onClick={(e) => { e.stopPropagation(); toggle(); }}
                        title={playing ? 'Pause' : 'Play'}
                        style={{ padding: 4, borderRadius: 5, background: 'rgba(16,185,129,0.15)', color: '#10b981', cursor: 'pointer' }}
                    >
                        {playing ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <div
                        onClick={(e) => {
                            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                            seek((e.clientX - rect.left) / rect.width);
                        }}
                        style={{
                            flex: 1,
                            height: 4,
                            borderRadius: 2,
                            background: 'rgba(255,255,255,0.1)',
                            cursor: 'pointer',
                            position: 'relative',
                        }}
                    >
                        <div style={{
                            position: 'absolute',
                            top: 0, left: 0, bottom: 0,
                            width: dur ? `${(t / dur) * 100}%` : '0%',
                            background: '#10b981',
                            borderRadius: 2,
                        }} />
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums', minWidth: 72, textAlign: 'right' }}>
                        {formatTime(t)} / {formatTime(dur)}
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}
                        title={muted ? 'Unmute' : 'Mute'}
                        style={{ padding: 3, color: 'rgba(255,255,255,0.55)', cursor: 'pointer' }}
                    >
                        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                    </button>
                    {item.originalPath && (
                        <button
                            onClick={(e) => { e.stopPropagation(); openExternal(); }}
                            title="Open externally"
                            style={{ padding: 3, color: 'rgba(255,255,255,0.45)', cursor: 'pointer' }}
                        >
                            <ExternalLink size={12} />
                        </button>
                    )}
                </div>
            </div>
            {selected && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    minW={240} minH={160}
                    preserveAspect
                />
            )}
        </>
    );
}
