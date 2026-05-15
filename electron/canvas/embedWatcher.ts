import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { shell } from 'electron';
import JSZip from 'jszip';

// Embed subsystem v0 — extract embedded asset to a canvas-scoped working dir,
// launch in the default OS app, watch for saves, re-pack into the .klypix.
//
// "Working dir" lives at:
//   %LOCALAPPDATA%/klypix/working/<canvas-id-hash>/<item-id>/<filename>
//
// We hash the canvas's absolute file path to derive a stable per-canvas dir
// so reopening the same canvas hits the same working location (warm cache),
// while different canvases never collide. Per-item subdir keeps multiple
// embedded files in one canvas isolated from each other.
//
// Watcher uses Node's built-in fs.watch — good enough for v0. Edge cases
// (rename-on-save, antivirus locks) are mitigated by:
//   - 1.5s debounce after the last change event before re-packing
//   - retry-with-backoff on EBUSY (3 attempts over 5s)
//   - ignore lock files matching ~$* (Word's pattern)
// chokidar can replace fs.watch in v0.5 if we hit reliability problems.

// ── Paths ─────────────────────────────────────────────────────────────

const WORKING_ROOT = path.join(os.homedir(), 'AppData', 'Local', 'klypix', 'working');

function canvasIdFromPath(canvasFilePath: string): string {
    // sha256 of the absolute canvas path. Stable across sessions, unique per
    // canvas, opaque enough that two different canvases with similar names
    // don't accidentally share state.
    return crypto.createHash('sha256').update(path.resolve(canvasFilePath)).digest('hex').slice(0, 16);
}

function workingDirFor(canvasFilePath: string, itemId: string): string {
    return path.join(WORKING_ROOT, canvasIdFromPath(canvasFilePath), itemId);
}

