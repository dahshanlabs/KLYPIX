// Per-canvas cloud-share state — localStorage map of filePath → {blobId, keyB64}.
//
// When a user shares a canvas, syncClient.pushNew() creates a new cloud blob
// and returns {id, keyB64, shareUrl}. We persist {id, keyB64} so that:
//   - Subsequent saves of the same canvas push UPDATES (pushUpdate) rather
//     than creating a duplicate cloud blob each time.
//   - The user can re-show the share URL without re-uploading.
//
// keyB64 lives in localStorage by design — the URL fragment that gets shared
// is the OTHER copy of this key; storing it locally means the user doesn't
// need to keep the share URL around to keep editing their canvas. Losing
// localStorage = losing the ability to update an existing cloud blob without
// the URL — but the file on disk is always untouched, so worst case the user
// can re-share (push as new).

const STORAGE_KEY = 'klypix:cloudShares';

export interface CloudShare {
    /** Server-assigned UUID of the encrypted blob. */
    blobId: string;
    /** Base64-encoded AES-256 key. The same key lives in the share URL's
     *  fragment (#...). Never sent to the server. */
    keyB64: string;
    /** Share token in the URL path (base64url, 43 chars). Resolves to
     *  blobId server-side via canvas_share_tokens. Optional ONLY for
     *  legacy entries minted before tokens existed — shareCurrentCanvas
     *  back-fills these on next push. */
    shareToken?: string;
    /** Full share URL — convenience, can be re-derived from shareToken + keyB64. */
    shareUrl: string;
    /** When this canvas was last successfully pushed (ms epoch). */
    lastPushedAt: number;
}

type ShareMap = Record<string, CloudShare>;

function readAll(): ShareMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch { return {}; }
}

function writeAll(map: ShareMap): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* full → drop */ }
}

export function getCloudShare(filePath: string): CloudShare | undefined {
    return readAll()[filePath];
}

export function setCloudShare(filePath: string, share: CloudShare): void {
    const all = readAll();
    all[filePath] = share;
    writeAll(all);
}

export function removeCloudShare(filePath: string): void {
    const all = readAll();
    delete all[filePath];
    writeAll(all);
}

export function listCloudShares(): Array<{ filePath: string } & CloudShare> {
    const all = readAll();
    return Object.entries(all).map(([filePath, share]) => ({ filePath, ...share }));
}
