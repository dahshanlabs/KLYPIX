// Phase 23 — Command Palette external store.
//
// Owns: open/closed state, current query, active provider routing, raw
// per-provider results, merged ranked list, highlighted index, secondary-
// action cycle position, and the provider registry.
//
// Why useSyncExternalStore: the palette is mounted ONCE at the App root
// but consumed by components in deeply different trees (the modal UI,
// optional badges elsewhere, the chat input bar's status hint). A
// Context with every state field would re-render every consumer on every
// keystroke. The external-store pattern lets each consumer subscribe to
// the specific slice it cares about.
//
// Why a module singleton: the palette is global (one instance, always).
// No reason to thread it through Context — that just adds friction for
// command-line scripts and dev-tools introspection. `window.klypixPalette`
// is exposed in dev so the user can open/close it from DevTools console.

import type {
    PaletteProvider,
    PaletteResult,
    RankedResult,
} from './providers/types';
import { mergeAndRank } from './search';

interface PaletteState {
    open: boolean;
    query: string;
    /** Provider id when the query starts with a registered prefix
     *  (consumes the prefix). Null when no exclusive routing. */
    exclusiveProvider: string | null;
    /** Per-provider raw results (one entry per provider that returned).
     *  Re-merged into `ranked` on any change. */
    bySource: Map<string, PaletteResult[]>;
    /** Final merged + ranked list. Source of truth for the UI. */
    ranked: RankedResult[];
    /** Index of the currently-highlighted row in `ranked`. Clamped on
     *  every list update so the same selection survives query changes
     *  that only reorder, not the ones that empty the list. */
    selectedIndex: number;
    /** Which secondary action label to show in the footer hint. Cycled
     *  by Tab. Reset to 0 on selection change. */
    secondaryCursor: number;
    /** Best-in-class clip: filter — narrow ranked list to a kind subset.
     *  null = no filter (default). 'pinned' / 'text' / 'image' / 'files'.
     *  Only meaningful when exclusiveProvider === 'clip'. */
    clipFilter: 'pinned' | 'text' | 'image' | 'files' | null;
}

const SOURCE_WEIGHT: Record<string, number> = {
    calc: 0.3,       // exact math answers stay at the top
    klypix: 0.6,     // canvas / chat / agent results — the moat
    clip: 1.0,
    ai: 0.9,
    apps: 1.1,
    files: 1.2,
    web: 1.4,
};

let state: PaletteState = {
    open: false,
    query: '',
    exclusiveProvider: null,
    bySource: new Map(),
    ranked: [],
    selectedIndex: 0,
    secondaryCursor: 0,
    clipFilter: null,
};

const listeners = new Set<() => void>();
const providers = new Map<string, PaletteProvider>();
/** Aborts the in-flight query when the input changes. */
let queryAbort: AbortController | null = null;

function emit() {
    for (const cb of listeners) cb();
}

/** Replace state with a new shallow-merged object so React's identity
 *  check fires. */
function set(patch: Partial<PaletteState>) {
    state = { ...state, ...patch };
    emit();
}

function rebuildRanked() {
    const weights = new Map<string, number>();
    for (const id of state.bySource.keys()) {
        weights.set(id, SOURCE_WEIGHT[id] ?? 1.0);
    }
    let ranked = mergeAndRank(state.bySource, weights);
    // Best-in-class clip: filter chips. Filter the ranked list AFTER merge
    // so the rest of the pipeline doesn't have to know about kind-subsets.
    // Filter probes the id format we use in clipboardProvider ('clip:<id>',
    // with sync-rows prefixed 'clip:sync:<uuid>') + the result subtitle's
    // pin emoji (📌) for pinned filtering.
    if (state.clipFilter && state.exclusiveProvider === 'clip') {
        const filter = state.clipFilter;
        ranked = ranked.filter(r => {
            if (filter === 'pinned') return r.title.startsWith('📌');
            // Kind detection: clipboardProvider sets distinct icons by kind.
            // We can't easily peek at the icon, so we rely on title content
            // heuristics: image rows are pure 'Image' or have no preview;
            // file rows show a path or a "<n> files" string.
            if (filter === 'image') {
                return r.title === 'Image' || r.title.startsWith('📌 Image');
            }
            if (filter === 'files') {
                return /^[A-Z]:\\|^\/|^\d+ files/.test(r.title.replace(/^📌 /, ''));
            }
            if (filter === 'text') {
                const t = r.title.replace(/^📌 /, '');
                if (t === 'Image') return false;
                if (/^[A-Z]:\\|^\/|^\d+ files/.test(t)) return false;
                return true;
            }
            return true;
        });
    }
    // Clamp selection to new list size — but try to keep the same RESULT
    // highlighted if it's still present (by id), so users mid-Tab don't
    // get yanked to the top on every keystroke.
    const prevId = state.ranked[state.selectedIndex]?.id;
    let nextIdx = 0;
    if (prevId) {
        const found = ranked.findIndex(r => r.id === prevId);
        if (found >= 0) nextIdx = found;
    }
    set({ ranked, selectedIndex: nextIdx, secondaryCursor: 0 });
}

// ── public API ────────────────────────────────────────────────────────

export function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function getSnapshot(): PaletteState {
    return state;
}

export function register(provider: PaletteProvider): () => void {
    providers.set(provider.id, provider);
    return () => providers.delete(provider.id);
}

