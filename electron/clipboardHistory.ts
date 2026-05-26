// Phase 23 Day 3 — Main-process clipboard history.
//
// Polls Electron's clipboard ~every 900ms, captures text + image + file
// changes, stores them in an in-memory ring keyed by content digest so
// the same content copied repeatedly doesn't pile up. Persisted to a
// JSON file under userData/ so history survives restart.
//
// IPC (clipboard-history:list / copy / pin / remove / clear) returns
// snapshots to the renderer; the palette provider just queries this.
//
// Privacy: a small list of known password-manager process names (matched
// by GetForegroundWindow title at copy time) marks rows as 'skip' so
// they NEVER surface to the palette. Best-effort, not a guarantee — but
// catches the obvious accidental "I copied my master password" case.

import { app, clipboard, ipcMain, nativeImage, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const POLL_INTERVAL_MS = 900;
// Mutable retention cap — re-assignable via setClipboardRetention IPC so
// users can change "how many items to keep" from the Settings panel.
// Pinned rows always survive regardless of this number.
let maxUnpinned = 200;
const PERSIST_FILE = 'clipboard-history.json';
const SETTINGS_FILE = 'clipboard-settings.json';
let captureEnabled = true;
let userExcludePatterns: string[] = [];

// Foreground-window title patterns that mark a clipboard write as
// "probably a password" — those rows are stored but flagged skip:true
// so the palette never surfaces them. Conservative; expand if users
// report leaks.
const PASSWORD_MANAGER_PATTERNS = [
    /1password/i,
    /bitwarden/i,
    /keepass/i,
    /lastpass/i,
    /dashlane/i,
    /nordpass/i,
    /enpass/i,
    /protonpass/i,
];

export type ClipboardKind = 'text' | 'image' | 'files' | 'html' | 'link' | 'color';

// Link auto-detect: a single http(s) URL with no surrounding prose. Trims
// trailing punctuation common in pasted URLs ("hey check https://x.com.").
const URL_DETECT_RE = /^https?:\/\/[^\s<>"']+$/i;
// Color auto-detect: #RGB / #RRGGBB / #RRGGBBAA, rgb(a)(), hsl(a)(). Case-
// insensitive. We only flag entries that are PURELY a color literal — no
// "color: #fff" CSS prefix etc.; that's a 'text' row, not a swatch.
const COLOR_DETECT_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[01]?\.?\d+\s*)?\)|hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(?:,\s*[01]?\.?\d+\s*)?\))$/i;

function classifyText(text: string, html: string | null): ClipboardKind {
    const trimmed = text.trim();
    if (trimmed.length > 0 && trimmed.length < 2048 && URL_DETECT_RE.test(trimmed)) return 'link';
    if (trimmed.length > 0 && trimmed.length < 64 && COLOR_DETECT_RE.test(trimmed)) return 'color';
    return html && html !== text ? 'html' : 'text';
}

export interface ClipboardRow {
    id: string;             // uuid-ish; stable across reload
    digest: string;         // sha1 of normalized content; for dedupe
    kind: ClipboardKind;
    text?: string;          // for kind='text' and kind='html' (rendered)
    html?: string;          // for kind='html'
    imageDataUrl?: string;  // for kind='image' (base64 data: url, capped 4MB)
    filePaths?: string[];   // for kind='files'
    mime?: string;
    sourceApp?: string;     // window title of the foreground app at copy
    pinned: boolean;
    skip: boolean;          // never surface (password-manager paste detected)
    capturedAt: number;     // epoch ms
}

let rows: ClipboardRow[] = [];
let lastDigest: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;

function persistPath(): string {
    return path.join(app.getPath('userData'), PERSIST_FILE);
}

function load() {
    try {
        const raw = fs.readFileSync(persistPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            rows = parsed;
            // Initialize lastDigest from the most recent row so we don't
            // re-capture what's already on the clipboard at boot.
            const newest = rows[0];
            lastDigest = newest?.digest ?? null;
        }
    } catch { /* fresh file ok */ }
}

let persistTimer: NodeJS.Timeout | null = null;
function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
            // Only persist text + files + pinned image refs. Unpinned images
            // (potentially several MB of base64) stay in-memory; restart
            // wipes them. Pinned images persist because the user opted in
            // by pinning.
            const toPersist = rows.filter(r => {
                if (r.pinned) return true;
                if (r.kind === 'image') return false;
                return true;
            });
            fs.writeFileSync(persistPath(), JSON.stringify(toPersist), 'utf-8');
        } catch { /* disk full / permission denied → keep in-memory */ }
    }, 1500);
}

