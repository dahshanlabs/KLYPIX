// Shared Arabic-script detection + font-swap helpers used by all four doc
// generators (docx / xlsx / pptx / pdf). Keeps the detection regex and the
// preferred Arabic font name in one place so a future font swap is a single
// edit, not four.
//
// The desktop canvas uses the same Unicode ranges in
// src/canvas/items/TextItem.tsx (resolveCanvasFontFamily) and the web viewer
// mirrors it in admin/components/CanvasViewer.tsx — keep these in sync.

const ARABIC_RANGE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export const ARABIC_FONT = 'Thmanyah Sans';
export const LATIN_FONT = 'Calibri';
export const LATIN_MONO_FONT = 'Consolas';

export function containsArabic(text: string | undefined | null): boolean {
    return !!text && ARABIC_RANGE.test(text);
}

// Pick the right body font for a run based on whether the run text is
// Arabic. Latin runs keep Calibri (the corporate look the templates were
// designed around); Arabic runs switch to Thmanyah Sans so glyphs shape
// correctly. Monospace stays monospace regardless.
export function fontForRun(text: string | undefined | null, opts?: { mono?: boolean }): string {
    if (opts?.mono) return LATIN_MONO_FONT;
    return containsArabic(text) ? ARABIC_FONT : LATIN_FONT;
}