export function open() {
    if (state.open) return;
    set({ open: true });
    // Re-fire the current query so empty-state providers populate.
    runQuery(state.query);
}

export function close() {
    if (!state.open) return;
    queryAbort?.abort();
    queryAbort = null;
    set({ open: false, secondaryCursor: 0 });
}

export function toggle() {
    state.open ? close() : open();
}

/** Open the palette pre-filtered to a specific provider's prefix.
 *  Used by toolbar buttons (Clipboard, Apps, etc.) that want to give the
 *  user a one-click entry to a single source instead of asking them to
 *  type the prefix manually. */
export function openWithPrefix(prefix: string) {
    set({ open: true, query: prefix });
    runQuery(prefix);
}

export function setQuery(q: string) {
    set({ query: q });
    runQuery(q);
}

export function moveSelection(delta: number) {
    if (state.ranked.length === 0) return;
    const max = state.ranked.length - 1;
    let next = state.selectedIndex + delta;
    if (next < 0) next = 0;
    if (next > max) next = max;
    set({ selectedIndex: next, secondaryCursor: 0 });
}

export function jumpSelection(to: 'top' | 'bottom' | number) {
    if (state.ranked.length === 0) return;
    const max = state.ranked.length - 1;
    let next: number;
    if (to === 'top') next = 0;
    else if (to === 'bottom') next = max;
    else next = Math.max(0, Math.min(max, to));
    set({ selectedIndex: next, secondaryCursor: 0 });
}

export function setClipFilter(filter: PaletteState['clipFilter']) {
    if (state.clipFilter === filter) return;
    set({ clipFilter: filter });
    rebuildRanked();
}

export function cycleSecondary(delta: 1 | -1) {
    const cur = state.ranked[state.selectedIndex];
    if (!cur) return;
    const count = cur.secondaryActions?.length ?? 0;
    if (count === 0) return;
    let next = state.secondaryCursor + delta;
    if (next < 0) next = count - 1;
    if (next >= count) next = 0;
    set({ secondaryCursor: next });
}

// ── query routing ─────────────────────────────────────────────────────

async function runQuery(rawInput: string) {
    queryAbort?.abort();
    queryAbort = new AbortController();
    const signal = queryAbort.signal;

    // Resolve exclusive-prefix routing.
    let input = rawInput;
    let exclusiveId: string | null = null;
    for (const p of providers.values()) {
        if (p.prefix && rawInput.startsWith(p.prefix)) {
            exclusiveId = p.id;
            input = rawInput.slice(p.prefix.length);
            break;
        }
    }
    // Reset clip filter when leaving clip: mode (or when no exclusive
    // provider is routing). Keeps the filter chips visible only when
    // they're meaningful.
    const nextClipFilter = exclusiveId === 'clip' ? state.clipFilter : null;
    set({ exclusiveProvider: exclusiveId, bySource: new Map(), clipFilter: nextClipFilter });

    // Empty input → empty-state results from every provider.
    if (rawInput.trim().length === 0 && !exclusiveId) {
        const bySource = new Map<string, PaletteResult[]>();
        for (const p of providers.values()) {
            try {
                const results = p.emptyState?.() ?? [];
                if (results.length > 0) bySource.set(p.id, results);
            } catch { /* swallow per-provider */ }
        }
        if (signal.aborted) return;
        state.bySource = bySource;
        rebuildRanked();
        return;
    }

    // Fan out the query across active providers.
    const targets = exclusiveId
        ? [providers.get(exclusiveId)].filter(Boolean) as PaletteProvider[]
        : Array.from(providers.values());

    // Each provider gets its own slot in bySource that updates
    // independently — so a fast in-memory provider can render results
    // BEFORE a slow web fetch finishes.
    const ctx = { signal };
    await Promise.all(targets.map(async p => {
        try {
            const out = p.query(input, ctx);
            if (out && typeof (out as any)[Symbol.asyncIterator] === 'function') {
                // Streaming provider — each yielded chunk REPLACES this
                // provider's slot in the merged list.
                for await (const chunk of out as AsyncIterable<PaletteResult[]>) {
                    if (signal.aborted) return;
                    const next = new Map(state.bySource);
                    next.set(p.id, chunk);
                    state.bySource = next;
                    rebuildRanked();
                }
            } else {
                const results = await (out as Promise<PaletteResult[]>);
                if (signal.aborted) return;
                if (results.length === 0) return;
                const next = new Map(state.bySource);
                next.set(p.id, results);
                state.bySource = next;
                rebuildRanked();
            }
        } catch (err) {
            // Most likely an abort or network error. Don't pollute the
            // UI; just skip this provider's contribution.
            if (signal.aborted) return;
            console.warn(`[palette] provider ${p.id} failed:`, err);
        }
    }));
}

/** Re-run the currently-active query. Call after a provider registers
 *  late so its results show up without requiring the user to retype. */
export function refresh() {
    if (state.open) runQuery(state.query);
}

// Expose to window for DevTools introspection (dev only — production
// builds tree-shake this away if you wrap behind import.meta.env.DEV,
// but the surface area is tiny so we keep it always-on for now).
if (typeof window !== 'undefined') {
    (window as any).klypixPalette = {
        open, close, toggle, setQuery,
        getState: () => state,
        listProviders: () => Array.from(providers.keys()),
    };
}