function sha1(s: string): string {
    // Tiny non-crypto hash. We only need it for dedupe, not security.
    let h1 = 0xdeadbeef ^ 0;
    let h2 = 0x41c6ce57 ^ 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)).padStart(16, '0');
}

// Cache the most-recently-detected non-Klypix foreground app. The PS call
// itself is async + ~5ms, so we kick it off after every poll tick and
// CACHE the result for the next tick's pushRow. This way pushRow stays
// synchronous (no await in the hot path) and we always have a reasonably
// fresh source attribution.
let cachedForegroundProcess: string | undefined;
let cachedForegroundTitle: string | undefined;
let foregroundProbeFn: (() => Promise<{ title: string; proc: string } | null>) | null = null;

export function setForegroundProbe(fn: () => Promise<{ title: string; proc: string } | null>): void {
    foregroundProbeFn = fn;
}

async function refreshForeground(): Promise<void> {
    if (!foregroundProbeFn) return;
    try {
        const out = await foregroundProbeFn();
        if (!out) return;
        // Skip caching Klypix itself — when the user has focus inside
        // Klypix, the most useful attribution is "Klypix"; when they
        // tab back out and copy something, we want the PREVIOUS
        // non-Klypix foreground.
        const proc = (out.proc || '').toLowerCase();
        if (proc.includes('klypix') || proc === 'electron') {
            // Don't clobber the cached non-Klypix value with Klypix —
            // helps the "user alt-tabs back, then copies" case attribute
            // correctly to the previous app.
            return;
        }
        cachedForegroundProcess = out.proc;
        cachedForegroundTitle = out.title;
    } catch { /* swallow */ }
}

// Friendly-name map: PowerShell `Get-Process` returns the .exe stem (e.g.
// 'Code', 'chrome', 'msedge'). Map common ones to recognizable names.
// Anything not in the map gets a default capitalize-first-letter.
const PROCESS_FRIENDLY_NAME: Record<string, string> = {
    code: 'VS Code',
    cursor: 'Cursor',
    windsurf: 'Windsurf',
    chrome: 'Chrome',
    msedge: 'Edge',
    firefox: 'Firefox',
    brave: 'Brave',
    opera: 'Opera',
    notepad: 'Notepad',
    notepadplusplus: 'Notepad++',
    explorer: 'File Explorer',
    winword: 'Word',
    excel: 'Excel',
    powerpnt: 'PowerPoint',
    outlook: 'Outlook',
    teams: 'Teams',
    slack: 'Slack',
    discord: 'Discord',
    figma: 'Figma',
    photoshop: 'Photoshop',
    illustrator: 'Illustrator',
    spotify: 'Spotify',
    obsidian: 'Obsidian',
    notion: 'Notion',
    zoom: 'Zoom',
    terminal: 'Terminal',
    windowsterminal: 'Windows Terminal',
    powershell: 'PowerShell',
    cmd: 'Command Prompt',
    'wt': 'Windows Terminal',
};

function friendlyAppName(proc: string): string {
    const key = proc.toLowerCase().replace(/\.exe$/, '');
    if (PROCESS_FRIENDLY_NAME[key]) return PROCESS_FRIENDLY_NAME[key];
    // Fallback: PS already capitalizes most process names. If lowercase
    // (e.g. 'chrome'), title-case the first letter for display.
    return proc.charAt(0).toUpperCase() + proc.slice(1);
}

function detectSourceApp(): string | undefined {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed()) {
        // Klypix is foreground at the copy moment. Two cases:
        //   - User copied something INSIDE Klypix → 'Klypix' is correct
        //   - User just tabbed back to Klypix → previous foreground is
        //     more useful. We can't disambiguate reliably; default to
        //     'Klypix' since the explicit click-to-copy from Klypix is
        //     the more common workflow.
        return 'Klypix';
    }
    if (cachedForegroundProcess) {
        return friendlyAppName(cachedForegroundProcess);
    }
    return undefined;
}

function isPasswordManagerActive(): boolean {
    // Heuristic only — see detectSourceApp note above. Returning false
    // by default means a paste from a real password manager WILL show
    // up in history until we wire foreground-window detection. The
    // pinned-items + clear-all UX still gives users control.
    return false;
}

