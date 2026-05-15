// Voice input via Web Speech API (Chromium / Electron native). Falls back
// silently if unavailable. Spec §11.

type SRResult = {
    final: boolean;
    transcript: string;
};

export interface VoiceController {
    start(onResult: (r: SRResult) => void, onEnd?: () => void, lang?: string): boolean;
    stop(): void;
    isRecording(): boolean;
}

export function createVoiceController(): VoiceController {
    // @ts-ignore — vendor-prefixed SpeechRecognition
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let rec: any = null;
    let recording = false;

    return {
        start(onResult, onEnd, lang = 'en-US') {
            if (!SR) return false;
            if (recording) return false;
            rec = new SR();
            rec.continuous = false;
            rec.interimResults = true;
            rec.lang = lang;
            rec.onresult = (ev: any) => {
                const r = ev.results[ev.results.length - 1];
                onResult({ transcript: r[0].transcript, final: r.isFinal });
            };
            rec.onend = () => { recording = false; onEnd?.(); };
            rec.onerror = () => { recording = false; onEnd?.(); };
            rec.start();
            recording = true;
            return true;
        },
        stop() {
            if (rec && recording) {
                try { rec.stop(); } catch {}
            }
            recording = false;
        },
        isRecording() { return recording; },
    };
}
