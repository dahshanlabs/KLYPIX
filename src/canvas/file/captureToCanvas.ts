import type { ImageItem } from '../items/types';
import { newId } from '../items/types';
import { registerAsset, base64ToBytes, generateThumbnail } from './assetRegistry';

// Default display cap for newly-captured screenshots — same constants as
// fileToItem's image branch so a captured screenshot lands at the same
// "feels right" size as a dropped image.
const MAX_DEFAULT_W = 520;
const HEADROOM = 2;

function imageNaturalSize(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 1280, h: img.naturalHeight || 720 });
        img.onerror = () => resolve({ w: 1280, h: 720 });
        img.src = src;
    });
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function timestampedFileName(prefix: string, ext: string): string {
    const d = new Date();
    return `${prefix}-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.${ext}`;
}

export interface CaptureTarget {
    worldX: number;
    worldY: number;
    zIndexStart: number;
    viewZoom: number;
}

/**
 * Convert a captured base64 JPEG (full-screen or snip) into an ImageItem
 * centered on (worldX, worldY). Mirrors fileToItem's image branch: bytes
 * registered as an asset, optional thumbnail, zoom-compensated display
 * size so the screenshot looks the same size on canvas regardless of zoom.
 */
export async function base64JpegToImageItem(
    base64: string,
    target: CaptureTarget,
    source: 'screen' | 'snip',
): Promise<ImageItem | null> {
    try {
        const bytes = base64ToBytes(base64);
        const fileName = timestampedFileName(source === 'snip' ? 'snip' : 'screen', 'jpg');
        const asset = registerAsset({ mime: 'image/jpeg', extension: 'jpg', bytes, fileName });

        let thumbnailAssetId: string | undefined;
        try {
            const thumbBytes = await generateThumbnail(bytes, 'image/jpeg', 320);
            if (thumbBytes) {
                const thumb = registerAsset({
                    mime: 'image/jpeg', extension: 'jpg', bytes: thumbBytes,
                    fileName: `thumb_${fileName}`,
                });
                thumbnailAssetId = thumb.id;
            }
        } catch { /* thumbnail is best-effort */ }

        const { w: nw, h: nh } = await imageNaturalSize(asset.blobUrl);
        const capW = Math.min(MAX_DEFAULT_W, Math.max(40, nw / HEADROOM));
        const scale = nw > capW ? capW / nw : 1;
        const vz = Math.max(0.01, target.viewZoom);
        const w = Math.round((nw * scale) / vz);
        const h = Math.round((nh * scale) / vz);

        return {
            id: newId('img'),
            type: 'image',
            x: target.worldX - w / 2,
            y: target.worldY - h / 2,
            w,
            h,
            zIndex: target.zIndexStart,
            locked: false,
            parentId: null,
            createdAt: Date.now(),
            createdBy: 'user',
            src: '',
            assetId: asset.id,
            thumbnailAssetId,
            originalWidth: nw,
            originalHeight: nh,
            fileName,
        };
    } catch (err) {
        console.warn('[canvas capture] failed to build ImageItem:', err);
        return null;
    }
}
