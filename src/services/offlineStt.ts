// On-device speech-to-text via transformers.js (Whisper ONNX), loaded ON DEMAND
// from a CDN — NEVER bundled, so the installer stays byte-identical for users
// who don't opt in. Returns null fast unless the user enabled "prefer offline"
// AND installed a model tier, in which case the caller falls back to Gemini.
//
// Privacy/offline lane: once the model is cached (first use), transcription
// runs fully on-device. Video VISUALS still go to Gemini (Whisper is audio-only).
//
// NOTE: the actual inference path can only be validated once a Whisper model is
// reachable (transformers.js caches it after first load). By default this file
// is inert (transcribeLocal → null), so it can ship safely unverified.

// transformers.js ESM, loaded at runtime (override host via localStorage).
const DEFAULT_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const TIER_REPO: Record<string, string> = {
    'stt-tiny': 'Xenova/whisper-tiny',
    'stt-base': 'Xenova/whisper-base',
    'stt-small': 'Xenova/whisper-small',
};

let transformers: any = null;
let pipe: any = null;
let pipeRepo: string | null = null;

function ls(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
export function preferOffline(): boolean { return ls('klypix:preferOffline') === '1'; }
export function sttInstalledTier(): string | null { const t = ls('klypix:stt:tier'); return t && TIER_REPO[t] ? t : null; }

async function loadTransformers(): Promise<any> {
    if (transformers) return transformers;
    const cdn = ls('klypix:offlineCdn') || DEFAULT_CDN;
    transformers = await import(/* @vite-ignore */ cdn);
    return transformers;
}

async function ensurePipeline(repo: string): Promise<any> {
    if (pipe && pipeRepo === repo) return pipe;
    const t = await loadTransformers();
    // Cache the loaded model; transformers.js stores weights in the browser
    // cache so subsequent sessions are offline.
    pipe = await t.pipeline('automatic-speech-recognition', repo);
    pipeRepo = repo;
    return pipe;
}

/** Decode arbitrary audio bytes → 16kHz mono Float32 (Whisper's expected input)
 *  using WebAudio — no ffmpeg. Throws on unsupported codecs (caller falls back). */
async function decodeTo16kMono(input: Blob | Uint8Array): Promise<Float32Array> {
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ac = new AC();
    try {
        const decoded: AudioBuffer = await ac.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
        const frames = Math.ceil(decoded.duration * 16000);
        const off = new OfflineAudioContext(1, frames, 16000);
        const src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        const rendered = await off.startRendering();
        return rendered.getChannelData(0);
    } finally {
        try { ac.close(); } catch { /* no-op */ }
    }
}

/** Transcribe locally. Returns null (→ caller uses Gemini) unless the user has
 *  enabled prefer-offline AND installed a tier. Never throws — failures fall
 *  back to cloud. */
export async function transcribeLocal(input: Blob | Uint8Array, _opts: { kind: 'audio' | 'video' }): Promise<string | null> {
    if (!preferOffline()) return null;
    const tier = sttInstalledTier();
    if (!tier) return null;
    try {
        const audio = await decodeTo16kMono(input);
        const p = await ensurePipeline(TIER_REPO[tier]);
        const out = await p(audio, { chunk_length_s: 30, stride_length_s: 5 });
        const text = (out?.text || '').trim();
        return text || null;
    } catch (err) {
        console.warn('[offlineStt] local transcription failed; falling back to cloud:', err);
        return null;
    }
}

/** Pre-warm a tier (downloads + caches the model via transformers.js), then
 *  mark it installed. Used by the Offline Models panel's Install button. */
export async function installSttTier(tier: string): Promise<{ ok: boolean; error?: string }> {
    if (!TIER_REPO[tier]) return { ok: false, error: 'unknown tier' };
    try {
        await ensurePipeline(TIER_REPO[tier]);
        try { localStorage.setItem('klypix:stt:tier', tier); } catch { /* quota */ }
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
}

export function removeSttTier(): void {
    try { localStorage.removeItem('klypix:stt:tier'); } catch { /* no-op */ }
    pipe = null; pipeRepo = null;
}
