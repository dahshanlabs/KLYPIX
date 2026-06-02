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
    /** Brief confirmation banner shown inside the modal after an action
     *  resolves successfully. Auto-clears after ~1.6s. id forces React
     *  reconciliation so back-to-back identical texts still re-animate. */
    toast: { text: string; id: number } | null;
    /** Sticky detail-pane visibility. Defaults false. Auto-flips true on
     *  the first row-with-detail the user highlights; stays true for the
     *  rest of this palette open even when arrowing to detail-less rows
     *  ("No preview" placeholder renders instead). Toggle off via the
     *  eye button in the header. Reset on palette close. */
    detailPaneSticky: boolean;
    /** Set when the user explicitly turned the detail pane off via the
     *  eye button. Suppresses the auto-flip-on-detail behavior until the
     *  palette closes — respects the user's "I don't want this right
     *  now" intent across arrow navigation. Reset on palette close. */
    detailPaneUserDismissed: boolean;
    /** Smart-paste target — captured at palette open() so the primary
     *  Paste action can SendKeys ^v straight into the app the user just
     *  came from. Null when no recent non-Klypix foreground is known
     *  (boot, no ENUM_WINDOWS result yet). app is a friendly process
     *  name for the "Paste to <App>" label. */
    target: { app: string; hwnd: string } | null;
    /** Compact mode = Alt+K standalone mini window. Skips the dark
     *  backdrop and (more importantly here) suppresses empty-state
     *  emptyState() fan-out, so the list stays clean until the user
     *  types OR activates an exclusive provider (clip button / typing
     *  `clip:`). Driven by App.tsx via setCompact() when paletteOnly
     *  toggles. */
    compact: boolean;
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
    toast: null,
    detailPaneSticky: false,
    detailPaneUserDismissed: false,
    target: null,
    compact: false,
};

// Friendly-name map mirrors the one in clipboardHistory.ts so the palette
// label says "Paste to VS Code" instead of "Paste to Code". Kept here to
// avoid round-tripping the cosmetic transform back through main.
const PROC_FRIENDLY: Record<string, string> = {
    code: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf',
    chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave',
    opera: 'Opera', notepad: 'Notepad', notepadplusplus: 'Notepad++',
    explorer: 'File Explorer', winword: 'Word', excel: 'Excel',
    powerpnt: 'PowerPoint', outlook: 'Outlook', teams: 'Teams',
    slack: 'Slack', discord: 'Discord', figma: 'Figma',
    photoshop: 'Photoshop', illustrator: 'Illustrator', spotify: 'Spotify',
    obsidian: 'Obsidian', notion: 'Notion', zoom: 'Zoom',
    terminal: 'Terminal', windowsterminal: 'Windows Terminal',
    powershell: 'PowerShell', cmd: 'Command Prompt', wt: 'Windows Terminal',
};
function friendlyProcName(proc: string): string {
    const k = proc.toLowerCase().replace(/\.exe$/, '');
    if (PROC_FRIENDLY[k]) return PROC_FRIENDLY[k];
    return proc.charAt(0).toUpperCase() + proc.slice(1);
}
let toastTimer: number | null = null;

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
    const prevSelectedIndex = state.selectedIndex;
    const prevRanked = state.ranked;
    state = { ...state, ...patch };
    // Auto-flip detailPaneSticky to true ONLY when the user JUST moved
    // to a row that has a detail factory. Triggers off a real selection
    // change — not every mutation — so the eye-button toggle isn't
    // immediately undone by the auto-flip when the current row still
    // has detail.
    const selectionChanged =
        state.selectedIndex !== prevSelectedIndex ||
        state.ranked !== prevRanked;
    if (selectionChanged && !state.detailPaneSticky && !state.detailPaneUserDismissed) {
        const cur = state.ranked[state.selectedIndex];
        if (cur?.detail) {
            state = { ...state, detailPaneSticky: true };
        }
    }
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
            // When a filter chip is active the view is already narrowed
            // to one kind — section headers become redundant noise.
            if (r.sectionHeader) return false;
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
    // Don't park selection on a section header — find the first real row.
    if (ranked[nextIdx]?.sectionHeader) {
        for (let i = 0; i < ranked.length; i++) {
            if (!ranked[i].sectionHeader) { nextIdx = i; break; }
        }
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
    // Snapshot the previous foreground window so primary "Paste" actions
    // can SendKeys straight there. Fire-and-forget — UI doesn't block on
    // it; the label upgrades from "Paste" to "Paste to <App>" the moment
    // it resolves. If the bridge is missing (web build), we silently stay
    // on the copy-only fallback.
    void captureSmartPasteTarget();
    // Re-fire the current query so empty-state providers populate.
    runQuery(state.query);
}

