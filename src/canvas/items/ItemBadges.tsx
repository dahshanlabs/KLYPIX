import React from 'react';
import type { CanvasItem, ItemStatus } from './types';
import { getStatusColor } from './statusColors';

// Hook for CanvasRenderer → KlypixCanvas bridging. Set via context or a
// ref by the surface; falls back to noop so badges still render even if
// the parent didn't wire an opener.
export type OpenCommentsFn = (itemId: string) => void;
let openCommentsGlobal: OpenCommentsFn = () => { /* no-op */ };
export function setOpenCommentsHandler(fn: OpenCommentsFn) { openCommentsGlobal = fn; }

// Small overlay that renders on top of an item: status dot (top-right), tag
// pills (bottom-left), comment count (bottom-right). Positioned in world coords
// so it scales with the canvas transform.

interface Props {
    item: CanvasItem;
    // Visible rect override. Containers in capsule/dotted mode store expanded
    // w/h but render at a smaller auto-fit size, so badges anchored to item.w
    // dangle off to the right of empty space. Callers pass the resolved
    // render rect so badges follow the visible shape.
    renderRect?: { x: number; y: number; w: number; h: number };
}

const STATUS_LABELS: Record<ItemStatus, string> = {
    none: '',
    todo: 'Todo',
    in_progress: 'In Progress',
    in_review: 'In Review',
    done: 'Done',
    blocked: 'Blocked',
    waiting: 'Waiting',
};

export const ItemBadges = React.memo(function ItemBadges({ item, renderRect }: Props) {
    const status = item.status && item.status !== 'none'
        ? { color: getStatusColor(item.status), label: STATUS_LABELS[item.status] }
        : null;
    const tags = item.tags || [];
    const commentCount = item.comments?.length || 0;
    const threadCount = item.thread?.length || 0;
    const rect = renderRect ?? { x: item.x, y: item.y, w: item.w, h: item.h };

    return (
        <>
            {status && (
                // Diamond status badge — 45°-rotated square, same colored
                // fill + dark stroke as before. Geometric corners pull the
                // eye more than a flat circle did, which is what the user
                // wanted for the at-a-glance status indicator.
                <div
                    title={status.label}
                    style={{
                        position: 'absolute',
                        left: rect.x + rect.w - 9,
                        top: rect.y - 3,
                        width: 9,
                        height: 9,
                        background: status.color,
                        border: '1.5px solid #0a0a0f',
                        transform: 'rotate(45deg)',
                        borderRadius: 1,
                        pointerEvents: 'none',
                        zIndex: 5,
                    }}
                />
            )}
            {tags.length > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        left: rect.x + 2,
                        top: rect.y + rect.h + 4,
                        display: 'flex',
                        gap: 3,
                        flexWrap: 'wrap',
                        maxWidth: rect.w,
                        pointerEvents: 'none',
                        zIndex: 5,
                    }}
                >
                    {tags.slice(0, 4).map(tag => (
                        <span
                            key={tag}
                            style={{
                                fontSize: 9,
                                padding: '1px 6px',
                                borderRadius: 3,
                                background: tagColor(tag),
                                color: 'rgba(255,255,255,0.9)',
                                fontFamily: 'Outfit, system-ui, sans-serif',
                                letterSpacing: '0.02em',
                                lineHeight: 1.3,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {tag}
                        </span>
                    ))}
                    {tags.length > 4 && (
                        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>+{tags.length - 4}</span>
                    )}
                </div>
            )}
            {threadCount > 0 && (
                <div
                    title={`${threadCount} thread message${threadCount === 1 ? '' : 's'}`}
                    style={{
                        position: 'absolute',
                        left: rect.x + rect.w - (commentCount > 0 ? 38 : 16),
                        top: rect.y + rect.h - 16,
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        background: 'rgba(16,185,129,0.9)',
                        color: '#0a0a0f',
                        fontSize: 9,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                        zIndex: 5,
                    }}
                >
                    {threadCount > 9 ? '9+' : threadCount}
                </div>
            )}
            {commentCount > 0 && (
                <div
                    title={`${commentCount} comment${commentCount === 1 ? '' : 's'} — click to view`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); openCommentsGlobal(item.id); }}
                    style={{
                        position: 'absolute',
                        left: rect.x + rect.w - 16,
                        top: rect.y + rect.h - 16,
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        background: '#f5a623',
                        color: '#0a0a0f',
                        fontSize: 9,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'auto',
                        cursor: 'pointer',
                        zIndex: 5,
                    }}
                >
                    {commentCount > 9 ? '9+' : commentCount}
                </div>
            )}
        </>
    );
});

// Deterministic color-from-tag hash for consistent per-tag colors.
function tagColor(tag: string): string {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash) + tag.charCodeAt(i) | 0;
    const palette = [
        'rgba(16,185,129,0.35)',  // emerald
        'rgba(245,166,35,0.35)',  // amber
        'rgba(239,68,68,0.35)',   // red
        'rgba(59,130,246,0.35)',  // blue
        'rgba(168,85,247,0.35)',  // purple
        'rgba(45,212,191,0.35)',  // teal
    ];
    return palette[Math.abs(hash) % palette.length];
}
