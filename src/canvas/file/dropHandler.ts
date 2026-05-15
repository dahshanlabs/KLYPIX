import type { CanvasItem, FileItem, ImageItem, VideoItem, AudioItem, CodeItem, CodeLanguage } from '../items/types';
import { newId } from '../items/types';
import * as XLSX from 'xlsx';
import { registerAsset, mimeFromExtension, generateThumbnail } from './assetRegistry';

// Converts a dropped File into a CanvasItem. Images become ImageItems backed
// by an asset (bytes live in the renderer asset registry, written to the .any
// ZIP's assets/ folder on save). Everything else becomes a FileItem card with
// its bytes likewise stored as an asset.

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — bigger than this we downgrade to FileItem
const MAX_MEDIA_BYTES = 500 * 1024 * 1024; // 500 MB cap for inline media — above this we still store as FileItem
const MAX_CODE_BYTES = 256 * 1024;         // inline code cards: 256KB cap

// File extensions that become CodeItem (inline, editable, syntax-highlighted)
// rather than a generic FileItem. Kept tight — things like .csv/.json that
// already get a richer FileItem preview stay as FileItem.
const CODE_EXT_TO_LANG: Record<string, CodeLanguage> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', pyw: 'python',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    md: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml',
    txt: 'text',
};

function getExt(name: string): string {
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

async function imageNaturalSize(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 });
        img.onerror = () => resolve({ w: 300, h: 200 });
        img.src = src;
    });
}

export interface DropTarget {
    x: number;
    y: number;
    zIndexStart: number;
    // Current view zoom — used to compensate the item's world size so
    // it appears at a readable screen size regardless of how far the
    // user is zoomed out when they drop the file.
    viewZoom?: number;
}

/**
 * Convert a single dropped File into a CanvasItem placed at (x, y) world coords.
 * Returns null if the file can't be processed (shouldn't happen for typical drops).
 */