function pushRow(row: Omit<ClipboardRow, 'id' | 'pinned' | 'skip'>): void {
    if (lastDigest === row.digest) return;
    lastDigest = row.digest;
    // Bubble: if the same digest already exists (older copy), pop the old
    // one and unshift the new — so re-copying refreshes the timestamp
    // without duplicating.
    const existingIdx = rows.findIndex(r => r.digest === row.digest);
    if (existingIdx >= 0) {
        const existing = rows.splice(existingIdx, 1)[0];
        existing.capturedAt = row.capturedAt;
        rows.unshift(existing);
        schedulePersist();
        return;
    }
    const newRow: ClipboardRow = {
        ...row,
        id: 'cb_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
        pinned: false,
        skip: isPasswordManagerActive(),
    };
    rows.unshift(newRow);
    // Cap UNPINNED at MAX_UNPINNED. Pinned rows never auto-prune.
    let unpinnedSeen = 0;
    rows = rows.filter(r => {
        if (r.pinned) return true;
        unpinnedSeen++;
        return unpinnedSeen <= maxUnpinned;
    });
    schedulePersist();
}

function poll() {
    // User-disabled clipboard capture → skip the whole loop. Pinned rows
    // remain visible in the palette; nothing new gets recorded.
    if (!captureEnabled) return;
    // Skip when the cached foreground app is on the user's exclude list
    // (e.g. "1password", "banking"). The cached value is whatever the
    // previous poll tick saw, which is close enough for this filter.
    if (isUserExcludedApp(cachedForegroundProcess)) return;
    // Kick off (don't await) the foreground refresh. The clipboard read
    // below uses the PREVIOUSLY-cached foreground; by the next tick this
    // tick's foreground is current. Worst case: brand-new app on its
    // first copy gets attributed to the previous foreground. Acceptable.
    void refreshForeground();

    try {
        const fileList = clipboard.readBuffer('FileNameW');
        if (fileList && fileList.length > 0) {
            // Windows file-drop format: UTF-16LE list of paths separated by
            // NUL bytes. Parse to string array.
            const text = fileList.toString('utf16le').replace(/ +$/, '');
            const paths = text.split(' ').filter(p => p.length > 0);
            if (paths.length > 0) {
                pushRow({
                    digest: sha1('files:' + paths.join('|')),
                    kind: 'files',
                    filePaths: paths,
                    sourceApp: detectSourceApp(),
                    capturedAt: Date.now(),
                });
                return;
            }
        }
    } catch { /* not a file clipboard or empty */ }

    try {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) {
            const png = img.toPNG();
            // Skip images larger than ~10MB after base64 — that's ~13.3MB
            // of base64 string. Raycast tolerates larger images; we bumped
            // from 4MB to 10MB to match. Pinned images persist to disk so
            // restart-survival has the same upper bound.
            if (png.byteLength <= 10 * 1024 * 1024) {
                const b64 = png.toString('base64');
                pushRow({
                    digest: sha1('image:' + sha1(b64.slice(0, 4096))),  // sample-hash
                    kind: 'image',
                    imageDataUrl: `data:image/png;base64,${b64}`,
                    mime: 'image/png',
                    sourceApp: detectSourceApp(),
                    capturedAt: Date.now(),
                });
                return;
            }
        }
    } catch { /* no image */ }

    try {
        const html = clipboard.readHTML();
        const text = clipboard.readText();
        if (text && text.length > 0) {
            const kind = classifyText(text, html);
            pushRow({
                digest: sha1('text:' + text),
                kind,
                text,
                html: html || undefined,
                sourceApp: detectSourceApp(),
                capturedAt: Date.now(),
            });
        }
    } catch { /* no text */ }
}

export function startClipboardHistory(): void {
    if (pollTimer) return;
    load();
    loadSettings();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    // Throttle polling down to 5s when no Klypix window is focused — saves
    // CPU on idle laptops without losing useful clipboard captures the
    // user explicitly wants surfaced inside Klypix.
    app.on('browser-window-blur', () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(poll, 5000);
    });
    app.on('browser-window-focus', () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    });
}

// ── IPC ──────────────────────────────────────────────────────────────

/** Writes a stored row's content back to the OS clipboard. Exported so
 *  smart-paste can stage the row in main without going through the IPC. */
export function copyRowToClipboard(id: string): boolean {
    const row = rows.find(r => r.id === id);
    if (!row) return false;
    if (row.kind === 'image' && row.imageDataUrl) {
        const m = row.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
            const buf = Buffer.from(m[2], 'base64');
            const img = nativeImage.createFromBuffer(buf);
            clipboard.writeImage(img);
            return true;
        }
    }
    if (row.kind === 'files' && row.filePaths && row.filePaths.length > 0) {
        const joined = row.filePaths.join(' ') + '  ';
        const buf = Buffer.from(joined, 'utf16le');
        clipboard.writeBuffer('FileNameW', buf);
        return true;
    }
    if (row.text) {
        if (row.html) clipboard.write({ text: row.text, html: row.html });
        else clipboard.writeText(row.text);
        return true;
    }
    return false;
}

