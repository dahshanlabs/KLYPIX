// Offline OCR model download manager (main process, CommonJS).
//
// Downloads Tesseract .traineddata from the KLYPIX CDN to userData on demand,
// sha256-verifies (when the catalog carries a checksum), writes atomically
// (.part → rename), and reports progress. STT (Whisper) weights are NOT handled
// here — the renderer's transformers.js runtime fetches + caches those itself,
// so nothing heavy ships in the installer.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { OFFLINE_CATALOG, getAsset, type OfflineAsset } from './offlineCatalog';

function offlineDir(): string { return path.join(app.getPath('userData'), 'offline-models'); }
function ocrDir(): string { return path.join(offlineDir(), 'ocr'); }

export type ProgressFn = (p: {
    id: string; phase: 'start' | 'progress' | 'verify' | 'done' | 'error';
    bytesDone?: number; totalBytes?: number; error?: string;
}) => void;

const inFlight = new Map<string, AbortController>();

// ── PDF OCR mode (finally a real home for the previously-dead toggle) ──
let pdfOcrMode: 'gemini' | 'local' = 'gemini';
export function setPdfOcrMode(mode: 'gemini' | 'local') { pdfOcrMode = mode === 'local' ? 'local' : 'gemini'; }
export function getPdfOcrMode(): 'gemini' | 'local' { return pdfOcrMode; }

function fileInstalled(p: string): boolean {
    try { return fs.statSync(p).size > 0; } catch { return false; }
}

/** Which OCR languages are installed on disk (e.g. ['eng','ara']). */
export function getInstalledOcrLangs(): string[] {
    const out: string[] = [];
    for (const a of OFFLINE_CATALOG) {
        if (a.kind !== 'ocr' || !a.langCode) continue;
        if (fileInstalled(path.join(ocrDir(), `${a.langCode}.traineddata`))) out.push(a.langCode);
    }
    return out;
}

/** Directory tesseract's createWorker langPath should point at. */
export function getOcrLangPath(): string { return ocrDir(); }

/** Catalog merged with on-disk install state (OCR) — STT install state is
 *  tracked renderer-side, so STT entries report installed:false here. */
export function getCatalogWithState() {
    const installedOcr = new Set(getInstalledOcrLangs());
    return OFFLINE_CATALOG.map(a => ({
        ...a,
        installed: a.kind === 'ocr' ? !!(a.langCode && installedOcr.has(a.langCode)) : false,
    }));
}

function download(url: string, dest: string, signal: AbortSignal, onBytes: (done: number, total: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // follow one redirect
                res.resume();
                download(res.headers.location, dest, signal, onBytes).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let done = 0;
            const out = fs.createWriteStream(dest);
            res.on('data', (chunk) => { done += chunk.length; onBytes(done, total); });
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
            res.on('error', reject);
        });
        req.on('error', reject);
        signal.addEventListener('abort', () => { req.destroy(new Error('aborted')); }, { once: true });
    });
}

async function sha256File(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', d => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

/** Install an OCR asset (download its .traineddata files to userData). */
export async function install(id: string, onProgress: ProgressFn): Promise<{ ok: boolean; error?: string }> {
    const asset = getAsset(id);
    if (!asset) return { ok: false, error: 'unknown asset' };
    if (asset.kind !== 'ocr') return { ok: false, error: 'stt is installed by the renderer runtime' };
    if (inFlight.has(id)) return { ok: false, error: 'already installing' };
    const ac = new AbortController();
    inFlight.set(id, ac);
    onProgress({ id, phase: 'start' });
    try {
        fs.mkdirSync(ocrDir(), { recursive: true });
        for (const f of asset.files) {
            const finalPath = path.join(ocrDir(), f.name);
            const partPath = finalPath + '.part';
            await download(f.url, partPath, ac.signal, (done, total) => onProgress({ id, phase: 'progress', bytesDone: done, totalBytes: total }));
            if (f.sha256) {
                onProgress({ id, phase: 'verify' });
                const got = await sha256File(partPath);
                if (got.toLowerCase() !== f.sha256.toLowerCase()) {
                    try { fs.rmSync(partPath); } catch { /* ignore */ }
                    throw new Error('checksum mismatch');
                }
            }
            fs.renameSync(partPath, finalPath); // atomic: only a verified file becomes "installed"
        }
        onProgress({ id, phase: 'done' });
        return { ok: true };
    } catch (err: any) {
        const msg = err?.message || String(err);
        onProgress({ id, phase: 'error', error: msg });
        return { ok: false, error: msg };
    } finally {
        inFlight.delete(id);
    }
}

export function remove(id: string): { ok: boolean } {
    const asset = getAsset(id);
    if (asset?.kind === 'ocr' && asset.langCode) {
        try { fs.rmSync(path.join(ocrDir(), `${asset.langCode}.traineddata`)); } catch { /* ignore */ }
    }
    return { ok: true };
}

export { OfflineAsset };
