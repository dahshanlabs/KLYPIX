import React from 'react';
import type { ImageItem as ImageItemType } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { getAsset } from '../file/assetRegistry';
import { useCanvasStore } from '../state/canvasStore';

interface Props {
    item: ImageItemType;
    selected: boolean;
}

// Below this effective on-screen pixel size (item.w * zoom), show the
// thumbnail instead of the full-resolution asset. Cuts GPU memory for
// wide zoomed-out canvases.
const THUMBNAIL_THRESHOLD_PX = 360;

export const ImageItemView = React.memo(ImageItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function ImageItemViewImpl({ item, selected }: Props) {
    // Read zoom so the thumbnail-vs-full decision updates on zoom change.
    // The memo comparison skips re-render when only external state changes,
    // but our parent always passes fresh item on state change, so this is
    // fine — when zoom alone changes without item reference changing, we
    // re-evaluate on the parent's next real update. In practice zoom moves
    // accompany item-level changes (pan resets pins, viewport cull changes
    // which items mount) frequently enough that this is smooth.
    const { state } = useCanvasStore();
    const renderedW = item.w * state.view.zoom;
    const useThumbnail = !selected && renderedW < THUMBNAIL_THRESHOLD_PX && !!item.thumbnailAssetId;
    const effectiveAssetId = useThumbnail ? item.thumbnailAssetId : item.assetId;
    const blobUrl = effectiveAssetId ? getAsset(effectiveAssetId)?.blobUrl : undefined;
    const imgSrc = blobUrl || (item.assetId ? getAsset(item.assetId)?.blobUrl : undefined) || item.src || '';
    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: selected
            ? '0 0 0 3px rgba(16,185,129,0.35), 0 6px 24px rgba(0,0,0,0.4)'
            : '0 4px 16px rgba(0,0,0,0.35)',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    return (
        <>
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <img
                    src={imgSrc}
                    alt={item.fileName}
                    draggable={false}
                    style={{
                        width: '100%', height: '100%', display: 'block',
                        objectFit: 'cover', pointerEvents: 'none',
                        // Tell Chromium to use the best bitmap resampling
                        // when the image is scaled up (view zoom > 1×).
                        // Doesn't magically add detail, but avoids the
                        // low-quality default fast-resize at high zoom.
                        imageRendering: 'high-quality' as any,
                    } as React.CSSProperties}
                />
            </div>
            {selected && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    preserveAspect
                    minW={40} minH={40}
                />
            )}
        </>
    );
}
