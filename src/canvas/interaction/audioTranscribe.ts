// Audio recording + Gemini batch transcription. Replaces the Web Speech
// API path (`voiceInput.ts`) for the canvas mic because Electron's
// Chromium build lacks a working speech-recognition backend — start()
// succeeded but onresult never fired. MediaRecorder + Gemini multimodal
// works end-to-end and matches the chat-side mic's proven pipeline.
//
// Trade-off vs. Web Speech: no interim results. Transcript arrives once,
// after stop(). The card shows a 'transcribing' status while Gemini runs.

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
}

export function createAudioTranscribeController(): AudioTranscribeController {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let animFrame: number | null = null;
    let recorder: MediaRecorder | null = null;
    let recording = false;
    let chunks: Blob[] = [];

    const releaseAudio = () => {
        if (animFrame != null) cancelAnimationFrame(animFrame);
        animFrame = null;
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        ctx?.close().catch(() => { /* already closed */ });
        ctx = null;
        analyser = null;
    };

    return {
        async start({ onLevel, onStatus, onFinal, onError }) {
            if (recording) return false;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err) {
                onError?.(err as Error);
                return false;
            }

            // FFT-based level meter — same config as the chat mic so the
            // waveform rhythm feels familiar.
            ctx = new AudioContext();
            const source = ctx.createMediaStreamSource(stream);
            analyser = ctx.createAnalyser();
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

            recorder.start();
            recording = true;
            onStatus('recording');
            return true;
        },
        stop() {
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
