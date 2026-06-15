// Audio recording + Gemini batch transcription. Replaces the Web Speech
// API path (`voiceInput.ts`) for the canvas mic because Electron's
// Chromium build lacks a working speech-recognition backend — start()
// succeeded but onresult never fired. MediaRecorder + Gemini multimodal
// works end-to-end and matches the chat-side mic's proven pipeline.
//
// Trade-off vs. Web Speech: no interim results. Transcript arrives once,
// after stop(). The card shows a 'transcribing' status while Gemini runs.
//
// Latency: getUserMedia cold-starts in ~100–600ms on Windows, which clips
// the user's first words ("voice slowly detected"). prewarm() pre-acquires
// the mic stream + AudioContext (call it on FAB hover / pointerdown) so the
// following start() begins capture instantly. A bounded idle TTL releases a
// warm-but-unused stream so the OS "mic in use" indicator never lingers.

export type VoiceStatus = 'recording' | 'transcribing' | 'done' | 'error';

export interface AudioTranscribeController {
    /**
     * Acquire mic, start MediaRecorder + level metering. onLevel fires
     * every animation frame with a 0..1 amplitude (driven by an FFT
     * analyser — not a raw sample read). onStatus marks transitions
     * (recording → transcribing → done/error). onFinal fires exactly
     * once with the transcribed text; onError fires instead on failure.
     * Returns true if recording started, false if the mic was denied.
     */
    start(handlers: {
        onLevel: (level: number) => void;
        onStatus: (status: VoiceStatus) => void;
        onFinal: (text: string) => void;
        onError?: (err: Error) => void;
    }): Promise<boolean>;
    /** Stop MediaRecorder; transcription fires asynchronously from the
     *  recorder's own onstop handler. */
    stop(): void;
    isRecording(): boolean;
    /** True during the start() getUserMedia await window (before recording
     *  flips true). Gate toggles on isRecording() || isStarting() so a fast
     *  double-click cancels the in-flight start instead of re-entering it. */
    isStarting(): boolean;
    /** Pre-acquire mic + AudioContext so the next start() begins capture
     *  with no cold getUserMedia stall. Idempotent, fire-and-forget. Arms a
     *  bounded idle timer that releases the mic if start() is never called. */
    prewarm(): Promise<void>;
    /** Release a warm-but-idle stream immediately (no-op while recording).
     *  Tie to tab-hide so the OS mic indicator never lingers behind an
     *  always-mounted, hidden canvas. */
    releaseWarm(): void;
    /** Full teardown for component unmount (releaseAudio + clear timers). */
    dispose(): void;
}

