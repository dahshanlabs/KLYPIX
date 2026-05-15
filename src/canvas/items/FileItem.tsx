import React, { useEffect, useRef, useState } from 'react';
import { File as FileIcon, FileText, FileSpreadsheet, FileImage, FileCode, FileVideo, FileAudio, FileArchive, ExternalLink } from 'lucide-react';
import type { FileItem as FileItemType } from './types';
import { getAsset, bytesToBase64 } from '../file/assetRegistry';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { useCanvasStore } from '../state/canvasStore';
import { setEmbedSync } from '../file/embedSyncStore';
import { useEmbedSync } from '../../hooks/useEmbedSync';

/**
 * Open an embedded file in its native app.
 *
 * Two modes:
 *   1. Round-trip embed (default when canvas is SAVED + item has an asset):
 *      Extracts the asset bytes to a canvas-scoped working dir, launches the
 *      OS default app, starts a file watcher. Subsequent saves in the native
 *      app re-pack into the .klypix automatically. The `.klypix` IS the
 *      authoritative copy.
 *   2. Read-only or originalPath fallback (when canvas is unsaved or no
 *      asset bytes exist): original-path-first if available, then temp
 *      extract. No watcher, no round-trip.
 *
 * Pass canvasFilePath explicitly — caller knows whether the canvas is saved.
 */
export async function openFileExternally(item: FileItemType, canvasFilePath?: string | null): Promise<void> {
    const api: any = (window as any).electron?.canvas;
    if (!api) return;
    const asset = item.assetId ? getAsset(item.assetId) : undefined;

    // Round-trip embed flow: requires canvas saved + asset bytes in registry.
    // This is the new default when both prerequisites are met.
    if (canvasFilePath && asset && item.assetId && api.embedOpenAndWatch) {
        setEmbedSync(item.id, { status: 'syncing' });
        try {
            const res = await api.embedOpenAndWatch({
                canvasFilePath,
                itemId: item.id,
                assetPath: `assets/${item.assetId}`,
                fileName: item.fileName,
                base64: bytesToBase64(asset.bytes),
            });
            if (res?.ok) {
                // Initial 'synced' — the file is extracted + launched. The
                // 'syncing' state will return on the next save event from
                // the watcher; 'synced' on successful re-pack.
                setEmbedSync(item.id, { status: 'synced', workingPath: res.workingPath });
                return;
            }
            setEmbedSync(item.id, { status: 'error', error: res?.error });
            // Fall through to non-watched fallback on embed failure.
        } catch (err: any) {
            setEmbedSync(item.id, { status: 'error', error: err?.message || String(err) });
        }
    }

    // Non-watched fallback paths — preserves prior behavior for read-only viewing
    // and for cases where the canvas hasn't been saved yet.
    if (item.originalPath) {
        const res = await api.openPath(item.originalPath);
        if (res?.ok) return;
    }
    if (!asset || !api.openAssetBytes) return;
    try {
        await api.openAssetBytes({
            fileName: item.fileName,
            base64: bytesToBase64(asset.bytes),
        });
    } catch (err) {
        console.warn('[canvas] openAssetBytes failed:', err);
    }
}

interface Props {
    item: FileItemType;
    selected: boolean;
}

export const FileCardView = React.memo(FileCardViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function pickIcon(ext: string) {
    const e = ext.toLowerCase();
    if (['pdf'].includes(e)) return FileText;
    if (['doc', 'docx', 'rtf', 'txt', 'md'].includes(e)) return FileText;
    if (['xls', 'xlsx', 'csv', 'tsv'].includes(e)) return FileSpreadsheet;
    if (['ppt', 'pptx'].includes(e)) return FileText;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return FileImage;
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'cs', 'json', 'html', 'css', 'sh'].includes(e)) return FileCode;
    if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(e)) return FileVideo;
    if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].includes(e)) return FileAudio;
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return FileArchive;
    return FileIcon;
}

interface CardFooterProps {
    item: FileItemType;
    Icon: React.ComponentType<{ size?: number }>;
    subtitle: string;
    canvasFilePath: string | null;
}

