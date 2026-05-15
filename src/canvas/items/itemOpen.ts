import type { CanvasItem } from './types';
import { getAsset, bytesToBase64 } from '../file/assetRegistry';
import { openFileExternally } from './FileItem';
import { openCanvasLink } from './CanvasLinkItem';

/**
 * Optional canvas-context arg lets file items participate in the embed
 * round-trip flow. When the canvas is saved, double-click opens the file
 * in its native app AND starts a watcher that re-packs edits into the
 * .klypix automatically. Without canvasFilePath, falls back to the
 * non-watched legacy behavior.
 */
export interface OpenItemContext {
    canvasFilePath?: string | null;
}

// Centralized "open this item" dispatch. Triggered on double-click in the
// select tool for any item type that has an external representation
// (file, image, video, audio, link, canvas-link). Text / box / container
// keep their existing dblclick semantics (edit / convert / focus) — those
// are handled inline in useCanvasInteraction.ts before this helper is
// consulted.
//
// Return value is intentionally void: callers fire-and-forget. Any error
// is logged and swallowed so one dead asset doesn't break subsequent
// interactions.

export async function tryOpenItem(item: CanvasItem, ctx?: OpenItemContext): Promise<void> {
    const api: any = (window as any).electron;
    try {
        switch (item.type) {
            case 'file':
                await openFileExternally(item, ctx?.canvasFilePath ?? null);
                return;
            case 'image':
            case 'video':
            case 'audio': {
                // Same open-externally flow as FileItem: prefer originalPath,
                // fall back to extracting asset bytes to a temp file. Image
                // items don't store originalPath today so they always go
                // through the bytes path — fine, they're small.
                const canvasApi = api?.canvas;
                if (!canvasApi) return;
                const originalPath = (item as any).originalPath;
                if (originalPath && canvasApi.openPath) {
                    const res = await canvasApi.openPath(originalPath);
                    if (res?.ok) return;
                }
                const assetId = (item as any).assetId;
                const asset = assetId ? getAsset(assetId) : undefined;
                if (!asset || !canvasApi.openAssetBytes) return;
                await canvasApi.openAssetBytes({
                    fileName: (item as any).fileName || `asset_${item.id}`,
                    base64: bytesToBase64(asset.bytes),
                });
                return;
            }
            case 'link': {
                // Open the URL in the default browser. openExternal is the
                // one IPC consistently available across the existing KLYPIX
                // surface (chat/agent already use it).
                const url = (item as any).url;
                if (!url) return;
                if (typeof api?.openExternal === 'function') api.openExternal(url);
                else window.open(url, '_blank');
                return;
            }
            case 'canvas-link': {
                // Hand off to the registered canvas-link opener — spawns a
                // new tab pointed at the linked .any file. Same path the
                // single-click already uses; dbl-click is an alias.
                const filePath = (item as any).filePath;
                if (filePath) openCanvasLink(filePath);
                return;
            }
            default:
                return;
        }
    } catch (err) {
        console.warn('[canvas] tryOpenItem failed for', item.type, err);
    }
}
