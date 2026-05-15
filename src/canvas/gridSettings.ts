import { useSyncExternalStore } from 'react';

// Shared canvas-grid + background settings. Persists to localStorage
// and notifies any component using `useGridSettings` on change.
// Consumers (KlypixCanvas + CanvasSettingsPopover) stay in sync
// without prop-drilling.

export type GridStyle = 'dots' | 'lines' | 'off';

export interface GridSettings {
    style: GridStyle;
    // Grid tint, hex. Rendered at a luminance-aware low alpha so the
    // grid stays a hint, not a foreground pattern.
    color: string;
    // Canvas surface color, hex. Two presets are offered in the UI
    // (Dark / Paper) plus a free custom picker.
    background: string;
}

export const CANVAS_BG_DARK = '#0a0a0f';
export const CANVAS_BG_PAPER = '#f4efe6';

const KEY = 'canvas_grid_settings';
const DEFAULT: GridSettings = { style: 'dots', color: '#ffffff', background: CANVAS_BG_DARK };

const listeners = new Set<() => void>();

const HEX_RE = /^#[0-9a-f]{6}$/i;

function load(): GridSettings {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT;
        const parsed = JSON.parse(raw);
        // Migrate legacy 'dark'|'light' string values to hex.
        let bg: string = DEFAULT.background;
        if (typeof parsed.background === 'string') {
            if (HEX_RE.test(parsed.background)) bg = parsed.background;
            else if (parsed.background === 'light') bg = CANVAS_BG_PAPER;
            else if (parsed.background === 'dark') bg = CANVAS_BG_DARK;
        }
        return {
            style: parsed.style === 'lines' || parsed.style === 'off' ? parsed.style : 'dots',
            color: typeof parsed.color === 'string' && HEX_RE.test(parsed.color) ? parsed.color : DEFAULT.color,
            background: bg,
        };
    } catch {
        return DEFAULT;
    }
}

let cache: GridSettings = load();

function emit() {
    listeners.forEach((l) => l());
}

export function setGridSettings(patch: Partial<GridSettings>) {
    const next = { ...cache, ...patch };
    // Smart default: when the background luminance flips (dark↔light),
    // if the grid color is still the obvious default for the OLD side
    // (white on dark, black on light), flip it so the grid stays
    // visible. Any explicit non-default color the user picked is kept.
    if (patch.background && patch.background !== cache.background) {
        const wasDark = isDarkBackground(cache.background);
        const isDark = isDarkBackground(next.background);
        if (wasDark !== isDark) {
            if (wasDark && cache.color.toLowerCase() === '#ffffff') next.color = '#000000';
            else if (!wasDark && cache.color.toLowerCase() === '#000000') next.color = '#ffffff';
        }
    }
    if (next.style === cache.style && next.color === cache.color && next.background === cache.background) return;
    cache = next;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
    emit();
}

function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function getSnapshot() {
    return cache;
}

export function useGridSettings(): GridSettings {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Non-hook accessor for the current grid settings — used by code paths
// outside React's render cycle (event handlers, agent tool executors,
// paste handlers) that need to read canvas background to pick a
// theme-aware default text color at item-creation time.
export function getCurrentGridSettings(): GridSettings {
    return cache;
}

// The two "neutral" text colors KLYPIX uses for new items: light grey
// for dark canvases, near-black for light canvases. Picked to read
// clearly on the matching default backgrounds without needing the old
// halo workaround. Users can still override per-item via the color
// pickers; this just decides what new items START with.
export const TEXT_COLOR_LIGHT = '#e8e8ed';
export const TEXT_COLOR_DARK = '#1a1a1f';

// Pick the default text color that contrasts a given canvas background.
// Drives every text-item-creation path (T-tool, paste, voice, agent,
// box-to-text conversion, link-unlink) so a fresh item always lands
// readable on the current theme.
export function defaultTextColorFor(canvasBg: string): string {
    return isDarkBackground(canvasBg) ? TEXT_COLOR_LIGHT : TEXT_COLOR_DARK;
}

// Convert a hex color (#rrggbb) + alpha (0..1) to an rgba() string.
export function hexToRgba(hex: string, alpha: number): string {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return `rgba(255,255,255,${alpha})`;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// Perceived luminance (0..1) via the standard Rec. 709 weighting. Used
// to decide the "is this a dark or light background?" question without
// forcing the user to tag it.
export function luminance(hex: string): number {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return 0;
    const r = parseInt(m[1], 16) / 255;
    const g = parseInt(m[2], 16) / 255;
    const b = parseInt(m[3], 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isDarkBackground(hex: string): boolean {
    return luminance(hex) < 0.5;
}

// Grid alpha tuned per background: dark bg needs less to feel subtle,
// light bg needs more or the dots vanish into the page.
export function gridAlphaFor(bgHex: string): number {
    return isDarkBackground(bgHex) ? 0.09 : 0.20;
}
