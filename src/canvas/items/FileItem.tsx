import React, { useEffect, useRef, useState } from 'react';
import { File as FileIcon, FileText, FileSpreadsheet, FileImage, FileCode, FileVideo, FileAudio, FileArchive, ExternalLink, FolderOpen as FolderOpenIcon, Folder as FolderIcon, Eye as EyeIcon, EyeOff as EyeOffIcon, Loader2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import JSZip from 'jszip';
import type { FileItem as FileItemType } from './types';
import { getAsset, bytesToBase64 } from '../file/assetRegistry';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { useCanvasStore } from '../state/canvasStore';
import { setEmbedSync } from '../file/embedSyncStore';
import { useEmbedSync } from '../../hooks/useEmbedSync';
import { t, useLocale } from '../../i18n/strings';

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
            fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
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
        const label = item.isFolder ? 'FOLDER' : (item.extension || 'file').toUpperCase();
        return (
            <div data-canvas-item={item.id} style={style} className="no-drag">
                <div style={{
                    color: '#10b981',
                    fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
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

    // Folder card — tree of embedded files with per-leaf extract. The bytes
    // live inside the .klypix as a zipped asset, so moving the original
    // folder elsewhere doesn't break anything: the canvas is the source of
    // truth.
    if (item.isFolder && item.folderManifest) {
        // Folder cards have their own internal layout; override the row
        // flex defaults from the shared style so the tree fills top-down.
        const folderStyle: React.CSSProperties = {
            ...style,
            flexDirection: 'column',
            alignItems: 'stretch',
            padding: 0,
        };
        return (
            <div data-canvas-item={item.id} style={folderStyle} className="no-drag">
                <FolderCardBody item={item} />
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
                        fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
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
            <div style={{ flex: 1, minWidth: 0, color: '#e8e8ed', fontFamily: 'Thmanyah Sans, system-ui, sans-serif' }}>
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

/**
 * Open the WHOLE embedded folder as a .zip — Windows Explorer's built-in
 * compressed-folder view lets the user browse the embedded contents like
 * a real folder, drag files out, etc. The .klypix still holds the
 * authoritative bytes; this is read-only egress.
 */
async function openFolderAsZip(item: FileItemType): Promise<void> {
    const api: any = (window as any).electron?.canvas;
    if (!api?.openAssetBytes) return;
    const asset = item.assetId ? getAsset(item.assetId) : null;
    if (!asset) return;
    try {
        await api.openAssetBytes({
            fileName: `${item.fileName}.zip`,
            base64: bytesToBase64(asset.bytes),
        });
    } catch (err) {
        console.warn('[folder card] open-as-zip failed:', err);
    }
}

/**
 * Open a single file from inside a folder asset.
 *
 * Two paths, picked by whether the canvas is saved:
 *  1. Canvas IS saved (canvasFilePath set + embedOpenAndWatchLeaf available):
 *     ROUND-TRIP — extract to a per-leaf watched working file, launch in
 *     the OS default app, re-pack into the folder zip inside the .klypix
 *     on every save. The .klypix stays authoritative; edits flow back
 *     automatically.
 *  2. Canvas NOT saved (or embed IPC unavailable): READ-ONLY — extract to
 *     a temp file via canvas:open-asset-bytes and launch. Edits go to the
 *     temp file and are lost when the canvas is saved/closed (consistent
 *     with the single-file read-only fallback).
 */
async function openFolderLeaf(item: FileItemType, relPath: string, canvasFilePath: string | null): Promise<void> {
    const api: any = (window as any).electron?.canvas;
    if (!api) return;
    const asset = item.assetId ? getAsset(item.assetId) : null;
    if (!asset || !item.assetId) return;
    try {
        const zip = await JSZip.loadAsync(asset.bytes);
        const entry = zip.file(relPath);
        if (!entry) {
            console.warn('[folder card] entry not found:', relPath);
            return;
        }
        const bytes = await entry.async('uint8array');
        const base64 = bytesToBase64(bytes);

        // Round-trip embed: only if the canvas is saved (we need a target
        // file to repack into) AND the IPC is wired.
        if (canvasFilePath && api.embedOpenAndWatchLeaf) {
            setEmbedSync(item.id, { status: 'syncing' }, relPath);
            const res = await api.embedOpenAndWatchLeaf({
                canvasFilePath,
                itemId: item.id,
                folderAssetPath: `assets/${item.assetId}`,
                relPath,
                base64,
            });
            if (res?.ok) {
                setEmbedSync(item.id, { status: 'synced', workingPath: res.workingPath }, relPath);
                return;
            }
            setEmbedSync(item.id, { status: 'error', error: res?.error }, relPath);
            // Fall through to read-only on embed failure.
        }

        // Read-only fallback.
        if (api.openAssetBytes) {
            const leafName = relPath.split('/').pop() || 'file';
            await api.openAssetBytes({ fileName: leafName, base64 });
        }
    } catch (err) {
        console.warn('[folder card] extract failed:', err);
    }
}

function formatFolderBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function FolderCardBody({ item }: { item: FileItemType }) {
    useLocale();
    const { state } = useCanvasStore();
    const canvasFilePath = state.filePath || null;
    const manifest = item.folderManifest || [];
    const skipped = item.folderSkipped || [];
    const [busyPath, setBusyPath] = useState<string | null>(null);
    // Preview-on-hover: off by default to keep the card silent. Toggling
    // the eye icon flips it on; hovering a leaf row then pops a preview.
    const [previewEnabled, setPreviewEnabled] = useState(false);
    const [preview, setPreview] = useState<{ rect: DOMRect; entry: { path: string; size: number; mime: string } } | null>(null);
    const previewLeaveTimerRef = useRef<number | null>(null);
    const totalRaw = item.folderTotalSize ?? 0;
    const zipSize = item.fileSize;

    const openOne = async (relPath: string) => {
        if (busyPath) return;
        setBusyPath(relPath);
        try {
            await openFolderLeaf(item, relPath, canvasFilePath);
        } finally {
            setBusyPath(null);
        }
    };

    const onLeafHover = (rect: DOMRect, entry: { path: string; size: number; mime: string }) => {
        if (previewLeaveTimerRef.current) {
            window.clearTimeout(previewLeaveTimerRef.current);
            previewLeaveTimerRef.current = null;
        }
        setPreview({ rect, entry });
    };
    const onLeafLeave = () => {
        // Small delay so cursor traveling between rows doesn't flicker
        // the popup off + on.
        if (previewLeaveTimerRef.current) window.clearTimeout(previewLeaveTimerRef.current);
        previewLeaveTimerRef.current = window.setTimeout(() => setPreview(null), 80);
    };

    return (
        <>
            <div style={{
                padding: '10px 12px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                background: '#0f0f18',
                flexShrink: 0,
            }}>
                <div style={{ color: '#10b981', flexShrink: 0 }}>
                    <FolderOpenIcon size={16} />
                </div>
                <div style={{ flex: 1, minWidth: 0, color: '#e8e8ed', fontFamily: 'Thmanyah Sans, system-ui, sans-serif' }}>
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.fileName}
                    </div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em', textTransform: 'uppercase', marginTop: 2 }}>
                        FOLDER · {manifest.length} files · {formatFolderBytes(totalRaw)}
                        {zipSize !== totalRaw && (
                            <span style={{ color: 'rgba(16,185,129,0.6)' }}> · zip {formatFolderBytes(zipSize)}</span>
                        )}
                    </div>
                </div>
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setPreviewEnabled(v => !v); if (previewEnabled) setPreview(null); }}
                    title={previewEnabled ? t('canvas.folder_preview_off') : t('canvas.folder_preview_on')}
                    style={{
                        flexShrink: 0,
                        padding: 6,
                        borderRadius: 6,
                        background: previewEnabled ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.04)',
                        color: previewEnabled ? '#10b981' : 'rgba(255,255,255,0.5)',
                        cursor: 'pointer',
                        display: 'flex', alignItems: 'center',
                    }}
                    className="hover:!bg-white/10"
                >
                    {previewEnabled ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
                </button>
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); openFolderAsZip(item); }}
                    title={t('canvas.folder_open_embedded')}
                    style={{
                        flexShrink: 0,
                        padding: 6,
                        borderRadius: 6,
                        background: 'rgba(16,185,129,0.12)',
                        color: '#10b981',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 10,
                        fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                        fontWeight: 500,
                    }}
                    className="hover:!bg-emerald-500/25"
                >
                    <FolderOpenIcon size={12} />
                </button>
            </div>
            <div
                onWheel={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.8)',
                }}
            >
                {manifest.length === 0 && (
                    <div style={{ padding: '12px', fontSize: 11, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>
                        {t('canvas.folder_empty')}
                    </div>
                )}
                {manifest.map((entry) => (
                    <FolderLeafRow
                        key={entry.path}
                        itemId={item.id}
                        folderAssetId={item.assetId}
                        entry={entry}
                        isBusy={busyPath === entry.path}
                        previewEnabled={previewEnabled}
                        onOpen={() => openOne(entry.path)}
                        onPreview={onLeafHover}
                        onPreviewLeave={onLeafLeave}
                    />
                ))}
                {skipped.length > 0 && (
                    <div style={{
                        padding: '6px 10px',
                        marginTop: 4,
                        fontSize: 10,
                        color: 'rgba(251,191,36,0.7)',
                        background: 'rgba(251,191,36,0.05)',
                        borderTop: '1px solid rgba(251,191,36,0.15)',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>{skipped.length} {t('canvas.folder_skipped_label')}</div>
                        {skipped.slice(0, 6).map((s, i) => (
                            <div key={i} style={{ opacity: 0.8 }}>· {s.path} ({s.reason})</div>
                        ))}
                        {skipped.length > 6 && <div style={{ opacity: 0.5 }}>{t('canvas.folder_skipped_more').replace('{n}', String(skipped.length - 6))}</div>}
                    </div>
                )}
            </div>
            {previewEnabled && preview && item.assetId && (
                <FolderLeafPreview
                    assetId={item.assetId}
                    entry={preview.entry}
                    anchorRect={preview.rect}
                />
            )}
        </>
    );
}

/** A row inside the folder card's tree. Subscribes to its OWN leaf sync
 *  state (keyed by item.id + relPath) so a save event on leaf A doesn't
 *  re-render every other row in a 200-file folder. */
function FolderLeafRow({ itemId, folderAssetId, entry, isBusy, previewEnabled, onOpen, onPreview, onPreviewLeave }: {
    itemId: string;
    folderAssetId: string | undefined;
    entry: { path: string; size: number; mime: string };
    isBusy: boolean;
    previewEnabled: boolean;
    onOpen: () => void;
    onPreview: (rect: DOMRect, entry: { path: string; size: number; mime: string }) => void;
    onPreviewLeave: () => void;
}) {
    const depth = (entry.path.match(/\//g) || []).length;
    const leaf = entry.path.split('/').pop() || entry.path;
    const sync = useEmbedSync(itemId, entry.path);
    const rowRef = useRef<HTMLDivElement | null>(null);
    // 'busy' (parent's click-in-flight) and 'syncing' (Office app saving)
    // are visually distinct. busy wins because it's tied to the user's
    // active gesture; syncing is a background state.
    const showSyncing = !isBusy && sync.status === 'syncing';
    const showSynced = !isBusy && sync.status === 'synced';
    const showError = sync.status === 'error';

    // Drag-out: holding the row and dragging onto empty canvas promotes
    // the leaf to a standalone item. Payload includes folderAssetId so
    // the canvas drop handler can extract bytes from the right folder zip
    // (one canvas can have multiple folder cards with overlapping leaf
    // names). Stop propagation so the canvas's pan-on-drag doesn't kick in.
    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        if (!folderAssetId) return;
        e.stopPropagation();
        const payload = {
            folderAssetId,
            relPath: entry.path,
            fileName: leaf,
            size: entry.size,
            mime: entry.mime,
        };
        try {
            e.dataTransfer.setData('application/x-klypix-folder-leaf', JSON.stringify(payload));
            e.dataTransfer.effectAllowed = 'copy';
        } catch { /* dataTransfer can throw in some Electron edge cases */ }
    };

    return (
        <div
            ref={rowRef}
            draggable={!!folderAssetId}
            onDragStart={handleDragStart}
            onMouseEnter={() => {
                if (!previewEnabled) return;
                const rect = rowRef.current?.getBoundingClientRect();
                if (rect) onPreview(rect, entry);
            }}
            onMouseLeave={onPreviewLeave}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                paddingLeft: 8 + depth * 12,
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                cursor: 'pointer',
                background: isBusy ? 'rgba(16,185,129,0.08)' : showSyncing ? 'rgba(251,191,36,0.06)' : undefined,
            }}
            onClick={onOpen}
            title={showError ? `${entry.path} — ${sync.error || 'sync error'}` : entry.path}
            className="hover:!bg-white/[0.04]"
        >
            <span style={{ color: '#10b981', flexShrink: 0, display: 'inline-flex' }}>
                <FileIcon size={11} />
            </span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {leaf}
            </span>
            {showSyncing && (
                <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: 99, background: '#fbbf24', boxShadow: '0 0 4px #fbbf24', animation: 'klypix-pulse 1s ease-in-out infinite' }} title="syncing…" />
            )}
            {showSynced && (
                <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: 99, background: '#10b981' }} title="synced — edits saved into canvas" />
            )}
            {showError && (
                <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: 99, background: '#ef4444' }} title={sync.error || 'sync error'} />
            )}
            <span style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em' }}>
                {formatFolderBytes(entry.size)}
            </span>
            <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onOpen(); }}
                title={showSynced ? 'Open in app (edits sync back into canvas)' : 'Extract & open'}
                style={{
                    flexShrink: 0,
                    padding: 3,
                    borderRadius: 4,
                    background: 'rgba(255,255,255,0.04)',
                    color: isBusy ? '#10b981' : 'rgba(255,255,255,0.5)',
                    cursor: 'pointer',
                }}
                className="hover:!bg-emerald-500/20 hover:!text-emerald-300"
            >
                <ExternalLink size={10} />
            </button>
        </div>
    );
}

