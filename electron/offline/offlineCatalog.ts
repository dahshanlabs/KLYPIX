// Catalog of optional "offline models" — downloaded on demand from the KLYPIX
// CDN to userData (NEVER bundled in the installer), so the app stays light and
// only users who want on-device OCR / transcription pay the download.
//
// Two kinds:
//   • ocr — Tesseract .traineddata, consumed in the MAIN process by the
//           existing createWorker path (redirected to userData).
//   • stt — Whisper model tier metadata; the renderer's transformers.js
//           runtime fetches the actual weights (see src/services/offlineStt).
//
// CommonJS-safe (tsconfig.electron → CJS). No ESM-only deps.

// Where models are served from. Override with KLYPIX_OFFLINE_CDN for staging.
// NOTE: the host below must actually serve these files before the lane works.
// Public CDN by default so Install works with zero hosting (it's the same host
// tesseract.js uses, so the userData copy is a drop-in). Set KLYPIX_OFFLINE_CDN
// to self-host on klypix.com later — mirror @tesseract.js-data/<lang>/
// 4.0.0_best_int/<lang>.traineddata.gz under it and the paths stay identical.
export const OFFLINE_CDN_BASE =
    process.env.KLYPIX_OFFLINE_CDN || 'https://cdn.jsdelivr.net';

export interface OfflineFile {
    name: string;       // filename on disk
    url: string;        // absolute CDN url
    sha256?: string;    // optional integrity check (filled once hosted)
}

export interface OfflineAsset {
    id: string;                 // stable id, e.g. 'ocr-eng', 'stt-base'
    kind: 'ocr' | 'stt';
    label: string;              // human label for the panel
    sizeBytes: number;          // approximate, for the panel
    files: OfflineFile[];
    // ocr-specific
    langCode?: string;          // tesseract lang, e.g. 'eng', 'ara'
    // stt-specific
    modelRepo?: string;         // transformers.js model id, e.g. 'Xenova/whisper-base'
    recommended?: boolean;
    note?: string;
}

// Source the EXACT gzipped file tesseract.js v7 itself fetches, stored on disk
// as <lang>.traineddata.gz. The worker (gzip:true by default) reads the .gz
// from langPath and gunzips internally — so we must NOT decompress here.
const ocr = (id: string, label: string, lang: string, mb: number): OfflineAsset => ({
    id, kind: 'ocr', label, langCode: lang, sizeBytes: Math.round(mb * 1024 * 1024),
    files: [{ name: `${lang}.traineddata.gz`, url: `${OFFLINE_CDN_BASE}/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz` }],
});

const stt = (id: string, label: string, repo: string, mb: number, opts: { recommended?: boolean; note?: string } = {}): OfflineAsset => ({
    id, kind: 'stt', label, modelRepo: repo, sizeBytes: Math.round(mb * 1024 * 1024),
    recommended: opts.recommended, note: opts.note,
    // The renderer runtime resolves the actual weight files; we list the model
    // dir so the manager can record an "installed" marker + size.
    files: [{ name: 'model', url: `${OFFLINE_CDN_BASE}/whisper/${id}/` }],
});

export const OFFLINE_CATALOG: OfflineAsset[] = [
    // ── OCR (reading text from images / scanned PDFs, on-device) ──
    // Sizes are the gzipped download (what actually transfers), not unzipped.
    ocr('ocr-eng', 'English OCR', 'eng', 5),
    ocr('ocr-ara', 'Arabic OCR', 'ara', 2),
    // ── STT (transcribing voice notes / audio cards, on-device) ──
    stt('stt-tiny', 'Fast (tiny)', 'Xenova/whisper-tiny', 41, { note: 'Quickest, lower accuracy.' }),
    stt('stt-base', 'Balanced (base)', 'Xenova/whisper-base', 77, { recommended: true, note: 'Good Arabic + English. Recommended.' }),
    stt('stt-small', 'Best (small)', 'Xenova/whisper-small', 240, { note: 'Most accurate; slower without a GPU.' }),
];

export function getAsset(id: string): OfflineAsset | undefined {
    return OFFLINE_CATALOG.find(a => a.id === id);
}