export function createAudioTranscribeController(): AudioTranscribeController {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let animFrame: number | null = null;
    let recorder: MediaRecorder | null = null;
    let recording = false;
    let chunks: Blob[] = [];

    // Pre-warm bookkeeping.
    let warmIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let acquiring: Promise<MediaStream> | null = null; // dedups hover+pointerdown
    let starting = false;     // true during the start() await window
    let cancelStart = false;  // set by stop() to abort an in-flight start()
    let deviceChangeBound = false;
    const WARM_TTL_MS = 12_000; // OS mic indicator must not linger longer

    const clearWarmTimer = () => {
        if (warmIdleTimer) { clearTimeout(warmIdleTimer); warmIdleTimer = null; }
    };

    // HARD teardown — used after a real recording and on dispose. Closes the
    // AudioContext too.
    const releaseAudio = () => {
        clearWarmTimer();
        if (animFrame != null) cancelAnimationFrame(animFrame);
        animFrame = null;
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        ctx?.close().catch(() => { /* already closed */ });
        ctx = null;
        analyser = null;
    };

    const streamIsLive = (): boolean =>
        !!stream && stream.getAudioTracks().some(t => t.readyState === 'live' && t.enabled);

    // SOFT teardown — release only the mic stream + analyser graph (keep ctx
    // for reuse). Used to drop a warm-but-idle stream so the OS mic indicator
    // clears without paying to rebuild the AudioContext next time.
    const releaseStreamOnly = () => {
        if (animFrame != null) cancelAnimationFrame(animFrame);
        animFrame = null;
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        analyser = null;
        clearWarmTimer();
    };

    const armWarmTimer = () => {
        clearWarmTimer();
        warmIdleTimer = setTimeout(() => {
            if (!recording && !starting) releaseStreamOnly();
        }, WARM_TTL_MS);
    };

    const ensureContext = async (): Promise<AudioContext> => {
        if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
        // Chromium may park the context as 'suspended' until a gesture;
        // resume so the analyser produces data immediately on start().
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* resumes on the click gesture */ } }
        return ctx;
    };

    // Single acquisition funnel. Reuses a live warm stream; otherwise issues
    // one getUserMedia, caching the in-flight promise so a hover+pointerdown
    // double-call never opens two streams. Binds device-loss handlers once.
    const acquireStream = async (): Promise<MediaStream> => {
        if (streamIsLive()) return stream!;
        if (acquiring) return acquiring;
        if (stream) releaseStreamOnly(); // stale (unplugged/ended) — drop first
        acquiring = (async () => {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            const track = s.getAudioTracks()[0];
            // If the device dies, act DURING recording too — gracefully stop
            // so onstop transcribes whatever was captured (or surfaces an
            // empty-blob error) instead of recording silence forever.
            track?.addEventListener('ended', () => {
                if (recording) {
                    try { recorder?.stop(); } catch { recording = false; releaseAudio(); }
                } else if (!starting) {
                    releaseStreamOnly();
                }
            });
            if (!deviceChangeBound && navigator.mediaDevices) {
                deviceChangeBound = true;
                navigator.mediaDevices.addEventListener('devicechange', () => {
                    if (!recording && !starting && !streamIsLive()) releaseStreamOnly();
                });
            }
            return s;
        })();
        try { stream = await acquiring; return stream; }
        finally { acquiring = null; }
    };

    return {
        async start({ onLevel, onStatus, onFinal, onError }) {
            if (recording || starting) return false;
            starting = true;
            cancelStart = false;
            clearWarmTimer(); // we're actively using the stream now

            try {
                stream = await acquireStream(); // ~0ms when pre-warmed
            } catch (err) {
                starting = false;
                onError?.(err as Error);
                return false;
            }
            if (cancelStart) { starting = false; releaseAudio(); return false; }

            const audioCtx = await ensureContext();
            if (cancelStart) { starting = false; releaseAudio(); return false; }
            // The warm stream may have been killed during the awaits above
            // (mid-await stop / device unplug). Re-acquire once.
            if (!streamIsLive()) {
                try { stream = await acquireStream(); }
                catch (err) { starting = false; onError?.(err as Error); return false; }
            }

            // FFT-based level meter — same config as the chat mic so the
            // waveform rhythm feels familiar.
            const source = audioCtx.createMediaStreamSource(stream);
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            // 0.7 was over-smoothing — bars lagged ~5 frames behind speech.
            // 0.3 keeps motion fluid without losing the per-syllable bounce.
            analyser.smoothingTimeConstant = 0.3;
            source.connect(analyser);
            const bins = new Uint8Array(analyser.frequencyBinCount);
            // Speech-band peak meter. Averaging across ALL bins drowns out
            // voice in HF silence; using the peak inside the speech band
            // (~150Hz–3kHz) tracks actual loudness much more closely.
            const speechStart = 2;
            const speechEnd = Math.min(bins.length, 32);
            // Noise gate. Mic self-noise + room hum sit around 5–15 in
            // byte-FFT terms; without this floor, the perceptual curve
            // below boosts that into a visible "always on" bar height.
            const NOISE_FLOOR = 28;
            const tick = () => {
                if (!analyser) return;
                analyser.getByteFrequencyData(bins);
                let peak = 0;
                for (let i = speechStart; i < speechEnd; i++) {
                    if (bins[i] > peak) peak = bins[i];
                }
                // Subtract floor first so silence → 0; then normalize to
                // the remaining headroom and apply a gentle gamma so
                // mid-range speech occupies the visible mid-range.
                const adjusted = Math.max(0, peak - NOISE_FLOOR);
                const norm = adjusted / (255 - NOISE_FLOOR);
                onLevel(Math.min(1, Math.pow(norm, 0.55) * 1.35));
                animFrame = requestAnimationFrame(tick);
            };
            animFrame = requestAnimationFrame(tick);

            chunks = [];
            // Final liveness gate (TOCTOU): a track can flip live→ended between
            // the check above and MediaRecorder construction. Bail cleanly
            // rather than record silence.
            if (!streamIsLive()) {
                starting = false;
                releaseAudio();
                onError?.(new Error('Microphone unavailable'));
                return false;
            }
            recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = async () => {
                recording = false;
                const blob = new Blob(chunks, { type: 'audio/webm' });
                // Free the mic the moment capture ends — the transcription
                // round-trip can take a few seconds and we don't want the
                // OS "mic in use" indicator hanging on during it.
                releaseAudio();
                recorder = null;
                chunks = [];

                if (blob.size === 0) {
                    onStatus('error');
                    onError?.(new Error('No audio captured'));
                    return;
                }

                onStatus('transcribing');
                // On-device first (only when the user enabled prefer-offline +
                // installed a model). Returns null when off → Gemini below.
                try {
                    const { transcribeLocal } = await import('../../services/offlineStt');
                    const local = await transcribeLocal(blob, { kind: 'audio' });
                    if (local) { onStatus('done'); onFinal(local); return; }
                } catch { /* fall through to cloud */ }
                try {
                    const base64 = await blobToBase64(blob);
                    const { getApiKeySync } = await import('../../api/gemini');
                    const { GoogleGenerativeAI } = await import('@google/generative-ai');
                    const genAI = new GoogleGenerativeAI(getApiKeySync());
                    const model = genAI.getGenerativeModel(
                        { model: 'gemini-2.5-flash' },
                        { apiVersion: 'v1beta' },
                    );
                    const result = await model.generateContent([
                        'Transcribe this audio exactly. Return ONLY the spoken words, nothing else. Support Arabic and English.',
                        { inlineData: { data: base64, mimeType: 'audio/webm' } },
                    ]);
                    const text = (result.response.text() || '').trim();
                    onStatus('done');
                    onFinal(text);
                } catch (err) {
                    onStatus('error');
                    onError?.(err as Error);
                }
            };
            recorder.onerror = (e: any) => {
                onError?.(new Error(e?.error?.message || 'MediaRecorder error'));
                recording = false;
                releaseAudio();
                recorder = null;
                chunks = [];
            };

            starting = false;
            recorder.start();
            recording = true;
            onStatus('recording');
            return true;
        },
        stop() {
            // Abort an in-flight start() before it wires up a (possibly stale)
            // stream — the post-await guards in start() see cancelStart and
            // tear down cleanly.
            if (starting) { cancelStart = true; return; }
            if (recorder && recording) {
                try {
                    recorder.stop();
                } catch {
                    // If stop() throws the onstop callback won't run — clean
                    // up the audio graph manually so the mic doesn't hang.
                    recording = false;
                    releaseAudio();
                    recorder = null;
                    chunks = [];
                }
            } else {
                releaseAudio();
            }
        },
        isRecording() { return recording; },
        isStarting() { return starting; },
        async prewarm() {
            if (recording || starting) return;
            if (streamIsLive()) { armWarmTimer(); return; } // refresh TTL on repeated hovers
            try {
                await acquireStream();
                if (recording || starting) return; // start() took over mid-acquire
                await ensureContext();
                if (recording || starting) return;
                armWarmTimer();
            } catch { /* denied/unavailable — start() surfaces the error on click */ }
        },
        releaseWarm() {
            if (recording || starting) return;
            releaseStreamOnly();
        },
        dispose() {
            cancelStart = true;
            clearWarmTimer();
            releaseAudio();
        },
    };
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1] || '');
        };
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsDataURL(blob);
    });
}
