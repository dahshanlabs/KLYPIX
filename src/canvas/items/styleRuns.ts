// Rich-text run math for TextItem.styleRuns.
//
// Runs are half-open [start, end) spans over a text item's `content`
// string carrying overrides for color / bold / italic / underline /
// strikethrough / fontSize. Unset properties inherit the item-level
// defaults (item.color, item.fontWeight, etc.).
//
// The three primitives are:
//   applyStyleToRange — layer a style patch onto [start, end), splitting
//       existing runs at the boundaries and merging the patch into any
//       run chunks that fall inside the range.
//   shiftRuns — translate run offsets after a text insert/delete so the
//       stored ranges still cover the same characters that were styled
//       before the edit.
//   normalizeRuns — after any mutation, clamp to bounds, drop empties,
//       merge adjacent runs with identical overrides, and report whether
//       the runs uniformly cover the whole string (caller can promote
//       that single style to item-level and drop the runs entirely).
//
// Matches Word's mental model: formatting always applies to a selection
// range; storage is a sequence of runs that describes the non-default
// ranges only.

import type { StyleRun } from './types';

// Fields that a StyleRun can override. Kept in one place so normalizeRuns
// and sameStyle stay in sync — adding a new override later means updating
// just this array.
export const STYLE_RUN_FIELDS: (keyof StyleRun)[] = [
    'color',
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'fontSize',
    'fontFamily',
];

// All item-level defaults a run might override. Passed into apply /
// normalize so a patch that matches the default can be dropped instead
// of stored as a run.
export interface ItemTextDefaults {
    color: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
    fontSize: number;
    fontFamily: string;
}

// Shallow equality on the override fields. Two runs with the same set
// of overrides are merge candidates; two runs with different sets
// (e.g. one sets bold, one sets color) are NOT merged even if adjacent —
// the different fields mean different layering.
function sameStyle(a: StyleRun, b: StyleRun): boolean {
    for (const f of STYLE_RUN_FIELDS) {
        if (a[f] !== b[f]) return false;
    }
    return true;
}

function isRunEmpty(run: StyleRun, defaults?: ItemTextDefaults): boolean {
    for (const f of STYLE_RUN_FIELDS) {
        const v = run[f];
        if (v === undefined) continue;
        // If this override equals the item default, it's effectively
        // a no-op. Only drop when defaults are supplied — without them
        // we conservatively keep the field (caller didn't promise the
        // defaults so we can't know what "matches" means).
        if (defaults && (v as any) === (defaults as any)[f]) continue;
        return false;
    }
    return true;
}

// Overwrite patch fields onto base, returning a new run. Explicit
// `undefined` in the patch CLEARS the field — used by the toggle logic
// when removing bold on a selection that was partially bold.
function mergePatch(base: StyleRun, patch: Partial<StyleRun>): StyleRun {
    const out: StyleRun = { start: base.start, end: base.end };
    for (const f of STYLE_RUN_FIELDS) {
        if (f in patch) {
            const v = patch[f];
            if (v !== undefined) (out as any)[f] = v;
            // else: explicitly cleared, leave unset.
        } else if (base[f] !== undefined) {
            (out as any)[f] = base[f];
        }
    }
    return out;
}

// Split runs so that no run straddles the [start, end) boundary. Runs
// completely inside or outside the range are untouched; only runs that
// cross a boundary are split into two. Result has the same text
// coverage but sliceable at start/end.
function splitAtBoundaries(runs: StyleRun[], start: number, end: number): StyleRun[] {
    const out: StyleRun[] = [];
    for (const r of runs) {
        if (r.end <= start || r.start >= end) {
            out.push(r);
            continue;
        }
        // r overlaps [start, end). Split into up to 3 pieces:
        //   [r.start, start) — outside, left
        //   [max(r.start,start), min(r.end,end)) — inside
        //   [end, r.end) — outside, right
        if (r.start < start) {
            out.push({ ...r, start: r.start, end: start });
        }
        const midStart = Math.max(r.start, start);
        const midEnd = Math.min(r.end, end);
        if (midStart < midEnd) {
            out.push({ ...r, start: midStart, end: midEnd });
        }
        if (r.end > end) {
            out.push({ ...r, start: end, end: r.end });
        }
    }
    return out;
}

// Get the effective style at a single character position by layering all
// runs that cover it (later runs overwrite earlier ones, matching how
// applyStyleToRange appends).
export function getStyleAt(runs: StyleRun[], pos: number): StyleRun {
    let acc: StyleRun = { start: pos, end: pos + 1 };
    for (const r of runs) {
        if (r.start <= pos && pos < r.end) {
            acc = mergePatch(acc, r);
        }
    }
    return acc;
}

