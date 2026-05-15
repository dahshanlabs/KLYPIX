'use client';

// Read-only canvas viewer for the share-by-URL recipient.
//
// Renders items + drawings at their world positions, wrapped in a pannable
// + zoomable transform. No editing, no selection, no toolbar — just look.
//
// Item-type coverage:
//   - text, box, image, container (basic)  → first-class render
//   - strokes (freehand) + drawn lines     → SVG render
//   - connections                          → SVG arrows between item edges
//   - code, file, video, audio, link,
//     canvas-link, approval                → placeholder card with name + icon
//
// Anything missing renders as "Unsupported in web viewer — download to view".

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type {
    ParsedCanvas,
    ParsedItem,
    ParsedStroke,
    ParsedLine,
    ParsedConnection,
} from '@/lib/parseKlypix';

interface Props {
    canvas: ParsedCanvas;
    onDownload: () => void;
}

interface ViewTransform {
    x: number;
    y: number;
    zoom: number;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

// Built-in theme presets. "Sender's" comes from canvas.settings.background
// when the file includes it. Stored in localStorage so the recipient's
// choice (override) persists across visits.
type ThemeChoice = 'sender' | 'dark' | 'paper';
const THEME_KEY = 'klypix:viewer:theme';
const PRESET_DARK = '#0a0a0f';
const PRESET_PAPER = '#f4efe6';

function readThemeChoice(): ThemeChoice {
    try {
        const raw = localStorage.getItem(THEME_KEY);
        if (raw === 'dark' || raw === 'paper' || raw === 'sender') return raw;
    } catch { /* no-op */ }
    return 'sender';
}

function writeThemeChoice(c: ThemeChoice) {
    try { localStorage.setItem(THEME_KEY, c); } catch { /* no-op */ }
}

function isDarkHex(hex: string): boolean {
    const h = hex.replace('#', '');
    if (h.length !== 6) return true;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    // Relative luminance — anything below 0.5 we treat as dark.
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

export const CanvasViewer: React.FC<Props> = ({ canvas, onDownload }) => {
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const [view, setView] = useState<ViewTransform>(() => fitInitialView(canvas));
    const [isPanning, setIsPanning] = useState(false);
    const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readThemeChoice());
    const panStateRef = useRef<{ startX: number; startY: number; startViewX: number; startViewY: number } | null>(null);

    // Resolve which background to actually apply. Sender's wins if available;
    // recipient can override via the toggle.
    const senderBg = canvas.settings?.background;
    const bgColor =
        themeChoice === 'dark' ? PRESET_DARK
            : themeChoice === 'paper' ? PRESET_PAPER
                : senderBg || PRESET_DARK;
    const isDark = isDarkHex(bgColor);
    const senderGridColor = canvas.settings?.gridColor;
    const senderGridStyle = canvas.settings?.gridStyle;

    const toggleTheme = useCallback(() => {
        setThemeChoice(prev => {
            const order: ThemeChoice[] = senderBg ? ['sender', 'dark', 'paper'] : ['dark', 'paper'];
            const idx = order.indexOf(prev);
            const next = order[(idx + 1) % order.length];
            writeThemeChoice(next);
            return next;
        });
    }, [senderBg]);

    // ── Pan: middle button OR left-button drag on empty surface ────────────
    const onPointerDown = useCallback((e: React.PointerEvent) => {
        // Only initiate pan if the click target is the surface itself (or the
        // transform child wrapper), not an item — that way the user can still
        // hover items without dragging the world.
        if (e.button !== 0 && e.button !== 1) return;
        const target = e.target as HTMLElement;
        if (!target.dataset.surface && !target.dataset.world) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        panStateRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            startViewX: view.x,
            startViewY: view.y,
        };
        setIsPanning(true);
    }, [view.x, view.y]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const st = panStateRef.current;
        if (!st) return;
        const dx = e.clientX - st.startX;
        const dy = e.clientY - st.startY;
        setView(v => ({ ...v, x: st.startViewX + dx, y: st.startViewY + dy }));
    }, []);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        if (panStateRef.current) {
            try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* no-op */ }
            panStateRef.current = null;
            setIsPanning(false);
        }
    }, []);

    // ── Zoom: wheel with optional ctrl (trackpad pinch arrives as wheel+ctrl) ──
    const onWheel = useCallback((e: WheelEvent) => {
        if (!surfaceRef.current) return;
        e.preventDefault();
        const rect = surfaceRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const delta = -e.deltaY * (e.ctrlKey ? 0.01 : 0.001);
        setView(v => {
            const newZoom = clamp(v.zoom * Math.exp(delta), MIN_ZOOM, MAX_ZOOM);
            const scale = newZoom / v.zoom;
            // Anchor zoom around mouse position so the point under the cursor
            // stays stationary as we scale.
            const newX = mouseX - (mouseX - v.x) * scale;
            const newY = mouseY - (mouseY - v.y) * scale;
            return { x: newX, y: newY, zoom: newZoom };
        });
    }, []);

    useEffect(() => {
        const el = surfaceRef.current;
        if (!el) return;
        // Wheel listener must be non-passive so preventDefault works to stop
        // page-scroll on trackpad pinch.
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [onWheel]);

    const fitAll = useCallback(() => setView(fitInitialView(canvas, surfaceRef.current)), [canvas]);
    const resetView = useCallback(() => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        setView({ x: rect ? rect.width / 2 : 0, y: rect ? rect.height / 2 : 0, zoom: 1 });
    }, []);

    // Grid color: prefer sender's, else luminance-based default (white on dark,
    // black on light). Alpha low so the grid stays a hint, not a foreground.
    const gridDotColor = senderGridColor
        ? hexWithAlpha(senderGridColor, 0.08)
        : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.08)');
    const gridImage = (senderGridStyle === 'off')
        ? 'none'
        : `radial-gradient(circle at 1px 1px, ${gridDotColor} 1px, transparent 0)`;

    return (
        <div className="relative w-full h-full overflow-hidden" style={{ background: bgColor }}>
            <div
                ref={surfaceRef}
                data-surface="true"
                className="absolute inset-0"
                style={{
                    cursor: isPanning ? 'grabbing' : 'grab',
                    backgroundImage: gridImage,
                    backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`,
                    backgroundPosition: `${view.x}px ${view.y}px`,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            >
                <div
                    data-world="true"
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        transformOrigin: '0 0',
                        transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                    }}
                >
                    {/* SVG layer for drawings + connections, sized to wrap the bounding box */}
                    <DrawingLayer
                        strokes={canvas.strokes}
                        lines={canvas.lines}
                        connections={canvas.connections}
                        items={canvas.items}
                        zoom={view.zoom}
                    />
                    {/* Items layer */}
                    {canvas.items.map(item => (
                        <ItemRenderer
                            key={item.id}
                            item={item}
                            assetUrls={canvas.assetUrls}
                        />
                    ))}
                </div>
            </div>

            {/* Top-right overlay: title + format chip + theme + download fallback.
                Chrome stays dark-on-translucent regardless of canvas bg so it's
                always readable on both paper and dark surfaces. */}
            <div className="absolute top-4 left-4 right-4 flex items-start justify-between pointer-events-none z-10">
                <div className="bg-black/60 backdrop-blur-md rounded-lg px-3 py-2 max-w-[60%] pointer-events-auto">
                    <div className="text-white text-sm font-medium truncate">{canvas.title}</div>
                    <div className="text-white/40 text-[10px] mt-0.5">{canvas.formatLabel}</div>
                </div>
                <div className="flex items-center gap-2 pointer-events-auto">
                    <button
                        onClick={toggleTheme}
                        className="bg-black/60 backdrop-blur-md hover:bg-black/70 border border-white/10 text-white/80 text-xs font-medium rounded-lg px-3 py-2"
                        title={
                            themeChoice === 'sender'
                                ? "Using sender's theme — click to switch to dark"
                                : themeChoice === 'dark'
                                    ? 'Dark theme — click to switch to paper'
                                    : 'Paper theme — click to ' + (senderBg ? "use sender's theme" : 'switch to dark')
                        }
                    >
                        {themeChoice === 'sender' ? 'Sender’s theme' : themeChoice === 'dark' ? 'Dark' : 'Paper'}
                    </button>
                    <button
                        onClick={onDownload}
                        className="bg-emerald-500/15 hover:bg-emerald-500/25 transition-colors border border-emerald-500/30 text-emerald-300 text-xs font-medium rounded-lg px-3 py-2"
                        title="Download the .klypix file to open in the desktop app"
                    >
                        Download .klypix
                    </button>
                </div>
            </div>

            {/* Bottom-left: zoom controls */}
            <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-black/60 backdrop-blur-md rounded-lg p-1 z-10">
                <ZoomButton onClick={() => setView(v => zoomCentered(v, 1 / 1.25, surfaceRef.current))}>−</ZoomButton>
                <button
                    onClick={resetView}
                    className="text-white/70 hover:text-white text-xs font-medium px-2 py-1 min-w-[48px]"
                    title="Reset to 100%"
                >
                    {Math.round(view.zoom * 100)}%
                </button>
                <ZoomButton onClick={() => setView(v => zoomCentered(v, 1.25, surfaceRef.current))}>+</ZoomButton>
                <div className="w-px h-4 bg-white/10 mx-1" />
                <button
                    onClick={fitAll}
                    className="text-white/70 hover:text-white text-[11px] font-medium px-2 py-1"
                    title="Fit canvas to view"
                >
                    Fit
                </button>
            </div>

            {/* Bottom-right: stats */}
            <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-md rounded-lg px-3 py-2 text-[10px] text-white/50 z-10">
                {canvas.items.length} item{canvas.items.length === 1 ? '' : 's'}
                {canvas.strokes.length > 0 && <> · {canvas.strokes.length} stroke{canvas.strokes.length === 1 ? '' : 's'}</>}
            </div>
        </div>
    );
};

// ── Item dispatcher ────────────────────────────────────────────────────

function ItemRenderer({ item, assetUrls }: { item: ParsedItem; assetUrls: Record<string, string> }) {
    const baseStyle: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        opacity: typeof item.opacity === 'number' ? item.opacity : 1,
        zIndex: item.zIndex,
        pointerEvents: 'none',
    };

    switch (item.type) {
        case 'text':
            return <TextRender item={item} baseStyle={baseStyle} />;
        case 'box':
            return <BoxRender item={item} baseStyle={baseStyle} />;
        case 'image':
            return <ImageRender item={item} assetUrls={assetUrls} baseStyle={baseStyle} />;
        case 'container':
            return <ContainerRender item={item} baseStyle={baseStyle} />;
        case 'code':
            return <CodeRender item={item} baseStyle={baseStyle} />;
        case 'file':
        case 'video':
        case 'audio':
        case 'link':
        case 'canvas-link':
        case 'approval':
            return <PlaceholderRender item={item} baseStyle={baseStyle} />;
        default:
            return <PlaceholderRender item={item} baseStyle={baseStyle} />;
    }
}

function TextRender({ item, baseStyle }: { item: ParsedItem; baseStyle: React.CSSProperties }) {
    const fontSize = (item.fontSize as number) || 14;
    const color = (item.color as string) || '#e8e8ed';
    const content = (item.content as string) || '';
    const border = item.border as boolean;
    const fontFamily = (item.fontFamily as string) || 'Outfit, system-ui, sans-serif';
    const heading = item.heading as boolean;
    const fillColor = (item.fillColor as string) || (border ? 'rgba(18,18,26,0.8)' : 'transparent');

    return (
        <div
            style={{
                ...baseStyle,
                background: fillColor,
                border: border ? `1px solid ${(item.borderColor as string) || 'rgba(255,255,255,0.2)'}` : 'none',
                borderRadius: border ? 8 : 0,
                padding: border ? 8 : 0,
                color,
                fontFamily,
                fontSize,
                fontWeight: heading ? 600 : 400,
                lineHeight: 1.35,
                overflow: 'hidden',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                textDecoration: ((item.textDecoration === 'underline' ? 'underline ' : '') + (item.strikethrough ? 'line-through' : '')).trim() || 'none',
            }}
        >
            {content}
        </div>
    );
}

function BoxRender({ item, baseStyle }: { item: ParsedItem; baseStyle: React.CSSProperties }) {
    const shape = (item.shape as string) || 'rect';
    const borderColor = (item.borderColor as string) || 'rgba(255,255,255,0.3)';
    const borderWidth = (item.borderWidth as number) || 1;
    const fillColor = (item.fillColor as string) || 'transparent';
    const borderRadius = (item.borderRadius as number) || 0;
    const lineStyle = (item.lineStyle as string) || 'solid';

    if (shape === 'circle') {
        return <div style={{ ...baseStyle, background: fillColor, border: `${borderWidth}px ${lineStyle} ${borderColor}`, borderRadius: '50%' }} />;
    }
    if (shape === 'triangle' || shape === 'diamond') {
        const pts = shape === 'triangle'
            ? `${(item.w as number) / 2},0 ${item.w},${item.h} 0,${item.h}`
            : `${(item.w as number) / 2},0 ${item.w},${(item.h as number) / 2} ${(item.w as number) / 2},${item.h} 0,${(item.h as number) / 2}`;
        return (
            <svg style={{ ...baseStyle }} width={item.w as number} height={item.h as number}>
                <polygon
                    points={pts}
                    fill={fillColor === 'transparent' ? 'none' : fillColor}
                    stroke={borderColor}
                    strokeWidth={borderWidth}
                    strokeDasharray={dashArray(lineStyle, borderWidth)}
                />
            </svg>
        );
    }
    return (
        <div
            style={{
                ...baseStyle,
                background: fillColor,
                border: `${borderWidth}px ${lineStyle} ${borderColor}`,
                borderRadius,
            }}
        />
    );
}

function ImageRender({ item, assetUrls, baseStyle }: { item: ParsedItem; assetUrls: Record<string, string>; baseStyle: React.CSSProperties }) {
    const assetId = (item.assetId as string) || '';
    const legacySrc = (item.src as string) || '';
    const url = assetUrls[assetId] || (legacySrc && legacySrc.startsWith('data:') ? legacySrc : '');
    if (!url) {
        return (
            <div style={{ ...baseStyle, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
                missing image
            </div>
        );
    }
    return (
        <img
            src={url}
            alt={(item.fileName as string) || 'image'}
            style={{ ...baseStyle, objectFit: 'contain' }}
            draggable={false}
        />
    );
}

function ContainerRender({ item, baseStyle }: { item: ParsedItem; baseStyle: React.CSSProperties }) {
    const title = (item.title as string) || (item.label as string) || 'Group';
    return (
        <div
            style={{
                ...baseStyle,
                background: 'rgba(255,255,255,0.02)',
                border: '1px dashed rgba(255,255,255,0.15)',
                borderRadius: 12,
            }}
        >
            <div style={{ position: 'absolute', top: -22, left: 4, fontSize: 10, color: 'rgba(255,255,255,0.4)', fontFamily: 'Outfit, system-ui, sans-serif' }}>
                {title}
            </div>
        </div>
    );
}

function CodeRender({ item, baseStyle }: { item: ParsedItem; baseStyle: React.CSSProperties }) {
    const content = (item.content as string) || '';
    const lang = (item.language as string) || 'text';
    return (
        <div
            style={{
                ...baseStyle,
                background: 'rgba(15,15,24,0.95)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                color: '#e8e8ed',
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                fontSize: 11,
                padding: 8,
                overflow: 'hidden',
            }}
        >
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {lang}
            </div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</pre>
        </div>
    );
}

function PlaceholderRender({ item, baseStyle }: { item: ParsedItem; baseStyle: React.CSSProperties }) {
    const label = (item.fileName as string) || (item.url as string) || (item.title as string) || item.type;
    return (
        <div
            style={{
                ...baseStyle,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                color: 'rgba(255,255,255,0.6)',
                fontFamily: 'Outfit, system-ui, sans-serif',
                fontSize: 11,
                padding: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                overflow: 'hidden',
            }}
        >
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {item.type}
            </div>
            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 'auto' }}>
                download .klypix to view
            </div>
        </div>
    );
}

// ── Drawing layer (SVG: strokes, lines, connections) ──────────────────────

function DrawingLayer({
    strokes,
    lines,
    connections,
    items,
    zoom,
}: {
    strokes: ParsedStroke[];
    lines: ParsedLine[];
    connections: ParsedConnection[];
    items: ParsedItem[];
    zoom: number;
}) {
    if (strokes.length === 0 && lines.length === 0 && connections.length === 0) return null;

    // Compute total bbox so the SVG covers all drawings. Use a generous range
    // so we don't have to recompute on view changes; the transform already
    // handles positioning.
    const bbox = computeBBox(items, strokes, lines);
    const pad = 200;
    const svgW = bbox.maxX - bbox.minX + pad * 2;
    const svgH = bbox.maxY - bbox.minY + pad * 2;
    const offX = bbox.minX - pad;
    const offY = bbox.minY - pad;

    const itemCenter = (id: string): { x: number; y: number } | null => {
        const it = items.find(i => i.id === id);
        if (!it) return null;
        return { x: (it.x as number) + (it.w as number) / 2, y: (it.y as number) + (it.h as number) / 2 };
    };

    return (
        <svg
            style={{ position: 'absolute', left: offX, top: offY, pointerEvents: 'none' }}
            width={svgW}
            height={svgH}
            viewBox={`${offX} ${offY} ${svgW} ${svgH}`}
        >
            <defs>
                <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L0,6 L9,3 z" fill="rgba(255,255,255,0.5)" />
                </marker>
            </defs>
            {/* Freehand strokes */}
            {strokes.map(s => (
                <polyline
                    key={s.id}
                    points={s.points.map(p => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={s.size}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ))}
            {/* Drawn lines */}
            {lines.map(l => (
                <line
                    key={l.id}
                    x1={l.x1}
                    y1={l.y1}
                    x2={l.x2}
                    y2={l.y2}
                    stroke={l.color}
                    strokeWidth={l.thickness}
                    strokeLinecap="round"
                    markerEnd={l.arrowEnd ? 'url(#arrowhead)' : undefined}
                    markerStart={l.arrowStart ? 'url(#arrowhead)' : undefined}
                />
            ))}
            {/* Connections (arrow between item centers) */}
            {connections.map(c => {
                const a = itemCenter(c.fromItemId);
                const b = itemCenter(c.toItemId);
                if (!a || !b) return null;
                return (
                    <line
                        key={c.id}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={c.color || 'rgba(255,255,255,0.4)'}
                        strokeWidth={c.thickness || 1.5}
                        strokeDasharray="6 4"
                        markerEnd="url(#arrowhead)"
                    />
                );
            })}
        </svg>
    );
    void zoom; // Not used yet — could counter-zoom stroke widths later.
}

// ── Helpers ────────────────────────────────────────────────────────────

function ZoomButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="text-white/70 hover:text-white text-sm font-medium w-7 h-7 flex items-center justify-center rounded hover:bg-white/5"
        >
            {children}
        </button>
    );
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

function hexWithAlpha(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function zoomCentered(view: ViewTransform, factor: number, surface: HTMLDivElement | null): ViewTransform {
    const newZoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const rect = surface?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    const scale = newZoom / view.zoom;
    return {
        x: cx - (cx - view.x) * scale,
        y: cy - (cy - view.y) * scale,
        zoom: newZoom,
    };
}

function dashArray(lineStyle: string, w: number): string | undefined {
    if (lineStyle === 'dashed') return `${w * 6} ${w * 4}`;
    if (lineStyle === 'dotted') return `${w} ${w * 2}`;
    return undefined;
}

function computeBBox(items: ParsedItem[], strokes: ParsedStroke[], lines: ParsedLine[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        if (typeof it.x !== 'number') continue;
        minX = Math.min(minX, it.x);
        minY = Math.min(minY, it.y);
        maxX = Math.max(maxX, it.x + (it.w as number));
        maxY = Math.max(maxY, it.y + (it.h as number));
    }
    for (const s of strokes) for (const p of s.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    for (const l of lines) {
        minX = Math.min(minX, l.x1, l.x2);
        minY = Math.min(minY, l.y1, l.y2);
        maxX = Math.max(maxX, l.x1, l.x2);
        maxY = Math.max(maxY, l.y1, l.y2);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    return { minX, minY, maxX, maxY };
}

function fitInitialView(canvas: ParsedCanvas, surface?: HTMLDivElement | null): ViewTransform {
    const bbox = computeBBox(canvas.items, canvas.strokes, canvas.lines);
    const contentW = bbox.maxX - bbox.minX;
    const contentH = bbox.maxY - bbox.minY;
    if (contentW <= 0 || contentH <= 0) return { x: 0, y: 0, zoom: 1 };

    // Assume window-ish surface size if we don't yet have a ref (initial mount).
    const surfaceW = surface?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1200);
    const surfaceH = surface?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800);
    const pad = 80;
    const zoomX = (surfaceW - pad * 2) / contentW;
    const zoomY = (surfaceH - pad * 2) / contentH;
    const zoom = clamp(Math.min(zoomX, zoomY), MIN_ZOOM, 1.5);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    return {
        x: surfaceW / 2 - cx * zoom,
        y: surfaceH / 2 - cy * zoom,
        zoom,
    };
}
