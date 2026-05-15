'use client';

// Public canvas-share viewer.
//
// URL: /c/<token>#<keyB64>
//
// Runs entirely client-side because the decryption key lives in the URL
// fragment (window.location.hash) — which is never sent to any server,
// including Next.js / Vercel. Flow:
//
//   1. Resolve token via anonymous Supabase query
//   2. Download encrypted bytes
//   3. Decrypt with the URL-fragment key
//   4. Parse the .klypix ZIP (v3 or v4 layout)
//   5. Render read-only with pan/zoom
//
// If parsing fails (corrupted file, unsupported format) we fall back to a
// "Download .klypix" card so the recipient still gets the file.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
    loadSharedCanvas,
    downloadAsKlypixFile,
    formatBytes,
    CanvasShareError,
    type LoadError,
} from '@/lib/canvasShare';
import { parseKlypix, revokeAssetUrls, KlypixParseError, type ParsedCanvas } from '@/lib/parseKlypix';
import { CanvasViewer } from '@/components/CanvasViewer';

type ViewState =
    | { status: 'loading' }
    | { status: 'no-key' }
    | { status: 'parsing'; bytes: Uint8Array; encryptedSize: number; blobId: string }
    | { status: 'viewing'; canvas: ParsedCanvas; bytes: Uint8Array; encryptedSize: number; blobId: string }
    | { status: 'parse-failed'; bytes: Uint8Array; encryptedSize: number; blobId: string; reason: string }
    | { status: 'error'; code: LoadError; message: string };

export default function SharedCanvasPage() {
    const params = useParams<{ token: string }>();
    const token = params?.token ?? '';
    const [view, setView] = useState<ViewState>({ status: 'loading' });

    useEffect(() => {
        if (!token) {
            setView({ status: 'error', code: 'invalid-token', message: 'No share token in URL' });
            return;
        }
        const keyB64 = window.location.hash.startsWith('#')
            ? window.location.hash.slice(1)
            : '';
        if (!keyB64) {
            setView({ status: 'no-key' });
            return;
        }

        let cancelled = false;
        loadSharedCanvas(token, keyB64)
            .then(result => {
                if (cancelled) return;
                setView({
                    status: 'parsing',
                    bytes: result.bytes,
                    encryptedSize: result.encryptedSize,
                    blobId: result.blobId,
                });
            })
            .catch(err => {
                if (cancelled) return;
                if (err instanceof CanvasShareError) {
                    setView({ status: 'error', code: err.code, message: err.message });
                } else {
                    setView({ status: 'error', code: 'download-failed', message: String(err) });
                }
            });
        return () => { cancelled = true; };
    }, [token]);

    // ── Parse stage: after bytes arrive, decode the ZIP ─────────────────────
    useEffect(() => {
        if (view.status !== 'parsing') return;
        let cancelled = false;
        parseKlypix(view.bytes)
            .then(canvas => {
                if (cancelled) {
                    revokeAssetUrls(canvas.assetUrls);
                    return;
                }
                setView({
                    status: 'viewing',
                    canvas,
                    bytes: view.bytes,
                    encryptedSize: view.encryptedSize,
                    blobId: view.blobId,
                });
            })
            .catch(err => {
                if (cancelled) return;
                const reason = err instanceof KlypixParseError
                    ? `${err.code}: ${err.message}`
                    : String(err);
                setView({
                    status: 'parse-failed',
                    bytes: view.bytes,
                    encryptedSize: view.encryptedSize,
                    blobId: view.blobId,
                    reason,
                });
            });
        return () => { cancelled = true; };
    }, [view]);

    // Free blob URLs on unmount / canvas change
    useEffect(() => {
        if (view.status !== 'viewing') return;
        const urls = view.canvas.assetUrls;
        return () => { revokeAssetUrls(urls); };
    }, [view.status === 'viewing' ? view.canvas : null]);

    // Full-screen viewer takes over once we have a parsed canvas
    if (view.status === 'viewing') {
        const filename = `klypix-canvas-${view.blobId.slice(0, 8)}.klypix`;
        return (
            <div className="fixed inset-0">
                <CanvasViewer
                    canvas={view.canvas}
                    onDownload={() => downloadAsKlypixFile(view.bytes, filename)}
                />
            </div>
        );
    }

    return (
        <main className="min-h-screen flex items-center justify-center px-4 py-12">
            <div className="w-full max-w-md">
                <Header />
                <div className="mt-8">
                    {(view.status === 'loading' || view.status === 'parsing') && (
                        <LoadingCard label={view.status === 'parsing' ? 'Parsing canvas…' : 'Decrypting canvas…'} />
                    )}
                    {view.status === 'no-key' && <NoKeyCard />}
                    {view.status === 'error' && <ErrorCard code={view.code} message={view.message} />}
                    {view.status === 'parse-failed' && (
                        <ParseFailedCard
                            reason={view.reason}
                            bytes={view.bytes}
                            encryptedSize={view.encryptedSize}
                            blobId={view.blobId}
                        />
                    )}
                </div>
                <Footer />
            </div>
        </main>
    );
}

