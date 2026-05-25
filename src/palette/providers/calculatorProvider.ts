// Phase 23 Day 2 — Calculator provider for the Command Palette.
//
// Best-in-class scope:
//   - mathjs grammar (arithmetic, parens, %, ^, sqrt, sin/cos, log, etc.)
//   - Units (50 mph + 30 km/h, 5 ft 2 in to cm)
//   - Currency conversions cached daily from exchangerate.host
//   - Date math: today(), daysUntil(date), daysSince(date)
//   - Variables that persist for one palette session (a = 5; b = a * 2)
//   - Lazy-loads mathjs on first use (~150KB) — Vite splits it into its
//     own chunk so chat-only users who never open the palette pay nothing
//
// Output: single PaletteResult with title = result, subtitle = input.
//   Primary action: copy result to clipboard
//   Secondary 1   : open as chat message (handled by Day 4 send-to-chat)
//   Secondary 2   : drop as text item on current canvas

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Calculator } from 'lucide-react';
import React from 'react';

// mathjs is heavy (~150KB minified). Lazy-load via dynamic import so it
// only enters the renderer chunk when the palette actually evaluates an
// expression. Cached after first load.
let mathjsCache: any = null;
let mathjsLoadPromise: Promise<any> | null = null;
async function getMathjs(): Promise<any> {
    if (mathjsCache) return mathjsCache;
    if (!mathjsLoadPromise) {
        mathjsLoadPromise = import('mathjs').then(mod => {
            // mathjs ships .create() factory; build a scoped instance so
            // we can extend its scope without affecting other consumers.
            const instance = mod.create(mod.all);
            registerCustomFunctions(instance);
            mathjsCache = instance;
            return instance;
        });
    }
    return mathjsLoadPromise;
}

// Per-palette-session variable scope. Reset when the palette closes (caller
// invokes resetCalcScope()). Persisting across open/close would surprise
// users who don't realize 'a' from a previous session is still bound.
let calcScope: Record<string, any> = {};
export function resetCalcScope(): void { calcScope = {}; }

function registerCustomFunctions(mj: any) {
    // Date math
    const today = () => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    };
    const daysUntil = (target: Date) => {
        const t = target instanceof Date ? target : new Date(target);
        return Math.ceil((t.getTime() - today().getTime()) / 86_400_000);
    };
    const daysSince = (target: Date) => {
        const t = target instanceof Date ? target : new Date(target);
        return Math.floor((today().getTime() - t.getTime()) / 86_400_000);
    };
    mj.import(
        { today, daysUntil, daysSince },
        { override: true },
    );
}

// ── Currency rates (cached daily) ────────────────────────────────────

const CURRENCY_CACHE_KEY = 'klypix:palette:fxRates:v1';
const CURRENCY_TTL_MS = 24 * 60 * 60 * 1000;  // 1 day

interface CachedRates {
    fetchedAt: number;
    base: string;
    rates: Record<string, number>;
}

let ratesCache: CachedRates | null = null;
let ratesLoadPromise: Promise<CachedRates | null> | null = null;

async function getRates(): Promise<CachedRates | null> {
    if (ratesCache && Date.now() - ratesCache.fetchedAt < CURRENCY_TTL_MS) {
        return ratesCache;
    }
    try {
        const raw = localStorage.getItem(CURRENCY_CACHE_KEY);
        if (raw) {
            const parsed: CachedRates = JSON.parse(raw);
            if (parsed && Date.now() - parsed.fetchedAt < CURRENCY_TTL_MS) {
                ratesCache = parsed;
                return parsed;
            }
        }
    } catch { /* fall through */ }
    // Stale or absent — fetch fresh, but only once per palette open (avoid
    // hammering on every keystroke).
    if (!ratesLoadPromise) {
        ratesLoadPromise = fetch('https://api.exchangerate.host/latest?base=USD')
            .then(r => r.ok ? r.json() : null)
            .then(json => {
                if (!json || typeof json.rates !== 'object') return null;
                const next: CachedRates = {
                    fetchedAt: Date.now(),
                    base: json.base || 'USD',
                    rates: json.rates,
                };
                try { localStorage.setItem(CURRENCY_CACHE_KEY, JSON.stringify(next)); } catch { /* quota */ }
                ratesCache = next;
                return next;
            })
            .catch(() => null)
            .finally(() => { ratesLoadPromise = null; });
    }
    return ratesLoadPromise;
}

