import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore, type CanvasState } from '../state/canvasStore';
import { serialize, deserialize, titleFromPath, type CanvasDocumentV3 } from './anyFormat';
import {
    serializeV4,
    finalizePayload,
    deserializeV4,
    type KlypixManifest,
} from './klypixFormatV4';
import type { CanvasItem, Connection, DrawnLine, FreehandStroke } from '../items/types';
import {
    bytesToBase64,
    base64ToBytes,
    clearAssetsForIds,
    listAssetsForIds,
    mimeFromExtension,
    registerAsset,
} from './assetRegistry';
import { recordCanvasAccess } from '../dashboard/recentCanvasesStore';

/** Stable per-device id for sync attribution. Generated on first use and never
 *  changes — survives canvas-format upgrades, reinstalls (as long as
 *  localStorage survives), and cloud sync round-trips. */
function getDeviceId(): string {
    const KEY = 'klypix:deviceId';
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(KEY, id);
    }
    return id;
}

/** Does this path target the v4 format? Used to dispatch save flows. */
function isKlypixPath(p: string | null | undefined): boolean {
    if (!p) return false;
    return /\.klypix$/i.test(p);
}

// Surface the three file ops (new / open / save) plus a 30s autosave loop.
// Autosave only runs when we have a filePath — silent-autosave to %APPDATA%
// for crash recovery is deferred to Slice 3.1.

interface AssetPayload { path: string; base64: string }
interface LoadedAssetPayload { path: string; base64: string; mime: string }

/** Open/load result — discriminated by formatVersion. v3 has the legacy single
 *  canvas.json blob; v4 has the per-item layout (manifest + canvas + items). */
type LoadResult =
    | { ok: true; filePath: string; formatVersion: 'v3'; json: string; assets?: LoadedAssetPayload[]; cancelled?: boolean }
    | { ok: true; filePath: string; formatVersion: 'v4'; manifest: string; canvasJson: string; items: Record<string, string>; assets?: LoadedAssetPayload[]; cancelled?: boolean }
    // Legacy callers may still receive responses without formatVersion — treat as v3.
    | { ok: true; filePath: string; json: string; assets?: LoadedAssetPayload[]; cancelled?: boolean; formatVersion?: undefined }
    | { ok: false; cancelled?: boolean; error?: string };

interface CanvasApi {
    save?: (args: { filePath: string; json: string; assets?: AssetPayload[] }) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
    saveAs?: (args: { json: string; defaultName?: string; assets?: AssetPayload[] }) => Promise<{ ok: boolean; filePath?: string; cancelled?: boolean; error?: string }>;
    // v4 save channels — separate from v3 because the payload shape differs.
    saveKlypix?: (args: { filePath: string; manifestJson: string; canvasJson: string; items: Record<string, string>; assets?: AssetPayload[] }) => Promise<{ ok: boolean; error?: string }>;
    saveKlypixAs?: (args: { defaultName?: string; manifestJson: string; canvasJson: string; items: Record<string, string>; assets?: AssetPayload[] }) => Promise<{ ok: boolean; filePath?: string; cancelled?: boolean; error?: string }>;
    open?: () => Promise<LoadResult>;
    openByPath?: (filePath: string) => Promise<LoadResult>;
    onFileOpened?: (cb: (path: string) => void) => () => void;
    autosave?: (args: { json: string; assets?: AssetPayload[] }) => Promise<{ ok: boolean; error?: string }>;
    checkAutosave?: () => Promise<{ exists: boolean; mtime?: number; path?: string }>;
    clearAutosave?: () => Promise<{ ok: boolean }>;
    // Embed subsystem (Phase 3) — defined here for the cleanup hook below.
    embedCleanupCanvas?: (canvasFilePath: string, deleteWorkingDir?: boolean) => Promise<{ ok: boolean }>;
}

// Walk live state and gather the asset ids that any item still references.
// Anything in the registry that isn't referenced is left out of the save —
// keeps file size honest after a delete + save cycle.
function collectReferencedAssetIds(state: CanvasState): string[] {
    const ids = new Set<string>();
    for (const id of state.order) {
        const item = state.items[id];
        if (!item) continue;
        if ((item.type === 'image' || item.type === 'file' || item.type === 'video' || item.type === 'audio') && (item as any).assetId) {
            ids.add((item as any).assetId as string);
        }
    }
    return Array.from(ids);
}