// Summary of the styles present in [start, end). For each field, one of:
//   true  — every character in the range has this override set to true
//           (or every char has the same non-undefined value for color/size)
//   false — every character has this override absent OR equal to item default
//   'mixed' — chars differ
//   undefined — selection is empty
//
// Drives the context menu's toggle state: "mixed" means click makes
// everything on; "true" means click toggles off; "false" means click
// turns on.
export type FieldState<T> = T | 'mixed' | undefined;
export interface SelectionStyle {
    color: FieldState<string>;
    bold: FieldState<boolean>;
    italic: FieldState<boolean>;
    underline: FieldState<boolean>;
    strikethrough: FieldState<boolean>;
    fontSize: FieldState<number>;
    fontFamily: FieldState<string>;
}

export function getSelectionStyle(
    runs: StyleRun[],
    start: number,
    end: number,
    defaults: ItemTextDefaults,
): SelectionStyle {
    if (end <= start) {
        return {
            color: undefined, bold: undefined, italic: undefined,
            underline: undefined, strikethrough: undefined, fontSize: undefined,
            fontFamily: undefined,
        };
    }
    // Walk every char, compute its effective per-field value, and check
    // whether all chars agree. Cheap for typical text items (tens to
    // hundreds of chars); if this ever shows up in a profile we can
    // replace with a run-interval walk.
    const perChar = new Array(end - start);
    for (let i = 0; i < end - start; i++) {
        const s = getStyleAt(runs, start + i);
        perChar[i] = {
            color: s.color ?? defaults.color,
            bold: s.bold ?? defaults.bold,
            italic: s.italic ?? defaults.italic,
            underline: s.underline ?? defaults.underline,
            strikethrough: s.strikethrough ?? defaults.strikethrough,
            fontSize: s.fontSize ?? defaults.fontSize,
            fontFamily: s.fontFamily ?? defaults.fontFamily,
        };
    }
    const out: any = {};
    for (const f of ['color', 'bold', 'italic', 'underline', 'strikethrough', 'fontSize', 'fontFamily'] as const) {
        const first = perChar[0][f];
        let mixed = false;
        for (let i = 1; i < perChar.length; i++) {
            if (perChar[i][f] !== first) { mixed = true; break; }
        }
        out[f] = mixed ? 'mixed' : first;
    }
    return out as SelectionStyle;
}

// Apply a style patch to [start, end). Existing runs inside the range
// get their matching fields overwritten; chars that had no run gain a
// new run carrying just the patch fields. Fields not mentioned in the
// patch are preserved on existing runs — "make red" doesn't unbold.
//
// The patch itself is a partial StyleRun (no start/end). An explicit
// `undefined` on a field CLEARS that override — used when un-bolding
// a selection so the run no longer says bold:true.
export function applyStyleToRange(
    runs: StyleRun[],
    start: number,
    end: number,
    patch: Partial<Omit<StyleRun, 'start' | 'end'>>,
    totalLen: number,
    defaults?: ItemTextDefaults,
): StyleRun[] {
    if (end <= start) return runs;
    const clampedStart = Math.max(0, Math.min(start, totalLen));
    const clampedEnd = Math.max(0, Math.min(end, totalLen));
    if (clampedEnd <= clampedStart) return runs;
    // 1. Split existing runs at our boundaries so nothing straddles.
    const split = splitAtBoundaries(runs, clampedStart, clampedEnd);
    // 2. Collect runs entirely inside the range and overwrite patch
    //    fields on each. Runs outside the range pass through unchanged.
    //    Gaps inside the range get a new run created with just the
    //    patch fields.
    const insideByStart = new Map<number, StyleRun>();
    const outside: StyleRun[] = [];
    for (const r of split) {
        if (r.start >= clampedStart && r.end <= clampedEnd) {
            insideByStart.set(r.start, mergePatch(r, patch));
        } else {
            outside.push(r);
        }
    }
    // Walk the range and fill gaps with fresh runs carrying the patch.
    const covered: StyleRun[] = [];
    let cursor = clampedStart;
    const sortedInside = Array.from(insideByStart.values()).sort((a, b) => a.start - b.start);
    for (const r of sortedInside) {
        if (r.start > cursor) {
            covered.push(mergePatch({ start: cursor, end: r.start }, patch));
        }
        covered.push(r);
        cursor = r.end;
    }
    if (cursor < clampedEnd) {
        covered.push(mergePatch({ start: cursor, end: clampedEnd }, patch));
    }
    const all = [...outside, ...covered].sort((a, b) => a.start - b.start);
    return normalizeRuns(all, totalLen, defaults);
}

