import React from 'react';
import { Layers as CanvasIcon, ExternalLink } from 'lucide-react';
import type { CanvasLinkItem as CanvasLinkItemType } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';

interface Props {
    item: CanvasLinkItemType;
    selected: boolean;
}

// Module-level handler: MultiCanvas sets this so the link card can open the
// target .any in a new tab when clicked. Outside the React tree so the
// badge doesn't have to be prop-drilled through CanvasRenderer.
export type OpenCanvasLinkFn = (filePath: string) => void;
let openCanvasLinkGlobal: OpenCanvasLinkFn = () => { /* no-op until MultiCanvas registers */ };
export function setOpenCanvasLinkHandler(fn: OpenCanvasLinkFn): void { openCanvasLinkGlobal = fn; }
/** Imperative trigger for non-click callers (e.g. dbl-click opener). */
export function openCanvasLink(filePath: string): void { openCanvasLinkGlobal(filePath); }

export const CanvasLinkItemView = React.memo(CanvasLinkItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function CanvasLinkItemViewImpl({ item, selected }: Props) {
    const fileName = item.filePath.split(/[\\/]/).pop() || item.filePath;
    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 10,
        background: '#12121a',
        border: `1px solid ${selected ? 'rgba(16,185,129,0.7)' : 'rgba(16,185,129,0.25)'}`,
        boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.2)' : '0 4px 16px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
        gap: 6,
        fontFamily: 'Outfit, system-ui, sans-serif',
        color: '#e8e8ed',
        pointerEvents: 'auto',
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    const open = (e: React.MouseEvent) => {
        e.stopPropagation();
        openCanvasLinkGlobal(item.filePath);
    };

    return (
        <>
            <div
                data-canvas-item={item.id}
                style={style}
                className="no-drag"
                onDoubleClick={open}
                title={`Double-click to open ${fileName} in a new tab`}
            >
                <div className="flex items-center gap-2">
                    <div style={{
                        width: 28, height: 28, borderRadius: 6,
                        background: 'rgba(16,185,129,0.12)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#10b981',
                    }}>
                        <CanvasIcon size={15} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.title || fileName}
                        </div>
                        <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
                            Canvas · .klypix
                        </div>
                    </div>
                    <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={open}
                        title="Open in new tab"
                        style={{
                            padding: 5, borderRadius: 6,
                            background: 'rgba(16,185,129,0.15)',
                            color: '#10b981', cursor: 'pointer', flexShrink: 0,
                        }}
                    >
                        <ExternalLink size={12} />
                    </button>
                </div>
                <div style={{
                    fontSize: 10, color: 'rgba(255,255,255,0.35)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                }}>{item.filePath}</div>
            </div>
            {selected && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    minW={200} minH={64}
                />
            )}
        </>
    );
}