function buildAssetPayload(state: CanvasState): AssetPayload[] {
    const ids = collectReferencedAssetIds(state);
    const entries = listAssetsForIds(ids);
    return entries.map(e => ({
        path: `assets/${e.id}`,
        base64: bytesToBase64(e.bytes),
    }));
}

/**
 * Build the complete v4 write payload from current canvas state.
 *
 * Asset paths in v4 currently stay as `assets/<assetId>` for compatibility
 * with the existing renderer-side asset registry — content-addressing by sha
 * is a Phase 1.5 follow-up. The structural change (per-item files + manifest)
 * is what v4 buys today; dedup-by-sha is independent and lands later.
 */
function buildV4Payload(state: CanvasState, title: string, opts?: { createdAt?: string }): {
    manifestJson: string;
    canvasJson: string;
    items: Record<string, string>;
    assets: AssetPayload[];
} {
    const payload = serializeV4(state, {
        title,
        createdAt: opts?.createdAt,
        deviceId: getDeviceId(),
    });
    // Attach asset payloads inline so finalizePayload's stats are accurate.
    const assets = buildAssetPayload(state);
    payload.assets = assets.map(a => ({
        path: a.path,
        // serializeV4's payload expects Uint8Array bytes; finalizePayload only
        // needs the lengths. We synthesize byte-shaped entries here so stats
        // compute correctly — the IPC transport uses the base64 form below.
        bytes: new Uint8Array(Math.ceil(a.base64.length * 0.75)),
        sha: '',
    }));
    finalizePayload(payload);

    return {
        manifestJson: JSON.stringify(payload.manifest),
        canvasJson: JSON.stringify(payload.canvasJson),
        items: Object.fromEntries(
            Object.entries(payload.items).map(([key, val]) => [key, JSON.stringify(val)])
        ),
        assets,
    };
}

/**
 * Apply a load result (v3 or v4) to the canvas state. Returns the dispatch
 * action shape so callers can compose it with their own pre/post logic.
 *
 * The discriminator is `formatVersion`. Missing/undefined → treat as v3 for
 * back-compat with any caller that hasn't been updated yet.
 */
