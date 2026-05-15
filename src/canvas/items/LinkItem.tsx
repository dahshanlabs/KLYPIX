import React from 'react';
import { ExternalLink, Link as LinkIcon } from 'lucide-react';
import type { LinkItem as LinkItemType } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';

interface Props {
    item: LinkItemType;
    selected: boolean;
}

export const LinkItemView = React.memo(LinkItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function domainOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return url; }
}

function openExternal(url: string) {
    try {
        const openFn = (window as any).electron?.openExternal;
        if (typeof openFn === 'function') { openFn(url); return; }
    } catch { /* noop */ }
    window.open(url, '_blank');
}

// Scale inner content proportionally to the card's current width relative
// to the default mint size (320x140). Keeps typography/padding proportional
// when the user drags a corner to make the card bigger or smaller. Clamped
// so the smallest card still has readable chrome.
const BASE_WIDTH = 320;
const MIN_SCALE = 0.7;
const MAX_SCALE = 3;

function LinkItemViewImpl({ item, selected }: Props) {
    const title = item.title || domainOf(item.url);
    const site = item.siteName || domainOf(item.url);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, item.w / BASE_WIDTH));
    const px = (n: number) => Math.round(n * scale);

    const wrapperStyle: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 10,
        background: '#12121a',
        border: `1px solid ${selected ? 'rgba(16,185,129,0.7)' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.2)' : '0 4px 16px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    return (
        <>
            <div
                data-canvas-item={item.id}
                style={wrapperStyle}
                className="no-drag"
                onDoubleClick={(e) => { e.stopPropagation(); openExternal(item.url); }}
                title="Double-click to open in browser"
            >
                {item.imageUrl && (
                    <div style={{
                        flex: '0 0 auto',
                        height: Math.max(px(90), item.h * 0.5),
                        background: '#0a0a0f center / cover no-repeat',
                        backgroundImage: `url(${JSON.stringify(item.imageUrl)})`,
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                    }} />
                )}
                <div style={{
                    padding: `${px(10)}px ${px(12)}px`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: px(4),
                    flex: 1,
                    minHeight: 0,
                    fontFamily: 'Outfit, system-ui, sans-serif',
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: px(6),
                        color: 'rgba(255,255,255,0.4)',
                        fontSize: px(10),
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}>
                        {item.favicon
                            ? <img src={item.favicon} alt="" width={px(12)} height={px(12)} style={{ borderRadius: 2 }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                            : <LinkIcon size={px(11)} />}
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{site}</span>
                    </div>
                    <div style={{
                        fontSize: px(13),
                        color: '#e8e8ed',
                        fontWeight: 500,
                        lineHeight: 1.25,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                    }}>
                        {item.loading ? 'Loading preview…' : title}
                    </div>
                    {item.description && (
                        <div style={{
                            fontSize: px(11),
                            color: 'rgba(255,255,255,0.55)',
                            lineHeight: 1.35,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                        }}>
                            {item.description}
                        </div>
                    )}
                    {item.error && !item.loading && (
                        <div style={{ fontSize: px(10), color: '#f87171' }}>Preview unavailable — {item.error}</div>
                    )}
                    <div style={{ flex: 1 }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: px(6) }}>
                        <div style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: px(10),
                            color: 'rgba(255,255,255,0.35)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}>{item.url}</div>
                        <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); openExternal(item.url); }}
                            title="Open in browser"
                            className="shrink-0 hover:!bg-emerald-500/20 hover:!text-emerald-300 transition-colors"
                            style={{
                                padding: px(4),
                                borderRadius: 5,
                                background: 'rgba(255,255,255,0.04)',
                                color: 'rgba(255,255,255,0.55)',
                                cursor: 'pointer',
                            }}
                        >
                            <ExternalLink size={px(11)} />
                        </button>
                    </div>
                </div>
            </div>
            {selected && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    minW={220} minH={100}
                />
            )}
        </>
    );
}
