// CloudTransport implementation that proxies through the electron preload
// bridge to canvas-cloud:* IPC handlers in the main process.
//
// The actual `window.electron.cloud` shape is exposed by electron/preload.ts;
// the global Window typing in App.tsx is heavy WIP territory, so we declare
// our own narrow view of just the cloud subset here. As long as the runtime
// shape matches, everything works.

import type { CloudTransport, BlobMeta } from './syncClient';

interface ElectronCloudBridge {
    upload(envelope: Uint8Array, titleHint: string | null): Promise<BlobMeta>;
    replace(id: string, envelope: Uint8Array, titleHint: string | null): Promise<BlobMeta>;
    download(id: string): Promise<Uint8Array>;
    list(): Promise<BlobMeta[]>;
    delete(id: string): Promise<void>;
    createShareToken(blobId: string): Promise<string>;
}

function bridge(): ElectronCloudBridge {
    const w = window as any;
    const b: ElectronCloudBridge | undefined = w?.electron?.cloud;
    if (!b) {
        throw new Error(
            'window.electron.cloud is unavailable. ' +
            'Either the preload script did not run, or this build does not include cloud sync.'
        );
    }
    return b;
}

/**
 * Wrap `window.electron.cloud` as a CloudTransport. Each call resolves the
 * bridge lazily, so this transport object can be created at module init
 * time without throwing — only the actual upload/download calls fail if
 * the preload hasn't run yet.
 */
export const electronCloudTransport: CloudTransport = {
    upload: (envelope, titleHint) => bridge().upload(envelope, titleHint),
    replace: (id, envelope, titleHint) => bridge().replace(id, envelope, titleHint),
    download: (id) => bridge().download(id),
    list: () => bridge().list(),
    delete: (id) => bridge().delete(id),
    createShareToken: (blobId) => bridge().createShareToken(blobId),
};