function applyLoadResult(
    res: LoadResult,
    dispatch: (action: any) => void,
    stateRef: React.MutableRefObject<CanvasState>,
): { ok: boolean; error?: string } {
    if (!res.ok) return { ok: false, error: 'error' in res ? res.error : 'load failed' };

    try {
        clearAssetsForIds(collectReferencedAssetIds(stateRef.current));
        hydrateAssetRegistry(res.assets);

        if (res.formatVersion === 'v4') {
            const manifest: KlypixManifest = JSON.parse(res.manifest);
            const canvasJson = JSON.parse(res.canvasJson);
            const result = deserializeV4({
                manifest,
                canvasJson,
                // Eager: read every item's content from the items map main returned.
                // Phase 1.5 will swap this for a lazy fetcher (viewport-driven).
                fetchItem: (id) => {
                    const raw = res.items[id];
                    return raw ? JSON.parse(raw) : undefined;
                },
            });
            const itemMap: Record<string, CanvasItem> = {};
            for (const it of result.items) itemMap[it.id] = it;
            const connMap: Record<string, Connection> = {};
            for (const c of (result.connections || [])) connMap[c.id] = c;
            const lineMap: Record<string, DrawnLine> = {};
            for (const l of (result.lines || [])) lineMap[l.id] = l;
            const strokeMap: Record<string, FreehandStroke> = {};
            for (const s of (result.strokes || [])) strokeMap[s.id] = s;
            dispatch({
                type: 'LOAD_FILE',
                items: itemMap,
                order: result.order,
                connections: connMap,
                lines: lineMap,
                strokes: strokeMap,
                view: result.view,
                filePath: res.filePath,
                title: result.title || titleFromPath(res.filePath),
                nextGroupNumber: result.nextGroupNumber,
            });
            return { ok: true };
        }

        // v3 / legacy path — same shape we've handled forever.
        const json = res.formatVersion === 'v3' ? res.json : (res as any).json;
        if (!json) return { ok: false, error: 'missing canvas.json' };
        const doc: CanvasDocumentV3 = deserialize(json);
        const itemMap: Record<string, CanvasItem> = {};
        for (const it of doc.items) itemMap[it.id] = it;
        const connMap: Record<string, Connection> = {};
        for (const c of (doc.connections || [])) connMap[c.id] = c;
        const lineMap: Record<string, DrawnLine> = {};
        for (const l of (doc.lines || [])) lineMap[l.id] = l;
        const strokeMap: Record<string, FreehandStroke> = {};
        for (const s of (doc.strokes || [])) strokeMap[s.id] = s;
        dispatch({
            type: 'LOAD_FILE',
            items: itemMap,
            order: doc.order,
            connections: connMap,
            lines: lineMap,
            strokes: strokeMap,
            view: doc.view,
            filePath: res.filePath,
            title: doc.title || titleFromPath(res.filePath),
            nextGroupNumber: doc.nextGroupNumber,
        });
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// Hydrate the renderer registry from the bytes returned by main on load.
// path is "assets/<assetId>" — we strip the prefix to recover the id, which
// is what items reference. The caller releases the tab's existing asset refs
// BEFORE calling this (see release-before-load in open/openByPath); we don't
// wipe the whole registry here because other tabs depend on it.
function hydrateAssetRegistry(assets: LoadedAssetPayload[] | undefined): void {
    if (!assets) return;
    for (const a of assets) {
        if (!a.path.startsWith('assets/')) continue;
        const id = a.path.slice('assets/'.length);
        if (!id) continue;
        // assetId carries the extension; if it doesn't, fall back to mime.
        const dot = id.lastIndexOf('.');
        const extension = dot >= 0 ? id.slice(dot + 1) : '';
        const mime = a.mime || mimeFromExtension(extension);
        try {
            registerAsset({
                id,
                mime,
                extension,
                bytes: base64ToBytes(a.base64),
            });
        } catch (err) {
            console.warn('[canvas] failed to hydrate asset', id, err);
        }
    }
}

function getApi(): CanvasApi | null {
    const e = (window as any).electron;
    return e?.canvas || null;
}

// tabActive: whether this tab is currently shown. When false, suppress global
// side effects that would otherwise fire once per inactive tab (the OS-launched
// file-opened listener; autosave restoration). Autosave-to-disk still runs per
// tab since each tab has its own filePath and shouldn't stall while hidden.
export function useAnyFile(tabActive = true) {
    const { state, dispatch } = useCanvasStore();
    const stateRef = useRef(state);
    stateRef.current = state;

    const newFile = useCallback(() => {
        const s = stateRef.current;
        if (s.isDirty) {
            const ok = window.confirm('Discard unsaved changes and start a new canvas?');
            if (!ok) return false;
        }
        // Release only this tab's asset refs; other tabs keep their own.
        clearAssetsForIds(collectReferencedAssetIds(s));
        dispatch({ type: 'NEW_FILE' });
        return true;
    }, [dispatch]);

    const doSave = useCallback(async (): Promise<{ ok: boolean; cancelled?: boolean }> => {
        const api = getApi();
        if (!api?.save || !api?.saveAs) return { ok: false };
        const s = stateRef.current;

        // Dispatch by extension: .klypix paths get the v4 writer, .any (and any
        // path without an extension yet) gets the v3 writer for legacy round-trip.
        // The Save-As default extension is .klypix, so new canvases naturally
        // land in v4. Existing .any files saved with Save() keep their format
        // until the user explicitly Save-As's them.
        if (s.filePath && isKlypixPath(s.filePath)) {
            if (!api.saveKlypix) return { ok: false };
            const v4 = buildV4Payload(s, s.title);
            const res = await api.saveKlypix({ filePath: s.filePath, ...v4 });
            if (res.ok) {
                dispatch({ type: 'SET_DIRTY', dirty: false });
                return { ok: true };
            }
            return { ok: false };
        }

        if (s.filePath) {
            // Legacy .any file → keep using v3 writer so we don't surprise the user.
            const doc = serialize(s, s.title);
            const json = JSON.stringify(doc);
            const assets = buildAssetPayload(s);
            const res = await api.save({ filePath: s.filePath, json, assets });
            if (res.ok) {
                dispatch({ type: 'SET_DIRTY', dirty: false });
                return { ok: true };
            }
            return { ok: false };
        }

        // No path yet → prompt save-as in the v4 channel (new canvases go v4).
        if (!api.saveKlypixAs) {
            // Fallback for environments without v4 IPC wired (shouldn't happen post-rebrand).
            const doc = serialize(s, s.title);
            const json = JSON.stringify(doc);
            const assets = buildAssetPayload(s);
            const res = await api.saveAs({ json, defaultName: `${s.title || 'untitled'}.klypix`, assets });
            if (res.ok && res.filePath) {
                dispatch({ type: 'SET_FILE_PATH', filePath: res.filePath, title: titleFromPath(res.filePath) });
                dispatch({ type: 'SET_DIRTY', dirty: false });
                return { ok: true };
            }
            return { ok: false, cancelled: res.cancelled };
        }
        const v4 = buildV4Payload(s, s.title);
        const res = await api.saveKlypixAs({ defaultName: `${s.title || 'untitled'}.klypix`, ...v4 });
        if (res.ok && res.filePath) {
            dispatch({ type: 'SET_FILE_PATH', filePath: res.filePath, title: titleFromPath(res.filePath) });
            dispatch({ type: 'SET_DIRTY', dirty: false });
            return { ok: true };
        }
        return { ok: false, cancelled: res.cancelled };
    }, [dispatch]);

    const saveAs = useCallback(async (): Promise<{ ok: boolean; cancelled?: boolean }> => {
        const api = getApi();
        if (!api?.saveAs && !api?.saveKlypixAs) return { ok: false };
        const s = stateRef.current;

        // Save-As always defaults to .klypix (v4) — that's the rebrand promise.
        // The user can still pick .any from the dialog filter; the file gets
        // written in v4 layout either way (we don't have v3-writer-with-klypix
        // because v3 is legacy-only on the read path now).
        if (api.saveKlypixAs) {
            const v4 = buildV4Payload(s, s.title);
            const res = await api.saveKlypixAs({ defaultName: `${s.title || 'untitled'}.klypix`, ...v4 });
            if (res.ok && res.filePath) {
                dispatch({ type: 'SET_FILE_PATH', filePath: res.filePath, title: titleFromPath(res.filePath) });
                dispatch({ type: 'SET_DIRTY', dirty: false });
                return { ok: true };
            }
            return { ok: false, cancelled: res.cancelled };
        }
        // Fallback: legacy v3 if v4 IPC isn't available.
        if (!api.saveAs) return { ok: false };
        const doc = serialize(s, s.title);
        const json = JSON.stringify(doc);
        const assets = buildAssetPayload(s);
        const res = await api.saveAs({ json, defaultName: `${s.title || 'untitled'}.klypix`, assets });
        if (res.ok && res.filePath) {
            dispatch({ type: 'SET_FILE_PATH', filePath: res.filePath, title: titleFromPath(res.filePath) });
            dispatch({ type: 'SET_DIRTY', dirty: false });
            return { ok: true };
        }
        return { ok: false, cancelled: res.cancelled };
    }, [dispatch]);

    const open = useCallback(async (): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> => {
        const api = getApi();
        if (!api?.open) return { ok: false, error: 'canvas IPC unavailable' };
        const s = stateRef.current;
        if (s.isDirty) {
            const ok = window.confirm('Discard unsaved changes and open another canvas?');
            if (!ok) return { ok: false, cancelled: true };
        }
        const res = await api.open();
        if (!res.ok) return { ok: false, cancelled: 'cancelled' in res ? res.cancelled : undefined, error: 'error' in res ? res.error : undefined };
        return applyLoadResult(res, dispatch, stateRef);
    }, [dispatch]);

    // Open directly by path (used by file-association + recent-files flows).
    const openByPath = useCallback(async (filePath: string): Promise<{ ok: boolean; error?: string }> => {
        const api = getApi();
        if (!api?.openByPath) return { ok: false, error: 'canvas IPC unavailable' };
        const res = await api.openByPath(filePath);
        if (!res.ok) return { ok: false, error: 'error' in res ? res.error : undefined };
        return applyLoadResult(res, dispatch, stateRef);
    }, [dispatch]);

    // Subscribe to file-association events — OS-launched .any paths. Only the
    // active tab handles these so a single OS open-file doesn't fan out to
    // every mounted tab. Multi-tab open-in-new-tab is a follow-up.
    useEffect(() => {
        if (!tabActive) return;
        const api = getApi();
        if (!api?.onFileOpened) return;
        const off = api.onFileOpened((path) => {
            if (stateRef.current.isDirty) {
                const ok = window.confirm('Open the requested canvas? Unsaved changes will be lost.');
                if (!ok) return;
            }
            openByPath(path);
        });
        return off;
    }, [openByPath, tabActive]);

    // --- 30s autosave loop ---
    // Saves to the file path when one exists. Otherwise writes a crash-recovery
    // snapshot to %APPDATA%/klypix/autosave/untitled.any so nothing is lost if
    // the app dies before the user saves.
    useEffect(() => {
        if (!state.isDirty) return;
        const timer = setTimeout(async () => {
            if (!stateRef.current.isDirty) return;
            if (stateRef.current.filePath) {
                doSave();
            } else {
                const api = getApi();
                if (api?.autosave) {
                    const doc = serialize(stateRef.current, stateRef.current.title);
                    const assets = buildAssetPayload(stateRef.current);
                    api.autosave({ json: JSON.stringify(doc), assets }).catch(() => {});
                }
            }
        }, 30_000);
        return () => clearTimeout(timer);
    }, [state.filePath, state.isDirty, doSave]);

    // Clear the crash-recovery slot when the user saves to a real file.
    useEffect(() => {
        if (state.filePath && !state.isDirty) {
            const api = getApi();
            api?.clearAutosave?.().catch(() => {});
        }
    }, [state.filePath, state.isDirty]);

    // Recent-canvases tracking. Record every saved file path + title pair so
    // the dashboard can list them. Fires on path change (open/save-as) and
    // on title change (rename). Touching the title alone bumps lastOpened
    // too, which is the right UX — that canvas is "current."
    useEffect(() => {
        if (!state.filePath) return;
        recordCanvasAccess({ filePath: state.filePath, title: state.title || titleFromPath(state.filePath) });
    }, [state.filePath, state.title]);

    // Embed subsystem (Phase 3) cleanup. Stop watching files for THIS canvas
    // when either the canvas's file path changes (user opened a different
    // canvas in this tab) or the component unmounts (tab closed). Keep
    // working files on disk (deleteWorkingDir=false) so a quick reopen warms
    // the cache; a janitor task can sweep them later if disk usage matters.
    useEffect(() => {
        const prevPath = state.filePath;
        return () => {
            if (!prevPath) return;
            const api = getApi();
            api?.embedCleanupCanvas?.(prevPath, false).catch(() => {});
        };
    }, [state.filePath]);

    // restoreSettled gates anything that needs to wait until the autosave
    // restore decision (dialog + any subsequent load) has fully resolved —
    // e.g. the chat→canvas drain that mustn't add cards before the user has
    // chosen to restore a previous session. Resets on tabActive flip so a
    // re-activation re-checks autosave (cheap; the dialog is gated by the
    // empty-state check, so it doesn't double-prompt on routine switches).
    const [restoreSettled, setRestoreSettled] = useState(false);

    // On mount: check for an autosave snapshot and offer to restore. Only the
    // initial (active) tab prompts — otherwise spawning a second tab would
    // re-prompt for the same recovery snapshot.
    useEffect(() => {
        if (!tabActive) {
            setRestoreSettled(false);
            return;
        }
        const api = getApi();
        if (!api?.checkAutosave || !api?.openByPath) {
            setRestoreSettled(true);
            return;
        }
        let cancelled = false;
        api.checkAutosave().then(async res => {
            if (cancelled) return;
            if (!res.exists || !res.path) {
                setRestoreSettled(true);
                return;
            }
            if (stateRef.current.order.length === 0) {
                const ok = window.confirm(`Unsaved canvas found from a previous session. Restore?`);
                if (ok) {
                    // Await openByPath so the drain doesn't run mid-load and
                    // get its items wiped by the subsequent RESTORE action.
                    await openByPath(res.path);
                } else {
                    await api.clearAutosave?.();
                }
            }
            if (!cancelled) setRestoreSettled(true);
        }).catch(() => {
            if (!cancelled) setRestoreSettled(true);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabActive]);

    return { newFile, save: doSave, saveAs, open, openByPath, restoreSettled };
}
