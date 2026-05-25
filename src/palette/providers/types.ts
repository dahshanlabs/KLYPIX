// Phase 23 — Command Palette provider contract.
//
// Every result source (Calculator, Klypix Search, Clipboard, Apps, Files,
// Web, AI) implements PaletteProvider. The palette UI is purely a
// driver: it polls providers for results, ranks them by score × frecency,
// renders them, and routes keyboard actions to the highlighted row.
//
// Design notes:
//   - Providers MAY return synchronously (calculator, in-memory search) OR
//     stream via AsyncIterable (file system walks, web fetch). The palette
//     UI handles both shapes uniformly so a slow provider can produce
//     partial results without blocking faster ones.
//   - A `prefix` (e.g. "clip:" or "?") routes the query exclusively to
//     one provider. The colon-prefix convention matches Raycast / Alfred.
//   - Every result MUST have a stable `id` so frecency persists across
//     sessions and React keys are stable across re-renders.
//   - `primaryAction` is the Enter behavior. `secondaryActions` are
//     Tab-cyclable alternatives — each with an optional `chord` label
//     shown in the footer hint strip when the result is highlighted.

import type React from 'react';

export interface PaletteAction {
    /** Display label shown in the footer hint when this row is highlighted. */
    label: string;
    /** Keyboard chord hint (rendered as a kbd-style pill). Optional —
     *  primary actions are implicitly Enter, so they can omit chord. */
    chord?: string;
    /** Invoked when the user triggers this action. The palette closes
     *  automatically after the handler resolves unless `keepOpen` is true. */
    handler: () => void | Promise<void>;
    /** When true, the palette stays open after this action runs. Useful for
     *  actions like "Pin clipboard item" where the user might want to do
     *  it to several rows in sequence. */
    keepOpen?: boolean;
}

export interface PaletteResult {
    /** Stable per-source-per-item id (e.g. "calc:3+4", "klypix:canvas:item:uuid",
     *  "clip:row-id"). Used for React keys, frecency persistence, dedupe. */
    id: string;
    /** Provider id this result came from. Set automatically by the palette
     *  driver — providers DON'T need to fill this in; we overwrite. */
    source?: string;
    /** Main display line. */
    title: string;
    /** Dimmer second line — e.g. "= 42", "from chat 3d ago", "C:\Users\...". */
    subtitle?: string;
    /** Lucide-style React icon node, sized small (~12-14px). */
    icon?: React.ReactNode;
    /** Color hex for the result's source badge/accent. Defaults to white/30. */
    accent?: string;
    /** Enter behavior. */
    primaryAction: PaletteAction;
    /** Tab-cyclable alternatives. Order matters: index 0 = first Tab,
     *  index 1 = second Tab, etc. */
    secondaryActions?: PaletteAction[];
    /** Fuzzy-match score from Fuse [0..1]. Lower = better match. Higher
     *  scores get sorted down. Calculator and exact-match providers
     *  typically force this to 0. */
    score?: number;
    /** When truthy, the result is rendered with a "loading" state — used
     *  by streaming providers (AI, web fetch) to show in-flight rows. */
    pending?: boolean;
    /** Best-in-class detail pane: when the row is highlighted, render
     *  this content in the right-side preview panel. Providers fill it
     *  for rows whose UX benefits from a larger view: image clipboard
     *  rows (full preview), file rows (parent path tree), text rows
     *  with long body (full text). Returning null = no detail panel for
     *  this row (palette collapses the panel area). */
    detail?: () => React.ReactNode;
}

export interface PaletteProviderContext {
    /** Abort signal for the query — when the user types again, the previous
     *  query's signal aborts. Providers MUST honor this for any async work
     *  so we don't pile up zombie network requests. */
    signal: AbortSignal;
}

export interface PaletteProvider {
    /** Stable id ('calc', 'klypix', 'clip', 'apps', 'files', 'web', 'ai'). */
    id: string;
    /** When set, the query is routed EXCLUSIVELY to this provider when its
     *  raw text starts with the prefix. Prefix is consumed from the input
     *  before being passed to query(). Examples: 'clip:', '?'. */
    prefix?: string;
    /** Compute results for the given input. May return a Promise of an
     *  array (one-shot) or an AsyncIterable of arrays (streaming — each
     *  yielded chunk REPLACES the previous results for this provider in
     *  the merged list). */
    query(input: string, ctx: PaletteProviderContext): Promise<PaletteResult[]> | AsyncIterable<PaletteResult[]>;
    /** Optional empty-state results when the user has typed nothing yet
     *  — typically pinned items, recents, or frecency-ranked history. */
    emptyState?(): PaletteResult[];
    /** Lower number = higher priority when multiple providers return for
     *  the same query. Defaults to 100 if omitted. Used as a tie-breaker
     *  when score × frecency are close. */
    weight?: number;
}

/** What the palette UI receives back from query — internal shape with
 *  source filled in + computed final rank. Not exported to providers. */
export interface RankedResult extends PaletteResult {
    source: string;
    /** Final composite score used for sorting. Lower = higher in the list.
     *  Computed as fuseScore × (1 / frecencyBoost). */
    rank: number;
}