/** Heuristic: does the input LOOK like a currency conversion?
 *  Matches "25 USD to EUR", "100 eur in jpy", etc. */
function parseCurrencyConversion(input: string): { amount: number; from: string; to: string } | null {
    const m = input.trim().match(/^([\d.,]+)\s*([a-z]{3})\s+(?:to|in)\s+([a-z]{3})$/i);
    if (!m) return null;
    const amount = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(amount)) return null;
    return { amount, from: m[2].toUpperCase(), to: m[3].toUpperCase() };
}

function fmt(n: number): string {
    if (!isFinite(n)) return String(n);
    if (Math.abs(n) >= 1e6 || (n !== 0 && Math.abs(n) < 1e-4)) {
        return n.toExponential(4);
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

async function evalInput(input: string): Promise<{ display: string; raw: string } | null> {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;

    // Currency shortcut FIRST — mathjs doesn't know live FX rates.
    const cur = parseCurrencyConversion(trimmed);
    if (cur) {
        const rates = await getRates();
        if (rates) {
            const fromRate = cur.from === rates.base ? 1 : rates.rates[cur.from];
            const toRate = cur.to === rates.base ? 1 : rates.rates[cur.to];
            if (fromRate && toRate) {
                const usd = cur.amount / fromRate;
                const result = usd * toRate;
                const dateStr = new Date(rates.fetchedAt).toISOString().slice(0, 10);
                return {
                    display: `${fmt(result)} ${cur.to}`,
                    raw: `${cur.amount} ${cur.from} = ${fmt(result)} ${cur.to}  (rates ${dateStr})`,
                };
            }
        }
        // No rates → fall through to mathjs which will probably fail gracefully
    }

    let mj: any;
    try {
        mj = await getMathjs();
    } catch {
        return null;
    }

    try {
        const result = mj.evaluate(trimmed, calcScope);
        if (result === undefined || result === null) return null;
        // Skip non-numeric / non-unit / non-date results so we don't surface
        // every random identifier the user types as a "calc" row.
        const kind = typeof result;
        if (kind === 'function') return null;
        if (kind === 'string' && !/^[\d.,+\-*/=\s%^()]/.test(trimmed)) {
            return null;
        }
        const display = mj.format(result, { precision: 14 });
        return { display, raw: `${trimmed} = ${display}` };
    } catch {
        return null;
    }
}

// ── Provider ──────────────────────────────────────────────────────────

export const calculatorProvider: PaletteProvider = {
    id: 'calc',
    weight: 0.3,  // calculator results boosted to the top

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const out = await evalInput(input);
        if (!out) return [];
        const id = `calc:${input}`;
        return [{
            id,
            title: out.display,
            subtitle: out.raw,
            accent: '#10b981',
            icon: React.createElement(Calculator, { size: 14 }),
            score: 0,                 // perfect rank — always at the top when valid
            primaryAction: {
                label: 'Copy result',
                toast: 'Copied result',
                handler: async () => {
                    try { await navigator.clipboard.writeText(out.display); } catch { /* swallow */ }
                },
            },
            secondaryActions: [
                {
                    label: 'Copy expression',
                    chord: 'Shift+Enter',
                    handler: async () => {
                        try { await navigator.clipboard.writeText(out.raw); } catch { /* swallow */ }
                    },
                },
                // Index 1 = "send to chat" semantic (Ctrl+Enter). Wired in
                // Day 4 once the chat-input bridge lives; today copies for
                // a safe fallback so the chord doesn't no-op silently.
                {
                    label: 'Send to chat',
                    chord: 'Ctrl+Enter',
                    handler: async () => {
                        try {
                            await navigator.clipboard.writeText(out.raw);
                        } catch { /* swallow */ }
                    },
                },
                // Index 2 = "send to canvas" — same caveat.
                {
                    label: 'Add to canvas',
                    chord: 'Ctrl+Shift+Enter',
                    handler: async () => {
                        // Day 4 wires this to ADD_ITEM with a TextItem. For
                        // Day 2 we fall back to clipboard so users can paste.
                        try { await navigator.clipboard.writeText(out.raw); } catch { /* swallow */ }
                    },
                },
            ],
        }];
    },
};