export async function fileToItem(file: File, target: DropTarget, indexOffset = 0): Promise<CanvasItem | null> {
    const ext = getExt(file.name);
    const isImage = IMAGE_EXTS.has(ext) && file.size <= MAX_IMAGE_BYTES;

    // Spread drops slightly so multi-file drops don't stack dead-on top of each other.
    const x = target.x + indexOffset * 24;
    const y = target.y + indexOffset * 24;
    const z = target.zIndexStart + indexOffset;

    // Zoom compensator: at 2% view zoom, a 520-world-px card renders at
    // 10 screen-px — invisible. Dividing the world size by view zoom
    // gives a card that LOOKS ~520 screen-px at any zoom. At 100% zoom
    // the compensator is 1 (no change). If viewZoom is not provided
    // (legacy callers), default to 1.
    const zoomComp = 1 / Math.max(0.01, target.viewZoom ?? 1);

    const baseProps = {
        id: '',
        x,
        y,
        zIndex: z,
        locked: false,
        parentId: null,
        createdAt: Date.now(),
        createdBy: 'user' as const,
    };

    if (isImage) {
        try {
            const buf = new Uint8Array(await file.arrayBuffer());
            const mime = file.type || mimeFromExtension(ext);
            const asset = registerAsset({
                mime,
                extension: ext,
                bytes: buf,
                fileName: file.name,
            });
            // Also generate a 320px downscaled JPEG thumbnail and register
            // it as a sibling asset. ImageItem picks which to show based on
            // current zoom, so a canvas full of images doesn't pin hundreds
            // of MB of full-res bitmaps in GPU memory at low zoom levels.
            let thumbnailAssetId: string | undefined;
            try {
                const thumbBytes = await generateThumbnail(buf, mime, 320);
                if (thumbBytes) {
                    const thumb = registerAsset({
                        mime: 'image/jpeg',
                        extension: 'jpg',
                        bytes: thumbBytes,
                        fileName: `thumb_${file.name}`,
                    });
                    thumbnailAssetId = thumb.id;
                }
            } catch { /* thumbnail is best-effort; skip on failure */ }
            const { w: nw, h: nh } = await imageNaturalSize(asset.blobUrl);
            // Default display size cap balances two concerns:
            //   - a huge image shouldn't fill the canvas when dropped
            //   - scale-up (group resize or zoom-in) shouldn't exceed the
            //     native resolution and become blurry
            // So we cap at min(520, native / 2): default display is at
            // most half the native bytes, giving 2× clean headroom before
            // interpolation kicks in. For small images we fall through
            // to native size (display == native), same as before.
            const MAX_DEFAULT_W = 520;
            const HEADROOM = 2;
            const capW = Math.min(MAX_DEFAULT_W, Math.max(40, nw / HEADROOM));
            const scale = nw > capW ? capW / nw : 1;
            // Compensate for current view zoom so the image looks
            // ~520 screen-px wide at any zoom level. At 100% = normal
            // world size. At 2% = 50× world size → same screen px.
            const vz = Math.max(0.01, target.viewZoom ?? 1);
            const image: ImageItem = {
                ...baseProps,
                id: newId('img'),
                type: 'image',
                w: Math.round((nw * scale) / vz),
                h: Math.round((nh * scale) / vz),
                src: '',                  // legacy fallback; assetId is the new path
                assetId: asset.id,
                thumbnailAssetId,
                originalWidth: nw,
                originalHeight: nh,
                fileName: file.name,
            };
            return image;
        } catch {
            // Fall through to FileItem on read failure.
        }
    }

    // Inline code card for source files we recognize. Keeps them editable and
    // agent-runnable instead of hiding the content behind an icon.
    if (CODE_EXT_TO_LANG[ext] && file.size <= MAX_CODE_BYTES) {
        try {
            const text = await file.text();
            const code: CodeItem = {
                ...baseProps,
                id: newId('code'),
                type: 'code',
                w: Math.round(520 * zoomComp),
                h: Math.round(Math.min(420, Math.max(140, 40 + text.split('\n').length * 17)) * zoomComp),
                code: text,
                language: CODE_EXT_TO_LANG[ext],
                fileName: file.name,
                wrap: false,
            };
            return code;
        } catch { /* fall through to FileItem on read failure */ }
    }

    // Inline video / audio cards stream via a blob URL — we register the bytes
    // as an asset (same as images) so they persist in the .any ZIP. Over the
    // size cap we fall through to a plain FileItem to avoid blowing up the ZIP.
    if ((VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) && file.size <= MAX_MEDIA_BYTES) {
        try {
            const buf = new Uint8Array(await file.arrayBuffer());
            const mime = file.type || mimeFromExtension(ext);
            const asset = registerAsset({ mime, extension: ext, bytes: buf, fileName: file.name });
            let originalPath: string | undefined;
            try { originalPath = (window as any).electron?.getPathForFile?.(file); } catch { /* no-op */ }

            if (VIDEO_EXTS.has(ext)) {
                const poster = await captureVideoPoster(asset.blobUrl).catch(() => null);
                const video: VideoItem = {
                    ...baseProps,
                    id: newId('vid'),
                    type: 'video',
                    w: Math.round((poster?.w ? Math.min(520, poster.w) : 480) * zoomComp),
                    h: Math.round((poster?.w ? Math.min(520, poster.w) * (poster.h / poster.w) + 38 : 320) * zoomComp),
                    fileName: file.name,
                    fileSize: file.size,
                    extension: ext,
                    mimeType: mime,
                    assetId: asset.id,
                    originalPath,
                    posterDataUrl: poster?.dataUrl,
                    naturalWidth: poster?.w,
                    naturalHeight: poster?.h,
                    durationSec: poster?.duration,
                    currentTimeSec: 0,
                };
                return video;
            }
            // Audio
            const peaks = await decodeWaveform(buf, mime).catch(() => null);
            const audio: AudioItem = {
                ...baseProps,
                id: newId('aud'),
                type: 'audio',
                w: Math.round(360 * zoomComp),
                h: Math.round(120 * zoomComp),
                fileName: file.name,
                fileSize: file.size,
                extension: ext,
                mimeType: mime,
                assetId: asset.id,
                originalPath,
                waveformPeaks: peaks?.peaks,
                durationSec: peaks?.duration,
                currentTimeSec: 0,
            };
            return audio;
        } catch {
            // Fall through to FileItem on failure.
        }
    }

    // If running in Electron, capture original path so the card can "open externally".
    let originalPath: string | undefined;
    try {
        originalPath = (window as any).electron?.getPathForFile?.(file);
    } catch { /* no-op */ }

    // Read file bytes once and register as an asset so it persists in the .any
    // ZIP. PDF/XLSX preview generators below reuse the same buffer to avoid a
    // second read of large files.
    let fileBytes: Uint8Array | null = null;
    let assetId: string | undefined;
    try {
        fileBytes = new Uint8Array(await file.arrayBuffer());
        const mime = file.type || mimeFromExtension(ext);
        const asset = registerAsset({
            mime,
            extension: ext || 'bin',
            bytes: fileBytes,
            fileName: file.name,
        });
        assetId = asset.id;
    } catch {
        // Asset capture is best-effort; the card still works as a metadata stub.
    }

    const card: FileItem = {
        ...baseProps,
        id: newId('file'),
        type: 'file',
        w: Math.round(280 * zoomComp),
        h: Math.round(84 * zoomComp),
        fileName: file.name,
        fileSize: file.size,
        extension: ext || 'file',
        mimeType: file.type || 'application/octet-stream',
        assetId,
        originalPath,
    };

    // Attach a lightweight preview so the card can render a rich view.
    try {
        if (ext === 'pdf') {
            const preview = await renderPdfFirstPage(file, fileBytes);
            if (preview) {
                card.previewDataUrl = preview.dataUrl;
                card.previewPages = preview.pages;
                card.w = Math.round(320 * zoomComp);
                card.h = Math.round(420 * zoomComp);
            }
        } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
            const sheet = await renderSpreadsheetPreview(file, fileBytes);
            if (sheet) {
                card.previewSheet = sheet;
                card.w = Math.round(420 * zoomComp);
                card.h = Math.round(260 * zoomComp);
            }
        } else if (ext === 'docx') {
            const preview = await renderDocxPreview(file, fileBytes);
            if (preview) {
                card.previewHtml = preview.html;
                card.previewWordCount = preview.wordCount;
                card.w = Math.round(380 * zoomComp);
                card.h = Math.round(440 * zoomComp);
            }
        }
    } catch (err) {
        // Preview is best-effort — card still lands without it.
        console.warn('[canvas] preview generation failed:', err);
    }

    return card;
}