async function captureSmartPasteTarget(): Promise<void> {
    try {
        const bridge: any = (window as any).electron;
        if (!bridge?.getLastActiveWindow) return;
        const win = await bridge.getLastActiveWindow();
        if (win?.hwnd && win?.process && win.process !== 'Unknown') {
            set({ target: { app: friendlyProcName(win.process), hwnd: String(win.hwnd) } });
        } else {
            set({ target: null });
        }
    } catch {
        set({ target: null });
    }
}

export function close() {
    if (!state.open) return;
    queryAbort?.abort();
    queryAbort = null;
    set({ open: false, secondaryCursor: 0, target: null, detailPaneSticky: false, detailPaneUserDismissed: false });
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
    // Skip past section headers — they're labels, not selectable rows.
    // Keep moving in the same direction until we land on a real result
    // OR hit a boundary. If the boundary IS a header, retreat one step
    // back to the previous real row.
    const step = delta >= 0 ? 1 : -1;
    while (state.ranked[next]?.sectionHeader && next >= 0 && next <= max) {
        const candidate = next + step;
        if (candidate < 0 || candidate > max) {
            // Walked off the edge — find the nearest non-header in the
            // OPPOSITE direction so we don't park on a label.
            for (let i = next - step; i >= 0 && i <= max; i -= step) {
                if (!state.ranked[i]?.sectionHeader) { next = i; break; }
            }
            break;
        }
        next = candidate;
    }
    set({ selectedIndex: next, secondaryCursor: 0 });
}

export function jumpSelection(to: 'top' | 'bottom' | number) {
    if (state.ranked.length === 0) return;
    const max = state.ranked.length - 1;
    let next: number;
    if (to === 'top') next = 0;
    else if (to === 'bottom') next = max;
    else next = Math.max(0, Math.min(max, to));
    // Skip section headers — same rule as moveSelection.
    if (state.ranked[next]?.sectionHeader) {
        const step = to === 'bottom' ? -1 : 1;
        for (let i = next; i >= 0 && i <= max; i += step) {
            if (!state.ranked[i]?.sectionHeader) { next = i; break; }
        }
    }
    set({ selectedIndex: next, secondaryCursor: 0 });
}

/** Toggle the sticky detail-pane visibility (the eye button in the header).
 *  Turning OFF also sets detailPaneUserDismissed so the auto-flip-on-
 *  detail logic respects the user's intent until they re-toggle or
 *  close the palette. Turning ON clears the dismissed flag. */
export function toggleDetailPane() {
    const willBeOn = !state.detailPaneSticky;
    set({
        detailPaneSticky: willBeOn,
        detailPaneUserDismissed: !willBeOn,
    });
}

/** Show a brief confirmation banner inside the palette. Auto-clears after
 *  ~1.6s. Replacing an existing toast resets the timer. */
export function showToast(text: string) {
    if (!text) return;
    if (toastTimer != null) {
        window.clearTimeout(toastTimer);
        toastTimer = null;
    }
    set({ toast: { text, id: Date.now() } });
    toastTimer = window.setTimeout(() => {
        toastTimer = null;
        set({ toast: null });
    }, 1600);
}

export function setClipFilter(filter: PaletteState['clipFilter']) {
    if (state.clipFilter === filter) return;
    set({ clipFilter: filter });
    rebuildRanked();
}

/** Toggle compact-mode behavior. Currently affects the empty-state policy:
 *  in compact mode, an empty query with no exclusive provider yields zero
 *  rows (clean "search to surface" UX); in normal mode the providers'
 *  emptyState() defaults still populate (recent canvases, etc.). */
export function setCompact(c: boolean) {
    if (state.compact === c) return;
    set({ compact: c });
    if (state.open) runQuery(state.query);
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

    // Empty input → empty-state results from every provider, UNLESS we're
    // in compact mode (Alt+K mini window). In compact mode the user
    // explicitly wants a clean "type to search" surface — no rows show
    // until they either type a character or activate an exclusive
    // provider via the clipboard quick-button.
    if (rawInput.trim().length === 0 && !exclusiveId) {
        if (state.compact) {
            state.bySource = new Map();
            rebuildRanked();
            return;
        }
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
                // Empty → CLEAR this provider's slot (don't leave stale rows
                // from a previous query, e.g. a canvas name that now matches
                // nothing). Only this provider's rows are affected.
                const next = new Map(state.bySource);
                if (results.length === 0) next.delete(p.id); else next.set(p.id, results);
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
