// Offline Models — one surface to install on-device OCR (Tesseract data) and
// transcription (Whisper). Nothing is bundled: everything downloads on demand
// to userData / the browser model cache, from the KLYPIX CDN. Cloud (Gemini)
// stays the default; "prefer offline" routes to local when a model is present.

import { useEffect, useState } from 'react';
import { Download, Check, Loader2, Trash2, HardDriveDownload } from 'lucide-react';
import { installSttTier, removeSttTier, sttInstalledTier } from '../services/offlineStt';

interface CatalogEntry { id: string; kind: 'ocr' | 'stt'; label: string; sizeBytes: number; installed?: boolean; recommended?: boolean; note?: string; }
type Progress = { phase: string; bytesDone?: number; totalBytes?: number; error?: string };

const mb = (b: number) => `${Math.max(1, Math.round(b / 1024 / 1024))} MB`;

export function OfflineModelsPanel({ tx }: { tx: (k: string, fb: string) => string }) {
    const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
    const [progress, setProgress] = useState<Record<string, Progress>>({});
    const [sttTier, setSttTier] = useState<string | null>(sttInstalledTier());
    const [busy, setBusy] = useState<string | null>(null); // id being installed
    const [prefer, setPrefer] = useState<boolean>(() => { try { return localStorage.getItem('klypix:preferOffline') === '1'; } catch { return false; } });

    const offline = (window as any).electron?.offline;

    const refresh = () => { offline?.list?.().then((c: CatalogEntry[]) => Array.isArray(c) && setCatalog(c)).catch(() => {}); };
    useEffect(() => {
        refresh();
        const un = offline?.onProgress?.((p: Progress & { id: string }) => {
            setProgress(prev => ({ ...prev, [p.id]: p }));
            if (p.phase === 'done' || p.phase === 'error') { if (p.phase === 'done') refresh(); setBusy(b => (b === p.id ? null : b)); }
        });
        return () => { if (typeof un === 'function') un(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ONE master switch governs everything: flipping it also sets the PDF-OCR
    // mode, so the user never juggles a separate per-capability matrix.
    const setPreferOffline = (v: boolean) => {
        setPrefer(v);
        try { localStorage.setItem('klypix:preferOffline', v ? '1' : '0'); } catch { /* quota */ }
        offline?.setPdfOcrMode?.(v ? 'local' : 'gemini');
    };

    const installOcr = async (id: string) => { setBusy(id); try { await offline?.install?.(id); } finally { /* progress handler clears busy */ } };
    const removeOcr = async (id: string) => { await offline?.remove?.(id); refresh(); };
    const installStt = async (id: string) => {
        setBusy(id); setProgress(prev => ({ ...prev, [id]: { phase: 'progress' } }));
        const r = await installSttTier(id);
        setProgress(prev => ({ ...prev, [id]: { phase: r.ok ? 'done' : 'error', error: r.error } }));
        setSttTier(sttInstalledTier()); setBusy(null);
    };
    const removeStt = () => { removeSttTier(); setSttTier(null); };

    const ocr = catalog.filter(c => c.kind === 'ocr');
    const stt = catalog.filter(c => c.kind === 'stt');

    const Row = ({ e, installed, onInstall, onRemove }: { e: CatalogEntry; installed: boolean; onInstall: () => void; onRemove: () => void }) => {
        const pr = progress[e.id];
        const downloading = busy === e.id || (pr && pr.phase !== 'done' && pr.phase !== 'error');
        return (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/10">
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-white/85 flex items-center gap-2">
                        {e.label}
                        {e.recommended && <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">{tx('offline.recommended', 'Recommended')}</span>}
                    </div>
                    <div className="text-[11px] text-white/40 mt-0.5">
                        {mb(e.sizeBytes)}{e.note ? ` · ${e.note}` : ''}
                        {/* What will actually run for this capability right now. */}
                        {installed && <span className={prefer ? 'text-emerald-400' : 'text-white/45'}> · {prefer ? tx('offline.active_local', 'Active: on-device') : tx('offline.active_cloud', 'using Cloud')}</span>}
                        {pr?.phase === 'error' && <span className="text-red-400"> · {pr.error || tx('offline.failed', 'Download failed')}</span>}
                        {downloading && pr?.totalBytes ? ` · ${mb(pr.bytesDone || 0)}/${mb(pr.totalBytes)}` : ''}
                    </div>
                </div>
                {installed ? (
                    <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 text-[12px] text-emerald-300"><Check size={13} /> {tx('offline.installed', 'Installed')}</span>
                        <button onClick={onRemove} title={tx('offline.remove', 'Remove')} className="p-1.5 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10"><Trash2 size={13} /></button>
                    </div>
                ) : downloading ? (
                    <span className="flex items-center gap-1.5 text-[12px] text-emerald-300"><Loader2 size={13} className="animate-spin" /> {pr?.phase === 'verify' ? tx('offline.verifying', 'Verifying…') : tx('offline.downloading', 'Downloading…')}</span>
                ) : (
                    <button onClick={onInstall} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 text-[12.5px] font-medium">
                        <Download size={13} /> {tx('offline.install', 'Install')}
                    </button>
                )}
            </div>
        );
    };

    return (
        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-4 flex flex-col gap-4">
            <div className="flex items-center gap-2">
                <HardDriveDownload size={15} className="text-emerald-400" />
                <div className="text-[13px] font-semibold text-white/90">{tx('offline.title', 'Offline models')}</div>
            </div>
            <p className="text-[12px] text-white/50 -mt-2">{tx('offline.caption', 'Optional on-device OCR and transcription. Nothing is bundled — models download on demand. Cloud (Gemini) stays the default and the fallback.')}</p>

            <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" checked={prefer} onChange={e => setPreferOffline(e.target.checked)} className="accent-emerald-500 w-4 h-4" />
                <span className="text-[13px] text-white/80">{tx('offline.prefer', 'Prefer offline when a model is installed')}</span>
            </label>

            <div>
                <div className="text-[11px] uppercase tracking-wider text-white/40 mb-2">{tx('offline.ocr_group', 'Read text from images & scanned PDFs')}</div>
                <div className="flex flex-col gap-2">
                    {ocr.map(e => <Row key={e.id} e={e} installed={!!e.installed} onInstall={() => installOcr(e.id)} onRemove={() => removeOcr(e.id)} />)}
                </div>
            </div>

            <div>
                <div className="text-[11px] uppercase tracking-wider text-white/40 mb-2">{tx('offline.stt_group', 'Transcribe voice notes & audio (on-device)')}</div>
                <div className="flex flex-col gap-2">
                    {stt.map(e => <Row key={e.id} e={e} installed={sttTier === e.id} onInstall={() => installStt(e.id)} onRemove={removeStt} />)}
                </div>
                <p className="text-[11px] text-white/35 mt-2">{tx('offline.stt_note', 'Whisper runs in-app (no GPU required). Video keeps using cloud for on-screen visuals.')}</p>
            </div>

            <SemanticMemoryRow tx={tx} />
        </div>
    );
}

// Semantic memory for the brain: one click installs the on-device embedding
// runtime into ~/.claude/project-brain/semantic so the bundled MCP server can
// rank brain searches by MEANING (the 23MB model auto-downloads + caches on
// first search). Until installed, searches fall back to exact-word matching.
function SemanticMemoryRow({ tx }: { tx: (k: string, fb: string) => string }) {
    const [installed, setInstalled] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const api = (window as any).electron?.semantic;
    useEffect(() => { api?.status?.().then((r: any) => setInstalled(!!r?.installed)).catch(() => setInstalled(false)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const install = async () => {
        setBusy(true); setError(null);
        try {
            const r = await api?.install?.();
            if (r?.ok) setInstalled(true); else setError(r?.error || tx('offline.failed', 'Download failed'));
        } finally { setBusy(false); }
    };
    return (
        <div>
            <div className="text-[11px] uppercase tracking-wider text-white/40 mb-2">{tx('offline.semantic_group', 'Search your project brains by meaning')}</div>
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/10">
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-white/85">{tx('offline.semantic_label', 'Semantic memory (on-device)')}</div>
                    <div className="text-[11px] text-white/40 mt-0.5">
                        {tx('offline.semantic_note', '“What did I decide about auth?” finds the answer across every project brain — 100% local, no API key. ~380 MB runtime + a 23 MB model on first search.')}
                        {error && <span className="text-red-400"> · {error}</span>}
                    </div>
                </div>
                {installed ? (
                    <span className="flex items-center gap-1 text-[12px] text-emerald-300"><Check size={13} /> {tx('offline.installed', 'Installed')}</span>
                ) : busy ? (
                    <span className="flex items-center gap-1.5 text-[12px] text-emerald-300"><Loader2 size={13} className="animate-spin" /> {tx('offline.downloading', 'Downloading…')}</span>
                ) : (
                    <button onClick={install} disabled={installed === null} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 text-[12.5px] font-medium">
                        <Download size={13} /> {tx('offline.install', 'Install')}
                    </button>
                )}
            </div>
        </div>
    );
}
