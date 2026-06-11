// Display-shortening for file paths on dashboard rows + palette subtitles.
//
// Why paths at all: every project carries a brain.klypix (the global
// project-brain convention), so basename collisions are systematic — the
// folder is the only thing that tells two "brain.klypix" rows apart.
//
// Rules (VS Code Quick Open / JetBrains Recent Projects):
//   - Home dir abbreviates to ~ (C:\Users\HP\… → ~\…).
//   - When too long, truncate the MIDDLE: the distinguishing information in
//     a path lives at the deep end, so tail-ellipsis is the one wrong answer.
//   - Callers must pin the rendered span LTR (dir="ltr") — paths are LTR
//     data even in the Arabic UI.

const DEFAULT_MAX = 48;

export function shortenPath(filePath: string, maxChars: number = DEFAULT_MAX): string {
    if (!filePath) return '';
    // Collapse mixed separators (drag-drop and cloud paths use /) — the app
    // is Windows-only, so display joins with backslash.
    const segs = filePath.split(/[\\/]+/).filter(Boolean);
    if (segs.length === 0) return filePath;

    // C:\Users\<name>\Documents\x.klypix → ~\Documents\x.klypix
    if (segs.length >= 3 && /^[a-z]:$/i.test(segs[0]) && segs[1].toLowerCase() === 'users') {
        segs.splice(0, 3, '~');
    }

    const full = segs.join('\\');
    if (full.length <= maxChars) return full;

    // Middle truncation: root + … + as many trailing segments as fit.
    // The basename is always kept, even when it alone busts the budget —
    // the CSS ellipsis on the host span is the last-resort fallback.
    const root = segs[0];
    const tail: string[] = [];
    let len = root.length + 2; // "root\…"
    for (let i = segs.length - 1; i >= 1; i--) {
        const extra = segs[i].length + 1; // "\seg"
        if (tail.length >= 1 && len + extra > maxChars) break;
        tail.unshift(segs[i]);
        len += extra;
    }
    // Everything after the root fit — the ellipsis would only add noise.
    if (tail.length === segs.length - 1) return full;
    return `${root}\\…\\${tail.join('\\')}`;
}