function CardFooter({ item, Icon, subtitle, canvasFilePath }: CardFooterProps) {
    const canOpen = !!item.originalPath || !!(item.assetId && getAsset(item.assetId));
    const sync = useEmbedSync(item.id);
    return (
        <div style={{
            padding: '8px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#0f0f18',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            color: '#e8e8ed',
            fontFamily: 'Outfit, system-ui, sans-serif',
        }}>
            <div style={{ color: '#10b981', flexShrink: 0 }}>
                <Icon size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.fileName}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{subtitle}</div>
            </div>
            <SyncBadge sync={sync} />
            {canOpen && (
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); openFileExternally(item, canvasFilePath); }}
                    title={canvasFilePath ? 'Open in app (edits sync back into canvas)' : 'Open externally'}
                    style={{ padding: 4, borderRadius: 5, background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', flexShrink: 0, cursor: 'pointer' }}
                >
                    <ExternalLink size={11} />
                </button>
            )}
        </div>
    );
}

/** Tiny dot-and-label indicator for embed sync state. Renders nothing when
 *  the item has never been opened in embed mode ('idle' with no timestamp). */
function SyncBadge({ sync }: { sync: ReturnType<typeof useEmbedSync> }) {
    if (sync.status === 'idle' && sync.at === 0) return null;
    const config = {
        syncing: { color: '#fbbf24', text: 'syncing…', title: 'Saving your edit back into the canvas' },
        synced:  { color: '#10b981', text: 'synced',     title: 'Edits are saved in the canvas file' },
        error:   { color: '#ef4444', text: 'error',      title: sync.error || 'Embed sync failed' },
        idle:    { color: '#6b7280', text: 'idle',       title: '' },
    }[sync.status];
    return (
        <div title={config.title} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9,
            color: config.color,
            flexShrink: 0,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
        }}>
            <span style={{
                width: 6, height: 6, borderRadius: 99,
                background: config.color,
                boxShadow: sync.status === 'syncing' ? `0 0 6px ${config.color}` : 'none',
                animation: sync.status === 'syncing' ? 'klypix-pulse 1s ease-in-out infinite' : undefined,
            }} />
            <span>{config.text}</span>
        </div>
    );
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function FileCardViewImpl(props: Props) {
    const card = <FileCardBody {...props} />;
    return (
        <>
            {card}
            {props.selected && (
                <ResizeHandle
                    itemId={props.item.id}
                    x={props.item.x}
                    y={props.item.y}
                    w={props.item.w}
                    h={props.item.h}
                    minW={160}
                    minH={60}
                />
            )}
        </>
    );
}