/**
 * Render the first page of a PDF to a data URL using pdfjs-dist. Best-effort:
 * if pdfjs can't load the worker or the PDF is encrypted, returns null and
 * the card falls back to icon + metadata.
 */
async function renderPdfFirstPage(file: File, prefetched: Uint8Array | null): Promise<{ dataUrl: string; pages: number } | null> {
    try {
        // pdfjs-dist ships an ESM entry in modern versions. Dynamic import so
        // it isn't pulled into the main bundle unless a PDF is actually dropped.
        const pdfjs: any = await import('pdfjs-dist');
        // Point worker to the bundled worker via Vite's `?url` import. pdfjs-dist
        // v2.x ships only .js (no .mjs); the ?url suffix tells Vite to emit it as
        // an asset rather than try to parse it.
        // @ts-ignore — Vite-specific import
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

        // pdfjs consumes the buffer; pass a fresh copy so the asset registry's
        // canonical bytes aren't detached.
        const data = prefetched ? prefetched.slice() : new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data }).promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1.2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        await page.render({ canvasContext: context, viewport }).promise;
        return { dataUrl: canvas.toDataURL('image/jpeg', 0.75), pages: doc.numPages };
    } catch (err) {
        console.warn('[pdf preview] failed:', err);
        return null;
    }
}

// Cap DOCX preview HTML so a huge doc doesn't bloat canvas.json. Bytes still
// live in the asset registry / ZIP, so agent tools can still read the full text.
const MAX_DOCX_HTML_CHARS = 80_000;

/**
 * Convert a DOCX to sanitized HTML via mammoth and cap it. Returns null on
 * any failure (encrypted doc, macro-enabled, mammoth version mismatch, etc.).
 */
async function renderDocxPreview(file: File, prefetched: Uint8Array | null): Promise<{ html: string; wordCount: number } | null> {
    try {
        // mammoth's browser bundle — dynamic import so it isn't in the main chunk
        // unless a DOCX is actually dropped. No types are published for the
        // browser bundle, so we cast via `// @ts-ignore`.
        // @ts-ignore — no types for mammoth/mammoth.browser.min.js
        const mammoth: any = await import('mammoth/mammoth.browser.min.js');
        const arrayBuffer = prefetched ? prefetched.slice().buffer : await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        const raw: string = result?.value || '';
        if (!raw.trim()) return null;
        const safe = sanitizeDocxHtml(raw);
        const truncated = safe.length > MAX_DOCX_HTML_CHARS ? safe.slice(0, MAX_DOCX_HTML_CHARS) + '\n<p><em>…preview truncated</em></p>' : safe;
        // Rough word count — mammoth output has no scripts, so stripping tags
        // and splitting on whitespace is accurate enough.
        const text = raw.replace(/<[^>]*>/g, ' ');
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        return { html: truncated, wordCount };
    } catch (err) {
        console.warn('[docx preview] failed:', err);
        return null;
    }
}

/**
 * Strip anything executable from mammoth's HTML. Mammoth already produces
 * clean semantic markup (h1-h6, p, ul/ol/li, table, strong/em, a) with no
 * script tags, but we're defensive: kill <script>, on-handlers, and any
 * javascript: URLs in href/src.
 */
function sanitizeDocxHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
        .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
        .replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
}

/**
 * Parse the first sheet of an XLSX/CSV and return header + first ~10 rows.
 */
async function renderSpreadsheetPreview(file: File, prefetched: Uint8Array | null): Promise<FileItem['previewSheet']> {
    try {
        const buf = prefetched ? prefetched : new Uint8Array(await file.arrayBuffer());
        const wb = XLSX.read(buf, { type: 'array' });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) return undefined;
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
        if (rows.length === 0) return undefined;
        const headers = (rows[0] as any[]).map(v => String(v ?? ''));
        const bodyRows = rows.slice(1, 11).map(r => (r as any[]).map(v => String(v ?? '')));
        return {
            sheetName,
            sheetCount: wb.SheetNames.length,
            headers,
            rows: bodyRows,
            totalRows: rows.length - 1,
        };
    } catch {
        return undefined;
    }
}

/**
 * Grab a single representative frame from a video file (at ~10% of duration)
 * for use as a poster / thumbnail. Runs entirely in the browser via a hidden
 * <video> element + canvas.drawImage. Resolves with null on any failure — the
 * video card still works without a poster.
 */
async function captureVideoPoster(blobUrl: string): Promise<{ dataUrl: string; w: number; h: number; duration: number } | null> {
    return new Promise((resolve) => {
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.muted = true;
        el.playsInline = true;
        el.src = blobUrl;
        let done = false;
        const finish = (val: { dataUrl: string; w: number; h: number; duration: number } | null) => {
            if (done) return;
            done = true;
            el.removeAttribute('src');
            try { el.load(); } catch { /* ignored */ }
            resolve(val);
        };
        el.onloadedmetadata = () => {
            // Seek to 10% of the video so we don't end up with a blank first frame.
            const target = Math.min(1.5, (isFinite(el.duration) ? el.duration : 0) * 0.1);
            const onSeeked = () => {
                try {
                    const c = document.createElement('canvas');
                    const w = el.videoWidth || 480;
                    const h = el.videoHeight || 270;
                    // Downscale: clamp longest side to 480 for a cheap poster.
                    const scale = Math.min(1, 480 / Math.max(w, h));
                    c.width = Math.max(1, Math.round(w * scale));
                    c.height = Math.max(1, Math.round(h * scale));
                    const ctx = c.getContext('2d');
                    if (!ctx) return finish(null);
                    ctx.drawImage(el, 0, 0, c.width, c.height);
                    finish({
                        dataUrl: c.toDataURL('image/jpeg', 0.7),
                        w,
                        h,
                        duration: isFinite(el.duration) ? el.duration : 0,
                    });
                } catch { finish(null); }
            };
            el.onseeked = onSeeked;
            try { el.currentTime = target; }
            catch { finish(null); }
        };
        el.onerror = () => finish(null);
        // Hard timeout — some codecs just hang. 3s is generous for metadata + one seek.
        setTimeout(() => finish(null), 3000);
    });
}

/**
 * Decode audio bytes via the WebAudio API and produce a downsampled peaks
 * array (~200 samples) for the waveform visual. Uses an OfflineAudioContext
 * so it doesn't touch output devices. Returns null on decode failure.
 */
async function decodeWaveform(bytes: Uint8Array, _mime: string, targetBars = 200): Promise<{ peaks: number[]; duration: number } | null> {
    try {
        const Ctx: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx();
        // Copy into a fresh ArrayBuffer — decodeAudioData takes ownership.
        const ab = bytes.slice().buffer;
        const buf = await ctx.decodeAudioData(ab);
        const ch = buf.getChannelData(0);
        const bars = Math.min(targetBars, Math.max(40, ch.length / 1024));
        const barCount = Math.max(1, Math.floor(bars));
        const step = Math.max(1, Math.floor(ch.length / barCount));
        const peaks: number[] = new Array(barCount);
        let globalMax = 0.0001;
        for (let i = 0; i < barCount; i++) {
            const start = i * step;
            const end = Math.min(ch.length, start + step);
            let max = 0;
            for (let j = start; j < end; j++) {
                const v = Math.abs(ch[j]);
                if (v > max) max = v;
            }
            peaks[i] = max;
            if (max > globalMax) globalMax = max;
        }
        // Normalize peaks to [0,1].
        for (let i = 0; i < barCount; i++) peaks[i] = peaks[i] / globalMax;
        const duration = buf.duration;
        try { ctx.close(); } catch { /* ignored */ }
        return { peaks, duration };
    } catch {
        return null;
    }
}