// Clamp, drop empties, merge adjacent runs with identical overrides.
// After normalization: runs are sorted, non-overlapping, none empty,
// and none contain only default-equivalent fields.
export function normalizeRuns(
    runs: StyleRun[],
    totalLen: number,
    defaults?: ItemTextDefaults,
): StyleRun[] {
    const cleaned: StyleRun[] = [];
    for (const r of runs) {
        const s = Math.max(0, Math.min(r.start, totalLen));
        const e = Math.max(0, Math.min(r.end, totalLen));
        if (e <= s) continue;
        const clamped = { ...r, start: s, end: e };
        if (isRunEmpty(clamped, defaults)) continue;
        cleaned.push(clamped);
    }
    cleaned.sort((a, b) => a.start - b.start || a.end - b.end);
    // Merge adjacent runs (end of one = start of next) that carry
    // identical override sets. Without this, applying bold to two
    // adjacent selections leaves two runs where one would do.
    const merged: StyleRun[] = [];
    for (const r of cleaned) {
        const last = merged[merged.length - 1];
        if (last && last.end === r.start && sameStyle(last, r)) {
            last.end = r.end;
        } else {
            merged.push({ ...r });
        }
    }
    return merged;
}

// Shift runs after a text edit at `pos` where `delta` chars were
// inserted (positive) or deleted (negative, covering [pos, pos-delta)).
// Runs entirely to the left of the edit stay put; runs entirely to the
// right shift by delta; runs that straddle the edit point grow/shrink
// in place. Runs fully inside a deletion collapse to empty and get
// dropped by normalize.
//
// This is a best-effort: we don't know what the user's intent was
// (did they mean to replace styled text with styled text, or plain
// text?), so we preserve the surrounding runs and let newly typed
// chars inherit whatever style the surviving run covers them with —
// same as Word's "typing absorbs left-neighbor style" behavior when
// the insert lands at a run boundary.
export function shiftRuns(
    runs: StyleRun[],
    pos: number,
    delta: number,
    totalLen: number,
): StyleRun[] {
    if (delta === 0) return runs;
    const out: StyleRun[] = [];
    if (delta > 0) {
        // Insert at pos. Chars >= pos move right by delta.
        for (const r of runs) {
            if (r.end <= pos) {
                out.push(r);
            } else if (r.start >= pos) {
                out.push({ ...r, start: r.start + delta, end: r.end + delta });
            } else {
                // Straddles the insertion point — extend to the right so
                // inserted chars inherit this run's style (Word-ish).
                out.push({ ...r, end: r.end + delta });
            }
        }
    } else {
        // Delete covering [pos, pos - delta). -delta chars removed.
        const delStart = pos;
        const delEnd = pos - delta;
        for (const r of runs) {
            if (r.end <= delStart) {
                out.push(r);
            } else if (r.start >= delEnd) {
                out.push({ ...r, start: r.start + delta, end: r.end + delta });
            } else {
                // Overlaps deletion. Shrink by the overlap.
                const overlap = Math.min(r.end, delEnd) - Math.max(r.start, delStart);
                const newStart = r.start < delStart ? r.start : delStart;
                const newEnd = (r.end > delEnd ? r.end + delta : delStart);
                if (newEnd > newStart) {
                    out.push({ ...r, start: newStart, end: newEnd });
                }
                // Suppress TS unused warning for clarity var.
                void overlap;
            }
        }
    }
    return normalizeRuns(out, totalLen);
}

// Diff two content strings and return { pos, delta } describing the
// single-point edit that transformed `before` into `after`. Good enough
// for typing / paste / backspace — the common textarea edits. Falls back
// to { pos: 0, delta: after.length - before.length } when the diff isn't
// a simple single-range edit (rare: paste over a selection that produces
// interior match at both ends). Caller uses it with shiftRuns.
export function diffSingleEdit(before: string, after: string): { pos: number; delta: number } {
    if (before === after) return { pos: 0, delta: 0 };
    // Common prefix.
    let i = 0;
    const minLen = Math.min(before.length, after.length);
    while (i < minLen && before[i] === after[i]) i++;
    // Common suffix (past the prefix).
    let bEnd = before.length;
    let aEnd = after.length;
    while (bEnd > i && aEnd > i && before[bEnd - 1] === after[aEnd - 1]) {
        bEnd--;
        aEnd--;
    }
    // before[i..bEnd) was replaced by after[i..aEnd). Treat as:
    //   delete (bEnd - i) chars at i, then insert (aEnd - i) chars at i.
    // For shiftRuns, the net effect is a shift of delta = (aEnd - i) -
    // (bEnd - i) at position i. This loses run coverage for the replaced
    // interior, which is the best we can do without a real diff algo.
    return { pos: i, delta: (aEnd - i) - (bEnd - i) };
}
