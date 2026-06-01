// In-memory transcript cache, keyed by assetId. The first canvas_read_item on
// a video/audio item pays the Gemini round-trip; every later read of the same
// item in-session is O(1) with no network call. Stores only the compact
// transcript string (a few KB) — never the bytes (those live once in the asset
// registry). assetId is unique+stable for an asset's lifetime, so a re-dropped
// file gets a new id and can never serve a stale transcript. Cleared on
// NEW_FILE / LOAD_FILE via assetRegistry.clearAssets().

const cache = new Map<string, string>();

export function getCachedTranscript(assetId: string | undefined | null): string | undefined {
    return assetId ? cache.get(assetId) : undefined;
}

export function setCachedTranscript(assetId: string, transcript: string): void {
    if (assetId) cache.set(assetId, transcript);
}

export function clearTranscriptCache(): void {
    cache.clear();
}