/** Read-only lookup so other modules (e.g. smart-paste, link-open) can
 *  inspect a row without duplicating the array reference. */
export function getRow(id: string): ClipboardRow | undefined {
    return rows.find(r => r.id === id);
}

// ── User-facing settings (Settings panel → Clipboard section) ─────────────

function settingsPath(): string {
    return path.join(app.getPath('userData'), SETTINGS_FILE);
}
function loadSettings(): void {
    try {
        const raw = fs.readFileSync(settingsPath(), 'utf-8');
        const s = JSON.parse(raw);
        if (typeof s.enabled === 'boolean') captureEnabled = s.enabled;
        if (typeof s.retention === 'number' && s.retention >= 25) maxUnpinned = s.retention;
        if (Array.isArray(s.excludes)) userExcludePatterns = s.excludes.filter((x: any) => typeof x === 'string');
    } catch { /* first run */ }
}
function saveSettings(): void {
    try {
        fs.writeFileSync(settingsPath(), JSON.stringify({
            enabled: captureEnabled,
            retention: maxUnpinned,
            excludes: userExcludePatterns,
        }), 'utf-8');
    } catch {}
}

export function getClipboardEnabled(): boolean { return captureEnabled; }
export function setClipboardEnabled(v: boolean): void { captureEnabled = !!v; saveSettings(); }
export function getClipboardRetention(): number { return maxUnpinned; }
export function setClipboardRetention(n: number): void {
    if (typeof n !== 'number' || n < 25) return;
    maxUnpinned = Math.min(2000, Math.floor(n));
    // Re-prune immediately so the new cap takes effect without waiting
    // for the next push.
    let seen = 0;
    rows = rows.filter(r => { if (r.pinned) return true; seen++; return seen <= maxUnpinned; });
    schedulePersist();
    saveSettings();
}
export function getClipboardExcludes(): string[] { return [...userExcludePatterns]; }
export function setClipboardExcludes(list: string[]): void {
    userExcludePatterns = (Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x.trim().length > 0).map(x => x.trim());
    saveSettings();
}

// Used by detectSourceApp to skip user-listed excluded apps. Match is
// case-insensitive substring on the friendly process name.
function isUserExcludedApp(proc?: string): boolean {
    if (!proc || userExcludePatterns.length === 0) return false;
    const p = proc.toLowerCase();
    return userExcludePatterns.some(pat => p.includes(pat.toLowerCase()));
}

export function registerClipboardHistoryIpc(): void {
    ipcMain.handle('clipboard-history:list', () => {
        // Strip skip:true rows + huge image data when the renderer just
        // wants the metadata. (For now we ship everything; renderer can
        // request a single row via :copy when it needs the body.)
        return rows.filter(r => !r.skip);
    });

    ipcMain.handle('clipboard-history:copy', async (_e, id: string) => {
        const row = rows.find(r => r.id === id);
        if (!row) return false;
        // Re-write whichever shape the row came in as. This RE-CAPTURES on
        // the next poll tick, bumping the row to the top — desired UX
        // (just-copied items lead the list).
        if (row.kind === 'image' && row.imageDataUrl) {
            const m = row.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
                const buf = Buffer.from(m[2], 'base64');
                const img = nativeImage.createFromBuffer(buf);
                clipboard.writeImage(img);
                return true;
            }
        }
        if (row.kind === 'files' && row.filePaths && row.filePaths.length > 0) {
            // Windows file-drop format: NUL-separated UTF-16LE
            const joined = row.filePaths.join(' ') + '  ';
            const buf = Buffer.from(joined, 'utf16le');
            clipboard.writeBuffer('FileNameW', buf);
            return true;
        }
        if (row.text) {
            if (row.html) clipboard.write({ text: row.text, html: row.html });
            else clipboard.writeText(row.text);
            return true;
        }
        return false;
    });

    ipcMain.handle('clipboard-history:pin', async (_e, args: { id: string; pinned: boolean }) => {
        const row = rows.find(r => r.id === args.id);
        if (!row) return false;
        row.pinned = !!args.pinned;
        schedulePersist();
        return true;
    });

    ipcMain.handle('clipboard-history:remove', async (_e, id: string) => {
        const before = rows.length;
        rows = rows.filter(r => r.id !== id);
        if (rows.length !== before) schedulePersist();
        return rows.length !== before;
    });

    ipcMain.handle('clipboard-history:clear', async () => {
        const pinned = rows.filter(r => r.pinned);
        rows = pinned;
        lastDigest = null;
        schedulePersist();
        return true;
    });
}