function FileCardBody({ item, selected }: Props) {
    const { state } = useCanvasStore();
    const canvasFilePath = state.filePath || null;
    const Icon = pickIcon(item.extension);
    const hasRichPreview = !!(item.previewDataUrl || item.previewSheet || item.previewHtml);
    // Render the sync badge in the no-preview body path too — useful for compact mode.
    const sync = useEmbedSync(item.id);

    // Small-size fallback: when the card's rendered screen dimensions
    // drop below a usable threshold, the footer text ("59 pages · 15MB")
    // eats all the height and the preview image area collapses to a
    // few pixels — confusing "dark rectangle with a bit of text"
    // instead of a recognizable file card. Switch to a compact dot
    // with the extension badge so the card is at least identifiable.
    const renderedW = item.w * state.view.zoom;
    const renderedH = item.h * state.view.zoom;
    const DOT_THRESHOLD_PX = 50;
    const useDotMode = renderedW < DOT_THRESHOLD_PX || renderedH < DOT_THRESHOLD_PX;

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        padding: useDotMode ? 0 : (hasRichPreview ? 0 : 12),
        borderRadius: 10,
        background: '#12121a',
        border: `1px solid ${selected ? 'rgba(16,185,129,0.7)' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.2)' : '0 4px 16px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: hasRichPreview ? 'column' : 'row',
        alignItems: hasRichPreview ? 'stretch' : 'center',
        justifyContent: useDotMode ? 'center' : undefined,
        gap: hasRichPreview ? 0 : 10,
        overflow: 'hidden',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    // Dot mode: card reduced to an extension pill so it stays
    // recognizable at any zoom without the layout blowing up.
    if (useDotMode) {
        const label = (item.extension || 'file').toUpperCase();
        return (
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <div style={{
                    color: '#10b981',
                    fontFamily: 'Outfit, system-ui, sans-serif',
                    fontWeight: 600,
                    fontSize: Math.max(8, Math.min(item.w, item.h) * 0.28),
                    letterSpacing: '0.05em',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                }}>
                    {label}
                </div>
            </div>
        );
    }

    // PDF preview card — uses a lazy hi-res re-render pass so enlarging the
    // card doesn't just stretch the captured low-res bitmap.
    if (item.previewDataUrl) {
        return (
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <div style={{ flex: 1, overflow: 'hidden', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <PdfPreviewImage item={item} />
                </div>
                <CardFooter item={item} Icon={Icon} subtitle={`${item.previewPages || 1} pages · ${formatBytes(item.fileSize)}`} canvasFilePath={canvasFilePath} />
            </div>
        );
    }

    // DOCX preview card (rendered HTML from mammoth)
    if (item.previewHtml) {
        const wc = item.previewWordCount;
        const subtitle = wc != null ? `${wc.toLocaleString()} words · ${formatBytes(item.fileSize)}` : formatBytes(item.fileSize);
        return (
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <div
                    onWheel={(e) => e.stopPropagation()}
                    style={{
                        flex: 1,
                        overflow: 'auto',
                        padding: '12px 14px',
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: 'rgba(255,255,255,0.82)',
                        fontFamily: 'Outfit, system-ui, sans-serif',
                        background: '#0a0a0f',
                    }}
                    className="docx-preview"
                    dangerouslySetInnerHTML={{ __html: item.previewHtml }}
                />
                <CardFooter item={item} Icon={Icon} subtitle={subtitle} canvasFilePath={canvasFilePath} />
            </div>
        );
    }

    // XLSX / CSV preview card
    if (item.previewSheet) {
        const ps = item.previewSheet;
        return (
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <div onWheel={(e) => e.stopPropagation()} style={{ flex: 1, overflow: 'auto', padding: '8px 10px', fontSize: 11, color: 'rgba(255,255,255,0.75)', fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                        <thead>
                            <tr>
                                {ps.headers.slice(0, 6).map((h, i) => (
                                    <th key={i} style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#10b981', fontWeight: 500, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h || '—'}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {ps.rows.map((r, ri) => (
                                <tr key={ri}>
                                    {r.slice(0, 6).map((c, ci) => (
                                        <td key={ci} style={{ padding: '2px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 80 }}>{c}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <CardFooter item={item} Icon={Icon} subtitle={`${ps.sheetName} · ${ps.totalRows} rows${ps.sheetCount > 1 ? ` · ${ps.sheetCount} sheets` : ''}`} canvasFilePath={canvasFilePath} />
            </div>
        );
    }

    return (
        <div data-canvas-item={item.id} style={style} className="no-drag">
            <div
                style={{
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    borderRadius: 8,
                    background: 'rgba(16,185,129,0.12)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#10b981',
                }}
            >
                <Icon size={20} />
            </div>
            <div style={{ flex: 1, minWidth: 0, color: '#e8e8ed', fontFamily: 'Outfit, system-ui, sans-serif' }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.fileName}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em', textTransform: 'uppercase', marginTop: 3 }}>
                    {item.extension} · {formatBytes(item.fileSize)}
                </div>
            </div>
            <SyncBadge sync={sync} />
            {(item.originalPath || (item.assetId && getAsset(item.assetId))) && (
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); openFileExternally(item, canvasFilePath); }}
                    title={canvasFilePath ? 'Open in app (edits sync back into canvas)' : 'Open externally'}
                    style={{
                        padding: 6,
                        borderRadius: 6,
                        background: 'rgba(255,255,255,0.04)',
                        color: 'rgba(255,255,255,0.5)',
                        flexShrink: 0,
                        cursor: 'pointer',
                    }}
                    className="hover:!bg-emerald-500/20 hover:!text-emerald-300 transition-colors"
                >
                    <ExternalLink size={13} />
                </button>
            )}
        </div>
    );
}

// Lazy hi-res re-render for a PDF card. The initial `previewDataUrl` is
// captured at scale 1.2 in the drop handler (small, fast). When the card
// grows bigger than that bitmap can serve crisply, we re-render the first
// page from the original PDF bytes at a scale that matches the on-screen
// pixel width — and swap it in. Debounced 220ms; cached per zoom bucket so
// a resize drag doesn't spam work.
function PdfPreviewImage({ item }: { item: FileItemType }) {
    const { state } = useCanvasStore();
    const [hiResSrc, setHiResSrc] = useState<string | null>(null);
    // Track if the CURRENT src failed to decode. Fall back to the
    // baseline previewDataUrl so the card never shows an empty black
    // rectangle — the captured low-res bitmap is always the safe
    // floor. Resets when either src changes.
    const [hiResFailed, setHiResFailed] = useState(false);
    // Cache keyed by effective pixel width rounded to 80px bins.
    const cacheRef = useRef<Map<number, string>>(new Map());
    const debounceRef = useRef<number | null>(null);
    // Inflight key so a fast resize doesn't produce a late swap-in.
    const latestKeyRef = useRef<number>(0);

    useEffect(() => {
        const effectivePx = Math.round((item.w * state.view.zoom) / 80) * 80;
        // Below this threshold the captured 1.2x bitmap is already crisp.
        const LOW_RES_PX = 480;
        if (effectivePx <= LOW_RES_PX) {
            setHiResSrc(null);
            return;
        }
        latestKeyRef.current = effectivePx;
        const cached = cacheRef.current.get(effectivePx);
        if (cached) { setHiResSrc(cached); return; }
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(async () => {
            const asset = item.assetId ? getAsset(item.assetId) : null;
            if (!asset) return;
            try {
                // Dynamic import — pdfjs already lazy-loaded in the drop handler.
                const pdfjs: any = await import('pdfjs-dist');
                // @ts-ignore Vite ?url import
                const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
                pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
                // pdfjs consumes the buffer; clone so the asset bytes stay intact.
                const data = asset.bytes.slice();
                const doc = await pdfjs.getDocument({ data }).promise;
                const page = await doc.getPage(1);
                const base = page.getViewport({ scale: 1 });
                // Target scale = effectivePx / pageWidth. Capped at 3 to bound
                // memory (a scale-6 on a large PDF can allocate > 100 MB).
                const targetScale = Math.min(3, Math.max(1.2, effectivePx / base.width));
                const viewport = page.getViewport({ scale: targetScale });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                await page.render({ canvasContext: ctx, viewport }).promise;
                const url = canvas.toDataURL('image/jpeg', 0.82);
                cacheRef.current.set(effectivePx, url);
                // Only apply if the user hasn't already resized past this bucket.
                if (latestKeyRef.current === effectivePx) setHiResSrc(url);
            } catch (err) {
                console.warn('[FileItem] hi-res PDF render failed:', err);
            }
        }, 220);
        return () => {
            if (debounceRef.current) window.clearTimeout(debounceRef.current);
        };
    }, [item.w, item.h, state.view.zoom, item.assetId]);

    // If hi-res failed to decode (rare — usually browser memory pressure
    // at extreme sizes), drop back to the baseline preview data URL so
    // the card always shows SOMETHING instead of a black rectangle.
    const resolvedSrc = (hiResSrc && !hiResFailed) ? hiResSrc : (item.previewDataUrl || '');
    return (
        <img
            key={resolvedSrc || 'none'}
            src={resolvedSrc}
            alt={item.fileName}
            onError={() => {
                if (hiResSrc) setHiResFailed(true);
            }}
            onLoad={() => setHiResFailed(false)}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', pointerEvents: 'none' }}
            draggable={false}
        />
    );
}
