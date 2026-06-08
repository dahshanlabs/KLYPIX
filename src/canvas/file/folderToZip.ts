import JSZip from 'jszip';
import type { FileItem } from '../items/types';
import { newId } from '../items/types';
import { registerAsset, mimeFromExtension } from './assetRegistry';

// Per-file and per-folder size guards. Anything over the per-file cap is
// skipped + recorded in the manifest so the user knows what was left out;
// anything that would push the total past the folder cap stops further
// ingestion to keep `.klypix` size sane.
const MAX_FILE_BYTES = 200 * 1024 * 1024;    // 200 MB per leaf
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;  // 1 GB per folder

interface FlatEntry { relPath: string; file: File }

// Chromium's readEntries caps each call at 100 — call until empty to fully
// drain a directory. The DirectoryEntry stays valid across awaits as long as
// we don't release the user activation event, but the underlying selection
// (dataTransfer.items) does NOT — caller must snapshot entries synchronously
// inside the drop handler before awaiting any of this.
async function readAll(reader: any): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
        reader.readEntries(resolve as any, reject as any);
    });
}

async function walkDirectory(
    entry: FileSystemDirectoryEntry,
    prefix: string,
    out: FlatEntry[],
): Promise<void> {
    const reader = entry.createReader();
    while (true) {
        const chunk = await readAll(reader);
        if (!chunk.length) break;
        for (const child of chunk) {
            if (child.isFile) {
                const file = await new Promise<File>((resolve, reject) => {
                    (child as FileSystemFileEntry).file(resolve, reject);
                });
                out.push({ relPath: prefix + child.name, file });
            } else if (child.isDirectory) {
                await walkDirectory(child as FileSystemDirectoryEntry, prefix + child.name + '/', out);
            }
        }
    }
}

export interface FolderToItemTarget {
    x: number;
    y: number;
    zIndexStart: number;
    viewZoom?: number;
}

export interface FolderToItemResult {
    item: FileItem;
}

/**
 * Walk a dropped directory, ZIP its contents into a single asset, and
 * produce a folder-flavored FileItem. The ZIP keeps the original relative
 * paths so the card can show a tree and the user can extract individual
 * leaves later via JSZip on the renderer side.
 *
 * Returns null if the walk fails entirely (permission denied, etc).
 * Partial failures (one unreadable file inside a successful folder) are
 * recorded in `folderSkipped` and shown on the card.
 */
export async function folderToItem(
    entry: FileSystemDirectoryEntry,
    target: FolderToItemTarget,
    indexOffset = 0,
): Promise<FolderToItemResult | null> {
    const flat: FlatEntry[] = [];
    try {
        await walkDirectory(entry, '', flat);
    } catch (err) {
        console.warn('[folder drop] walk failed:', err);
        return null;
    }

    const zip = new JSZip();
    const manifest: Array<{ path: string; size: number; mime: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let totalBytes = 0;

    for (const { relPath, file } of flat) {
        if (file.size > MAX_FILE_BYTES) {
            skipped.push({ path: relPath, reason: 'file > 200MB' });
            continue;
        }
        if (totalBytes + file.size > MAX_TOTAL_BYTES) {
            skipped.push({ path: relPath, reason: 'folder cap (1GB) reached' });
            continue;
        }
        try {
            const buf = await file.arrayBuffer();
            zip.file(relPath, buf);
            const ext = relPath.includes('.') ? relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase() : '';
            manifest.push({
                path: relPath,
                size: file.size,
                mime: file.type || mimeFromExtension(ext) || 'application/octet-stream',
            });
            totalBytes += file.size;
        } catch (err) {
            skipped.push({ path: relPath, reason: 'read failed' });
        }
    }

    // DEFLATE level 6 is the sweet spot — level 9 spends 3-5× the CPU for
    // a few extra percent. Folders are usually already-compressed media
    // (PDF/PNG/MP4) where any level past 1 yields diminishing returns.
    const zipBytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });

    const asset = registerAsset({
        mime: 'application/x-klypix-folder',
        extension: 'zip',
        bytes: zipBytes,
        fileName: `${entry.name}.zip`,
    });

    // Zoom-independent world size: the folder card bakes the same world size on
    // every PC regardless of each viewer's local view.zoom (never synced in
    // collab). Matches Figma/tldraw — placed media has a fixed canvas size.
    const x = target.x + indexOffset * 24;
    const y = target.y + indexOffset * 24;
    const z = target.zIndexStart + indexOffset;

    // Sort manifest alphabetically by path so the tree-view renders in a
    // predictable order — Chromium's readEntries returns OS-dependent ordering
    // which on Windows can be near-random.
    manifest.sort((a, b) => a.path.localeCompare(b.path));

    const item: FileItem = {
        id: newId('file'),
        type: 'file',
        x,
        y,
        w: 360,
        // Tree view height grows with entry count, capped so a 5000-file
        // folder doesn't produce a card taller than the viewport.
        h: Math.min(440, 96 + manifest.length * 18),
        zIndex: z,
        locked: false,
        parentId: null,
        createdAt: Date.now(),
        createdBy: 'user',
        fileName: entry.name,
        // fileSize on a folder card means the ZIP size — the asset weight
        // the .klypix actually pays. folderTotalSize holds the raw total.
        fileSize: zipBytes.byteLength,
        extension: 'folder',
        mimeType: 'application/x-klypix-folder',
        assetId: asset.id,
        isFolder: true,
        folderManifest: manifest,
        folderEntryCount: manifest.length,
        folderTotalSize: totalBytes,
        folderSkipped: skipped.length > 0 ? skipped : undefined,
    };
    return { item };
}
