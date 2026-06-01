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

    const setPreferOffline = (v: boolean) => { setPrefer(v); try { localStorage.setItem('klypix:preferOffline', v ? '1' : '0'); } catch { /* quota */ } };

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
        </div>
    );
}