function safeFileName(name: string): string {
    return (name || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
}

// ── State: active watchers indexed by working-file path ───────────────

interface ActiveWatch {
    canvasFilePath: string;
    itemId: string;
    /** Asset path INSIDE the .klypix zip (e.g. "assets/<assetId>"). */
    assetPath: string;
    workingPath: string;
    watcher: fs.FSWatcher;
    /** Pending debounced re-pack timer. */
    debounceTimer: NodeJS.Timeout | null;
    /** Set when a re-pack is in flight so we don't race two writes to the same .klypix. */
    repackInFlight: boolean;
    /** Set if a change event fired DURING an in-flight re-pack — triggers a follow-up. */
    repackQueued: boolean;
}

const active = new Map<string, ActiveWatch>(); // key: workingPath

// Callback invoked on every re-pack lifecycle event (syncing/synced/error).
// main.ts wires this to forward via webContents.send so the renderer can
// update its UI badges.
let onEmbedEvent: ((evt: EmbedEvent) => void) | null = null;

export interface EmbedEvent {
    itemId: string;
    canvasFilePath: string;
    kind: 'syncing' | 'synced' | 'error';
    error?: string;
}

export function setEmbedEventSink(sink: (evt: EmbedEvent) => void): void {
    onEmbedEvent = sink;
}

function emit(evt: EmbedEvent): void {
    try { onEmbedEvent?.(evt); } catch { /* swallow — never let UI plumbing crash main */ }
}

// ── Open + launch + watch ─────────────────────────────────────────────

export interface OpenAndWatchArgs {
    canvasFilePath: string;
    itemId: string;
    /** Asset path INSIDE the .klypix zip (e.g. "assets/<assetId>"). */
    assetPath: string;
    fileName: string;
    /** Raw bytes of the asset (the caller already has them — no need to re-read the zip). */
    base64: string;
}

export interface OpenAndWatchResult {
    ok: boolean;
    workingPath?: string;
    error?: string;
}

/**
 * Extract the asset to its canvas-scoped working location, launch it in the
 * OS default app, and start watching for saves. Subsequent saves trigger
 * re-pack into the .klypix.
 */
export async function openAndWatch(args: OpenAndWatchArgs): Promise<OpenAndWatchResult> {
    if (!args.canvasFilePath) {
        return { ok: false, error: 'cannot embed-edit without a saved canvas (Save the canvas first)' };
    }
    try {
        const dir = workingDirFor(args.canvasFilePath, args.itemId);
        await fs.promises.mkdir(dir, { recursive: true });
        const workingPath = path.join(dir, safeFileName(args.fileName));

        // Write the bytes. If the working file already exists (re-open within
        // the same session), we still overwrite — the .klypix is authoritative.
        // Future enhancement: detect "user has unsaved local edits" and prompt.
        await fs.promises.writeFile(workingPath, Buffer.from(args.base64, 'base64'));

        // If a watcher already exists for this path (re-open in same session),
        // tear it down before creating a fresh one so we don't double-fire.
        const existing = active.get(workingPath);
        if (existing) {
            existing.watcher.close();
            if (existing.debounceTimer) clearTimeout(existing.debounceTimer);
            active.delete(workingPath);
        }

        const watcher = fs.watch(workingPath, { persistent: false }, (eventType) => {
            // fs.watch fires for both 'change' and 'rename'. Office apps
            // atomic-save = delete-then-create which surfaces as rename
            // followed by change. Either way we debounce + re-read.
            handleChangeEvent(workingPath);
            void eventType;
        });

        const entry: ActiveWatch = {
            canvasFilePath: args.canvasFilePath,
            itemId: args.itemId,
            assetPath: args.assetPath,
            workingPath,
            watcher,
            debounceTimer: null,
            repackInFlight: false,
            repackQueued: false,
        };
        active.set(workingPath, entry);

        // Launch the OS default app. Errors here are non-fatal — extraction
        // already succeeded; the user can open the file manually from the
        // working dir if needed.
        const launchErr = await shell.openPath(workingPath);
        if (launchErr) {
            console.warn('[embed] shell.openPath failed:', launchErr, '— file is extracted but not launched');
        }

        return { ok: true, workingPath };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// ── Change handler + re-pack ──────────────────────────────────────────

function handleChangeEvent(workingPath: string): void {
    const entry = active.get(workingPath);
    if (!entry) return;

    // Ignore lock-file events. Word creates ~$Document.docx; Excel ~$Book.xlsx.
    // Those flash in/out during a save and aren't user-meaningful.
    if (path.basename(workingPath).startsWith('~$')) return;

    // Debounce: Office apps atomic-write with multiple events in quick
    // succession. Re-packing on every event would corrupt the zip mid-save.
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        void repackEntry(entry);
    }, 1500);
}

async function repackEntry(entry: ActiveWatch, attempt = 0): Promise<void> {
    // Coalesce concurrent re-pack requests: if one is in flight, mark a
    // follow-up and let the current run handle the freshest bytes when done.
    if (entry.repackInFlight) {
        entry.repackQueued = true;
        return;
    }
    entry.repackInFlight = true;

    try {
        // Confirm the working file still exists. Word's atomic-save briefly
        // deletes the file mid-rename; an early read here would fail. If
        // missing, give it 200ms and re-check before giving up.
        if (!fs.existsSync(entry.workingPath)) {
            await new Promise(r => setTimeout(r, 200));
            if (!fs.existsSync(entry.workingPath)) {
                emit({ itemId: entry.itemId, canvasFilePath: entry.canvasFilePath, kind: 'error', error: 'working file disappeared' });
                return;
            }
        }

        emit({ itemId: entry.itemId, canvasFilePath: entry.canvasFilePath, kind: 'syncing' });

        // Read the modified bytes.
        const newBytes = await fs.promises.readFile(entry.workingPath);

        // Open the canvas zip, replace the asset entry, write back atomically.
        // We don't touch any other entry — the rest of the zip flows through
        // jszip's cached compressed bytes unchanged (same trick anyFileHandler
        // uses for v3 saves).
        const canvasBytes = await fs.promises.readFile(entry.canvasFilePath);
        const zip = await JSZip.loadAsync(canvasBytes);

        // Sanity check: the asset path we're updating must already exist in the
        // zip. If it doesn't, the canvas was probably reset/migrated under us;
        // adding a fresh entry is still the right move (the renderer's asset
        // registry has the canonical state).
        zip.file(entry.assetPath, newBytes);

        const buf = await zip.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });

        // Atomic rename: write .tmp, then replace. Never half-write the user's canvas.
        const tmpPath = entry.canvasFilePath + '.embed.tmp';
        await fs.promises.writeFile(tmpPath, buf);
        await fs.promises.rename(tmpPath, entry.canvasFilePath);

        emit({ itemId: entry.itemId, canvasFilePath: entry.canvasFilePath, kind: 'synced' });
    } catch (err: any) {
        const msg = err?.message || String(err);
        // EBUSY / EPERM = file locked (antivirus scanning, Word holding it,
        // OneDrive sync). Retry with backoff up to 3 times over ~5s before
        // surfacing the error.
        const isBusy = /EBUSY|EPERM|ENOENT/i.test(msg);
        if (isBusy && attempt < 3) {
            const delayMs = 500 * (attempt + 1) * (attempt + 1);
            console.warn(`[embed] re-pack busy (attempt ${attempt + 1}), retrying in ${delayMs}ms:`, msg);
            await new Promise(r => setTimeout(r, delayMs));
            entry.repackInFlight = false;
            return repackEntry(entry, attempt + 1);
        }
        console.error('[embed] re-pack failed:', err);
        emit({ itemId: entry.itemId, canvasFilePath: entry.canvasFilePath, kind: 'error', error: msg });
    } finally {
        entry.repackInFlight = false;
        // If a change fired during this re-pack, run another pass with the latest bytes.
        if (entry.repackQueued) {
            entry.repackQueued = false;
            setTimeout(() => repackEntry(entry), 200);
        }
    }
}

// ── Stop watching ─────────────────────────────────────────────────────

/** Stop watching a specific working file. Used when an embed card is removed
 *  or when the canvas closes. Working files are NOT deleted — keeping them
 *  lets a re-open within the session warm-cache. Cleanup is on canvas close
 *  (see cleanupCanvas). */
export function stopWatching(workingPath: string): void {
    const entry = active.get(workingPath);
    if (!entry) return;
    entry.watcher.close();
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    active.delete(workingPath);
}

/** Stop all watchers for a given canvas file, optionally deleting the
 *  working dir to reclaim disk. Called when the canvas tab closes. */
export async function cleanupCanvas(canvasFilePath: string, deleteWorkingDir = false): Promise<void> {
    for (const [workingPath, entry] of active.entries()) {
        if (entry.canvasFilePath === canvasFilePath) {
            stopWatching(workingPath);
        }
    }
    if (deleteWorkingDir) {
        const dir = path.join(WORKING_ROOT, canvasIdFromPath(canvasFilePath));
        try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
