// Phase 23 — Frecency tracker for palette results.
//
// "Frecency" = frequency × recency. Lets the palette empty-state surface
// "things you actually use" instead of an alphabetical pile, and biases
// fuzzy-match ranking toward results the user has picked before.
//
// Storage: localStorage JSON. Tried sql.js first but a) we don't already
// have an open db in the renderer for the palette's scale of data, b)
// sql.js's wasm load adds ~150KB to first interaction. localStorage is
// ~200 entries × 50 bytes = 10KB — well within quota and zero load
// overhead. Migrate to sql.js if usage outgrows this.
//
// Decay model:
//   - hits: total number of times a result was the primary action.
//   - lastUsed: epoch ms of the last hit.
//   - boost(now) = 1 + log10(hits) × recencyMultiplier(lastUsed)
//   - recencyMultiplier:
//       <1h:    1.0
//       <24h:   0.7
//       <7d:    0.4
//       <30d:   0.15
//       older:  0.05
//
// Ranking math (applied by search.ts):
//   finalRank = fuseScore × (1 / boost)
//   — Lower rank = higher in list. A perfect Fuse match (score=0) stays
//     at the top regardless of frecency; near-matches get reordered by
//     usage history.

const STORAGE_KEY = 'klypix:palette:frecency:v1';
const MAX_ENTRIES = 500;  // hard cap so the map doesn't grow unbounded

interface FrecencyEntry {
    hits: number;
    lastUsed: number;  // epoch ms
}

// Module-level in-memory cache. Loaded lazily on first access; writes
// debounced to localStorage so a Tab-storm of result picks doesn't trash
// the disk.
let cache: Record<string, FrecencyEntry> | null = null;
let saveTimer: number | null = null;
const SAVE_DEBOUNCE_MS = 800;

function load(): Record<string, FrecencyEntry> {
    if (cache) return cache;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) { cache = {}; return cache; }
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            cache = parsed as Record<string, FrecencyEntry>;
            return cache;
        }
    } catch { /* fall through */ }
    cache = {};
    return cache;
}

function scheduleSave() {
    if (saveTimer != null) return;
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        if (!cache) return;
        try {
            // Cap-by-recency before writing: drop the oldest entries past
            // MAX_ENTRIES. Keeps localStorage from inflating from drive-by
            // result picks across years of use.
            const entries = Object.entries(cache);
            if (entries.length > MAX_ENTRIES) {
                entries.sort((a, b) => b[1].lastUsed - a[1].lastUsed);
                cache = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
        } catch {
            // Quota / parse failure — keep cache in memory, abandon disk save.
        }
    }, SAVE_DEBOUNCE_MS);
}

/** Record a primary-action hit on a result id. */
export function recordHit(resultId: string): void {
    const c = load();
    const existing = c[resultId];
    if (existing) {
        existing.hits += 1;
        existing.lastUsed = Date.now();
    } else {
        c[resultId] = { hits: 1, lastUsed: Date.now() };
    }
    scheduleSave();
}

/** Compute the frecency boost for a result id at the current time. Returns
 *  1.0 (no boost) for unknown ids. Search ranking divides by this — bigger
 *  boost = lower (better) rank. */
export function getBoost(resultId: string, now: number = Date.now()): number {
    const c = load();
    const e = c[resultId];
    if (!e || e.hits <= 0) return 1.0;
    const ageMs = now - e.lastUsed;
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    let recency: number;
    if (ageMs < HOUR) recency = 1.0;
    else if (ageMs < 24 * HOUR) recency = 0.7;
    else if (ageMs < 7 * DAY) recency = 0.4;
    else if (ageMs < 30 * DAY) recency = 0.15;
    else recency = 0.05;
    // log10(hits): 1 hit = 0, 10 hits = 1, 100 hits = 2. We want the FIRST
    // hit to give SOME boost, so add 1 before logging.
    return 1 + Math.log10(e.hits + 1) * recency;
}

/** Return the top N most-used result ids (for empty-state population). */
export function topByFrecency(limit: number = 8): string[] {
    const c = load();
    const now = Date.now();
    return Object.entries(c)
        .map(([id, e]) => ({ id, score: e.hits * (1 / Math.max(0.01, now - e.lastUsed + 1)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.id);
}

/** Test / debug: clear all frecency data. */
export function clearFrecency(): void {
    cache = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
}
