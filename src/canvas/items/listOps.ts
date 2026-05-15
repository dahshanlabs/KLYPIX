import type { StyleRun } from './types';

// Match either a bullet glyph + whitespace, or a numeric prefix ("12. "),
// at line start. The whitespace class `\s` covers both regular space
// (legacy baked prefixes) and U+00A0 NBSP (the modern bake — see
// PREFIX_SEP below) so toggle-off and detection both work uniformly.
export const LIST_PREFIX_RE = /^(?:•\s|\d+\.\s)/;

// Separator between the bullet/number and the body. NBSP instead of a
// regular space because the line breaker would otherwise prefer to
// wrap there in a narrow container — so a long un-spaced word like
// "ddddddd..." would push the bullet onto its own visual row and the
// body wrap below it. With NBSP the prefix is glued to the body; the
// browser's `word-break: break-word` then breaks mid-word inside the
// body, and the wrapped tail aligns under the body via the
// hanging-indent CSS in renderStyledLines (matches Word).
const PREFIX_SEP = ' ';

function detectPrefixLen(line: string): number {
    const m = LIST_PREFIX_RE.exec(line);
    return m ? m[0].length : 0;
}

interface LineInfo {
    oldStart: number;
    oldEnd: number;
    oldPrefixLen: number;
    newStart: number;
    newPrefixLen: number;
    newLineLen: number;
}

// Walk content line-by-line. For each line, strip its existing list
// prefix (if any), then prepend whatever `prefixFor(idx, body)` returns.
// Returning `null` leaves the line untouched (used by renumber to
// preserve Shift+Enter continuation lines without prefixes). Returns
// new content + styleRuns whose offsets have been remapped to match
// the prefix length deltas. Empty lines also receive the new prefix
// (Word/Markdown convention — a blank bullet line still shows its
// glyph, ready for typing). Returning '' strips.
//
// Run remapping rule: positions inside an OLD prefix collapse to the
// END of the NEW prefix (so a bold range that accidentally covered
// the old "1. " ends up tight on the body in the new content). A run
// boundary at line-start (local 0) is preserved at line-start in the
// new line — that lets "bold the whole item" survive a list toggle
// without the bullet glyph slipping out of the bold range.
export function applyLinePrefixes(
    content: string,
    runs: StyleRun[] | undefined,
    prefixFor: (idx: number, body: string) => string | null,
): { content: string; runs: StyleRun[] | undefined } {
    const lines = content.split('\n');
    const info: LineInfo[] = [];
    const newLines: string[] = [];
    let oldPos = 0;
    let newPos = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const oldPrefixLen = detectPrefixLen(line);
        const body = line.slice(oldPrefixLen);
        const replacement = prefixFor(i, body);
        // null → leave the line completely as-is (don't strip its
        // existing prefix, don't add a new one). This is what makes
        // continuation-line preservation possible during renumber.
        if (replacement === null) {
            info.push({
                oldStart: oldPos,
                oldEnd: oldPos + line.length,
                oldPrefixLen: 0,
                newStart: newPos,
                newPrefixLen: 0,
                newLineLen: line.length,
            });
            newLines.push(line);
            oldPos += line.length + 1;
            newPos += line.length + 1;
            continue;
        }
        const newPrefix = replacement;
        const newLine = newPrefix + body;
        info.push({
            oldStart: oldPos,
            oldEnd: oldPos + line.length,
            oldPrefixLen,
            newStart: newPos,
            newPrefixLen: newPrefix.length,
            newLineLen: newLine.length,
        });
        newLines.push(newLine);
        oldPos += line.length + 1;
        newPos += newLine.length + 1;
    }

    const mapOldPos = (p: number): number => {
        if (p < 0) return 0;
        for (let i = 0; i < info.length; i++) {
            const r = info[i];
            if (p <= r.oldEnd) {
                const local = p - r.oldStart;
                let newLocal: number;
                if (local <= 0) newLocal = 0;
                else if (local <= r.oldPrefixLen) newLocal = r.newPrefixLen;
                else newLocal = r.newPrefixLen + (local - r.oldPrefixLen);
                return r.newStart + newLocal;
            }
        }
        const last = info[info.length - 1];
        return last.newStart + last.newLineLen;
    };

    const newRuns: StyleRun[] | undefined = runs && runs.length > 0
        ? runs
            .map(r => ({ ...r, start: mapOldPos(r.start), end: mapOldPos(r.end) }))
            .filter(r => r.start < r.end)
        : runs;

    return { content: newLines.join('\n'), runs: newRuns };
}

export function stripListPrefixes(
    content: string,
    runs: StyleRun[] | undefined,
): { content: string; runs: StyleRun[] | undefined } {
    return applyLinePrefixes(content, runs, () => '');
}

export function applyBulletPrefixes(
    content: string,
    runs: StyleRun[] | undefined,
): { content: string; runs: StyleRun[] | undefined } {
    return applyLinePrefixes(content, runs, () => `•${PREFIX_SEP}`);
}

// Numbered: 1-based, includes empty lines so a blank list slot still
// renders a number (matches Word). Used for the initial bullet→numbered
// or none→numbered toggle: every line becomes a list item.
export function applyNumberedPrefixes(
    content: string,
    runs: StyleRun[] | undefined,
): { content: string; runs: StyleRun[] | undefined } {
    return applyLinePrefixes(content, runs, (i) => `${i + 1}.${PREFIX_SEP}`);
}

// Re-sequence existing numbered prefixes IN-PLACE, leaving any line
// without a numbered prefix untouched. Used after an Enter inserts a
// new numbered line so the rest of the list re-counts cleanly. Lines
// the user soft-broke with Shift+Enter (continuation, no prefix) stay
// as continuations — we don't bestow a number on them. The counter
// advances only for lines that ALREADY had a numbered prefix.
//
// Bullets aren't touched here (only `\d+\.\s` matches), so this is
// safe to call when the list has mixed bullet/numbered weirdness from
// hand-edits — only numbered prefixes get renumbered.
export function renumberNumberedLines(
    content: string,
    runs: StyleRun[] | undefined,
): { content: string; runs: StyleRun[] | undefined } {
    const NUM_RE = /^\d+\.\s/;
    const lines = content.split('\n');
    let prefixedIdx = 0;
    return applyLinePrefixes(content, runs, (lineIdx) => {
        const line = lines[lineIdx];
        if (!NUM_RE.test(line)) return null;
        prefixedIdx++;
        return `${prefixedIdx}.${PREFIX_SEP}`;
    });
}