// ── Folder leaf preview cache ────────────────────────────────────────
// Module-level Map keyed by `${assetId}::${relPath}`. Generated previews
// stay until the cap (32) is hit, then oldest entries are evicted. Bytes
// are NOT cached — only the rendered representation (data URL for images,
// truncated text for code). Re-hovering a leaf the user already previewed
// is instant; first hover after dropping the folder pays the JSZip extract.

type LeafPreviewKind =
    | { kind: 'image'; dataUrl: string; w: number; h: number }
    | { kind: 'text'; text: string; truncated: boolean }
    | { kind: 'unsupported' }
    | { kind: 'too_large' };

const PREVIEW_CACHE_CAP = 32;
const previewCache = new Map<string, LeafPreviewKind>();

function cachePreview(key: string, value: LeafPreviewKind): void {
    previewCache.delete(key); // ensure insertion order = LRU
    previewCache.set(key, value);
    while (previewCache.size > PREVIEW_CACHE_CAP) {
        const oldest = previewCache.keys().next().value;
        if (oldest === undefined) break;
        previewCache.delete(oldest);
    }
}

const PREVIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024;   // 8MB — bigger than this, skip
const PREVIEW_TEXT_MAX_BYTES = 64 * 1024;          // 64KB cap, truncate beyond
const TEXT_EXTS = new Set([
    'txt', 'md', 'markdown', 'log', 'csv', 'tsv',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
    'py', 'pyw', 'rb', 'php', 'pl', 'sh', 'bash', 'zsh',
    'go', 'rs', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'swift', 'kt',
    'json', 'yml', 'yaml', 'toml', 'ini', 'env', 'cfg',
    'html', 'htm', 'css', 'scss', 'less', 'sass',
    'sql', 'r', 'lua', 'dart', 'vue', 'svelte',
    'gitignore', 'editorconfig',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

function extFromPath(p: string): string {
    const dot = p.lastIndexOf('.');
    if (dot < 0) return '';
    return p.slice(dot + 1).toLowerCase();
}

async function buildLeafPreview(folderBytes: Uint8Array, relPath: string, size: number): Promise<LeafPreviewKind> {
    const ext = extFromPath(relPath);
    const isImage = IMAGE_EXTS.has(ext);
    const isText = TEXT_EXTS.has(ext);
    if (!isImage && !isText) return { kind: 'unsupported' };
    if (isImage && size > PREVIEW_IMAGE_MAX_BYTES) return { kind: 'too_large' };

    const zip = await JSZip.loadAsync(folderBytes);
    const entry = zip.file(relPath);
    if (!entry) return { kind: 'unsupported' };

    if (isImage) {
        const bytes = await entry.async('uint8array');
        const mime = ext === 'svg' ? 'image/svg+xml'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif'
            : ext === 'bmp' ? 'image/bmp'
            : ext === 'ico' ? 'image/x-icon'
            : 'image/png';
        // Use a data URL rather than blob URL — avoids the "revoke
        // before the popup unmounts" cleanup dance and keeps the cache
        // entries serializable.
        const base64 = bytesToBase64(bytes);
        const dataUrl = `data:${mime};base64,${base64}`;
        // Probe natural dimensions for the popup's aspect ratio.
        const dim = await new Promise<{ w: number; h: number }>((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => resolve({ w: 0, h: 0 });
            img.src = dataUrl;
        });
        return { kind: 'image', dataUrl, w: dim.w, h: dim.h };
    }

    // Text: read up to cap, decode UTF-8, mark truncated.
    const bytes = await entry.async('uint8array');
    const truncated = bytes.byteLength > PREVIEW_TEXT_MAX_BYTES;
    const slice = truncated ? bytes.slice(0, PREVIEW_TEXT_MAX_BYTES) : bytes;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    } catch {
        return { kind: 'unsupported' };
    }
    return { kind: 'text', text, truncated };
}

// ── Folder leaf preview popup ────────────────────────────────────────
function FolderLeafPreview({ assetId, entry, anchorRect }: {
    assetId: string;
    entry: { path: string; size: number; mime: string };
    anchorRect: DOMRect;
}) {
    useLocale();
    const key = `${assetId}::${entry.path}`;
    const [preview, setPreview] = useState<LeafPreviewKind | 'loading' | null>(() => previewCache.get(key) ?? 'loading');

    useEffect(() => {
        const cached = previewCache.get(key);
        if (cached) { setPreview(cached); return; }
        setPreview('loading');
        let cancelled = false;
        const asset = getAsset(assetId);
        if (!asset) { setPreview({ kind: 'unsupported' }); return; }
        buildLeafPreview(asset.bytes, entry.path, entry.size).then(result => {
            if (cancelled) return;
            cachePreview(key, result);
            setPreview(result);
        }).catch(() => {
            if (cancelled) return;
            setPreview({ kind: 'unsupported' });
        });
        return () => { cancelled = true; };
    }, [key, assetId, entry.path, entry.size]);

    // Compute popup position: right of the row by default; flip left if
    // it would clip the viewport. Fixed positioning escapes the folder
    // card's overflow:hidden via portal.
    const POPUP_W = 320;
    const POPUP_H_MAX = 280;
    const GAP = 8;
    let left = anchorRect.right + GAP;
    if (left + POPUP_W > window.innerWidth - 8) {
        left = Math.max(8, anchorRect.left - POPUP_W - GAP);
    }
    let top = anchorRect.top;
    if (top + POPUP_H_MAX > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - POPUP_H_MAX - 8);
    }

    return createPortal(
        <div
            style={{
                position: 'fixed',
                left, top,
                width: POPUP_W,
                maxHeight: POPUP_H_MAX,
                zIndex: 9999,
                background: 'rgba(15,15,24,0.96)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(12px)',
                pointerEvents: 'none',  // never block the underlying row's hover
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                color: '#e8e8ed',
            }}
        >
            <div style={{
                padding: '6px 10px',
                fontSize: 11,
                color: 'rgba(255,255,255,0.5)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
            }}>
                {entry.path}
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
                {preview === 'loading' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                        <Loader2 size={12} className="animate-spin" />
                        {t('canvas.folder_preview_loading')}
                    </div>
                )}
                {preview && preview !== 'loading' && preview.kind === 'image' && (
                    <img
                        src={preview.dataUrl}
                        alt={entry.path}
                        style={{ maxWidth: '100%', maxHeight: POPUP_H_MAX - 30, objectFit: 'contain', display: 'block' }}
                        draggable={false}
                    />
                )}
                {preview && preview !== 'loading' && preview.kind === 'text' && (
                    <pre style={{
                        margin: 0,
                        padding: '8px 10px',
                        fontSize: 10,
                        lineHeight: 1.45,
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        color: 'rgba(255,255,255,0.82)',
                        whiteSpace: 'pre',
                        overflow: 'auto',
                        maxHeight: POPUP_H_MAX - 30,
                        width: '100%',
                        textAlign: 'left',
                        direction: 'ltr',
                    }}>
                        {preview.text}
                        {preview.truncated && (
                            <div style={{ marginTop: 6, color: 'rgba(251,191,36,0.7)' }}>… truncated at 64KB</div>
                        )}
                    </pre>
                )}
                {preview && preview !== 'loading' && preview.kind === 'unsupported' && (
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', textAlign: 'center', padding: 12 }}>
                        {t('canvas.folder_preview_unavailable')}
                    </div>
                )}
                {preview && preview !== 'loading' && preview.kind === 'too_large' && (
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', textAlign: 'center', padding: 12 }}>
                        {t('canvas.folder_preview_too_large')}
                    </div>
                )}
            </div>
        </div>,
        document.body,
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
