import type { ItemStatus } from './types';

// User-customizable color per status. Defaults match §24H ("green = complete,
// red = urgent, etc.") and are overridable in localStorage so a team can
// re-map meanings (e.g. "blocked = black" if they prefer).
//
// Shape:
//   { [status]: "#rrggbb" }
// Missing keys fall back to DEFAULT_STATUS_COLORS.

const LS_KEY = 'klpx.canvas.statusColors.v1';

export const DEFAULT_STATUS_COLORS: Record<ItemStatus, string> = {
    none:        '',
    todo:        '#6b6b80',
    in_progress: '#f5a623',
    in_review:   '#3b82f6',
    done:        '#2dd4a0',
    blocked:     '#ef4444',
    waiting:     '#a855f7',
};

type PartialColors = Partial<Record<ItemStatus, string>>;

let overrides: PartialColors = loadOverrides();

function loadOverrides(): PartialColors {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: PartialColors = {};
        for (const k of Object.keys(parsed)) {
            if (k in DEFAULT_STATUS_COLORS && typeof parsed[k] === 'string') {
                out[k as ItemStatus] = parsed[k];
            }
        }
        return out;
    } catch { return {}; }
}

export function getStatusColor(status: ItemStatus): string {
    return overrides[status] || DEFAULT_STATUS_COLORS[status] || '';
}

export function setStatusColor(status: ItemStatus, color: string | null): void {
    if (color === null) delete overrides[status];
    else overrides[status] = color;
    try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch { /* ignore */ }
}

export function resetStatusColors(): void {
    overrides = {};
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

export function getAllStatusColors(): Record<ItemStatus, string> {
    const out = { ...DEFAULT_STATUS_COLORS };
    for (const [k, v] of Object.entries(overrides)) {
        if (v) out[k as ItemStatus] = v;
    }
    return out;
}