function Header() {
    return (
        <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 mb-3">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2 L4 7 L4 17 L12 22 L20 17 L20 7 Z" />
                    <path d="M12 22 L12 12" />
                    <path d="M4 7 L12 12 L20 7" />
                </svg>
            </div>
            <h1 className="text-xl font-semibold text-white">KLYPIX canvas</h1>
            <p className="text-white/40 text-sm mt-1">Shared via end-to-end encrypted link</p>
        </div>
    );
}

function LoadingCard({ label }: { label: string }) {
    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-5 py-8 text-center">
            <div className="inline-block w-5 h-5 border-2 border-white/20 border-t-emerald-400 rounded-full animate-spin" />
            <div className="text-white/60 text-sm mt-3">{label}</div>
        </div>
    );
}

function NoKeyCard() {
    return (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-5 py-6">
            <div className="text-amber-300 text-sm font-medium">Decryption key missing</div>
            <div className="text-white/50 text-xs mt-2 leading-relaxed">
                The share URL is missing the part after the <code className="px-1 py-0.5 rounded bg-white/5">#</code> — that's the
                encryption key. Without it, this canvas cannot be decrypted. Ask the sender to share the full link.
            </div>
        </div>
    );
}

function ErrorCard({ code, message }: { code: LoadError; message: string }) {
    const titles: Record<LoadError, string> = {
        'invalid-token': 'Link expired or revoked',
        'download-failed': 'Could not load canvas',
        'decrypt-failed': 'Link is corrupted',
        'config-missing': 'Viewer not configured',
    };
    const helps: Record<LoadError, string> = {
        'invalid-token': 'The sender may have revoked this share or the link is past its expiry. Ask for a new link.',
        'download-failed': 'Check your network connection and try refreshing. If it persists, the server may be down.',
        'decrypt-failed': 'The link was tampered with or truncated. Make sure you copied the entire URL including the part after #.',
        'config-missing': 'This viewer deployment is missing its Supabase configuration. The admin needs to set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    };
    return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] px-5 py-6">
            <div className="text-red-300 text-sm font-medium">{titles[code]}</div>
            <div className="text-white/50 text-xs mt-2 leading-relaxed">{helps[code]}</div>
            <div className="text-white/30 text-[10px] mt-3 font-mono break-all">{message}</div>
        </div>
    );
}

function ParseFailedCard({ reason, bytes, encryptedSize, blobId }: { reason: string; bytes: Uint8Array; encryptedSize: number; blobId: string }) {
    const [downloaded, setDownloaded] = useState(false);
    const filename = `klypix-canvas-${blobId.slice(0, 8)}.klypix`;

    const handleDownload = () => {
        downloadAsKlypixFile(bytes, filename);
        setDownloaded(true);
        setTimeout(() => setDownloaded(false), 2200);
    };

    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5">
                <div className="text-white/40 text-[10px] uppercase tracking-wider mb-1">Canvas decrypted (preview unavailable)</div>
                <div className="flex items-baseline justify-between">
                    <div className="text-white text-sm font-medium">{formatBytes(bytes.byteLength)}</div>
                    <div className="text-white/30 text-[10px]">on disk · {formatBytes(encryptedSize)} encrypted</div>
                </div>
            </div>
            <div className="px-5 py-5">
                <div className="text-white/50 text-xs leading-relaxed mb-4">
                    The file decrypted successfully but the web viewer couldn't parse it. Could be an older or newer format than this viewer supports. Download it and open in the KLYPIX desktop app.
                </div>
                <button
                    onClick={handleDownload}
                    className="w-full rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 transition-colors border border-emerald-500/30 text-emerald-300 text-sm font-medium py-3"
                >
                    {downloaded ? 'Downloaded ✓' : 'Download .klypix file'}
                </button>
                <div className="text-white/30 text-[10px] mt-3 font-mono break-all">{reason}</div>
            </div>
        </div>
    );
}

function Footer() {
    return (
        <div className="text-center mt-8">
            <div className="text-white/30 text-[11px]">
                End-to-end encrypted. The server cannot decrypt this canvas.
            </div>
            <a
                href="https://klypix.com"
                className="inline-block mt-3 text-emerald-400/70 hover:text-emerald-400 text-xs"
            >
                klypix.com &rarr;
            </a>
        </div>
    );
}
