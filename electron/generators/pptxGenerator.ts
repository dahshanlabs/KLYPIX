import PptxGenJS from 'pptxgenjs';
import { containsArabic, ARABIC_FONT, LATIN_FONT } from './arabicUtil';

// Build PPTX text options for a piece of content. Arabic content switches
// fontFace to Thmanyah Sans and flips rtlMode so the text frame lays out
// right-to-left. Latin content keeps Calibri + LTR.
function arOpts(text: string | undefined | null): { fontFace: string; rtlMode?: boolean } {
    if (containsArabic(text)) return { fontFace: ARABIC_FONT, rtlMode: true };
    return { fontFace: LATIN_FONT };
}

export interface PPTXSpec {
    filename?: string;
    metadata?: { title?: string; author?: string; date?: string };
    slides: PPTXSlide[];
}

type PPTXSlide =
    | { layout: 'title'; title: string; subtitle?: string; notes?: string }
    | { layout: 'section'; title: string; subtitle?: string; notes?: string }
    | { layout: 'content'; title: string; bullets: string[]; notes?: string }
    | { layout: 'two-column'; title: string; left: { header: string; bullets: string[] }; right: { header: string; bullets: string[] }; notes?: string }
    | { layout: 'table'; title: string; headers: string[]; rows: string[][]; notes?: string }
    | { layout: 'closing'; title: string; subtitle?: string; notes?: string };

const BRAND = {
    accent: '10b981',
    accentDark: '059669',
    title: '111827',
    body: '374151',
    muted: '6b7280',
    light: '9ca3af',
    lighter: 'd1d5db',
    white: 'ffffff',
    bgLight: 'f9fafb',
    bgDark: '111827',
    tableHeader: 'f3f4f6',
    tableStripe: 'f9fafb',
};

function addSlideNumber(s: PptxGenJS.Slide, slideNum: number, total: number) {
    s.addText(`${slideNum} / ${total}`, {
        x: 11.5, y: 7.0, w: 1.5, h: 0.3,
        fontSize: 8, color: BRAND.light,
        align: 'right', fontFace: 'Calibri',
    });
}

function addAccentBar(s: PptxGenJS.Slide) {
    // Left edge accent bar
    s.addShape('rect' as any, {
        x: 0, y: 0, w: 0.06, h: 7.5,
        fill: { color: BRAND.accent },
    });
}

function addFooterBar(s: PptxGenJS.Slide) {
    // Subtle bottom line
    s.addShape('rect' as any, {
        x: 0.7, y: 7.1, w: 11.93, h: 0.01,
        fill: { color: BRAND.lighter },
    });
}

export async function generatePPTX(spec: PPTXSpec): Promise<Buffer> {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = spec.metadata?.author || 'Klypix';
    pptx.title = spec.metadata?.title || 'Presentation';

    const totalSlides = spec.slides.length;
    const date = spec.metadata?.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    for (let idx = 0; idx < spec.slides.length; idx++) {
        const slide = spec.slides[idx];
        const s = pptx.addSlide();

        switch (slide.layout) {
            case 'title': {
                // Dark background title slide
                s.background = { fill: BRAND.bgDark };

                // Large accent bar at top
                s.addShape('rect' as any, {
                    x: 0, y: 0, w: 13.33, h: 0.08,
                    fill: { color: BRAND.accent },
                });

                // Title
                s.addText(slide.title, {
                    x: 1.2, y: 2.2, w: 10.93, h: 1.8,
                    fontSize: 40, bold: true, color: BRAND.white,
                    ...arOpts(slide.title), valign: 'bottom',
                });

                // Accent line under title
                s.addShape('rect' as any, {
                    x: 1.2, y: 4.2, w: 3, h: 0.05,
                    fill: { color: BRAND.accent },
                });

                // Subtitle
                if (slide.subtitle) {
                    s.addText(slide.subtitle, {
                        x: 1.2, y: 4.5, w: 10.93, h: 0.8,
                        fontSize: 18, color: BRAND.light,
                        ...arOpts(slide.subtitle), valign: 'top',
                    });
                }

                // Date
                s.addText(date, {
                    x: 1.2, y: 6.5, w: 5, h: 0.4,
                    fontSize: 11, color: BRAND.muted,
                    fontFace: LATIN_FONT,
                });

                // Branding
                s.addText('Klypix', {
                    x: 10, y: 6.5, w: 2.5, h: 0.4,
                    fontSize: 10, color: BRAND.muted,
                    fontFace: LATIN_FONT, align: 'right',
                });
                break;
            }

            case 'section': {
                // Section divider — dark with large text
                s.background = { fill: BRAND.bgDark };

                s.addShape('rect' as any, {
                    x: 0, y: 0, w: 0.08, h: 7.5,
                    fill: { color: BRAND.accent },
                });

                s.addText(slide.title, {
                    x: 1.5, y: 2.5, w: 10, h: 1.5,
                    fontSize: 36, bold: true, color: BRAND.white,
                    ...arOpts(slide.title), valign: 'bottom',
                });

                if (slide.subtitle) {
                    s.addText(slide.subtitle, {
                        x: 1.5, y: 4.2, w: 10, h: 0.8,
                        fontSize: 16, color: BRAND.light,
                        ...arOpts(slide.subtitle),
                    });
                }

                addSlideNumber(s, idx + 1, totalSlides);
                break;
            }

            case 'content': {
                addAccentBar(s);
                addFooterBar(s);

                // Title
                s.addText(slide.title, {
                    x: 0.8, y: 0.3, w: 11.73, h: 0.8,
                    fontSize: 24, bold: true, color: BRAND.title,
                    ...arOpts(slide.title),
                });

                // Accent underline
                s.addShape('rect' as any, {
                    x: 0.8, y: 1.05, w: 2.5, h: 0.04,
                    fill: { color: BRAND.accent },
                });

                // Bullets with custom styling — each bullet picks its own
                // fontFace based on its content (mixed-language decks work).
                const bulletItems = slide.bullets.map(b => {
                    const isBold = b.startsWith('**') && b.includes('**');
                    const cleanText = b.replace(/\*\*/g, '');
                    const ar = containsArabic(cleanText);
                    return {
                        text: cleanText,
                        options: {
                            fontSize: 15,
                            color: BRAND.body,
                            bullet: { type: 'number' as any, style: undefined, code: '2022' }, // filled circle
                            breakLine: true,
                            bold: isBold,
                            paraSpaceBefore: 4,
                            paraSpaceAfter: 6,
                            fontFace: ar ? ARABIC_FONT : LATIN_FONT,
                            rtlMode: ar || undefined,
                        },
                    };
                });
                // Frame-level fontFace falls back if a bullet doesn't set one
                // (it always does here, but pptxgenjs requires the outer opt).
                const anyArabic = slide.bullets.some(containsArabic);
                s.addText(bulletItems as any, {
                    x: 1.0, y: 1.4, w: 11.3, h: 5.3,
                    fontFace: anyArabic ? ARABIC_FONT : LATIN_FONT,
                    rtlMode: anyArabic || undefined,
                    valign: 'top',
                    lineSpacingMultiple: 1.3,
                });

                addSlideNumber(s, idx + 1, totalSlides);
                break;
            }

            case 'two-column': {
                addAccentBar(s);
                addFooterBar(s);

                // Title
                s.addText(slide.title, {
                    x: 0.8, y: 0.3, w: 11.73, h: 0.8,
                    fontSize: 24, bold: true, color: BRAND.title,
                    ...arOpts(slide.title),
                });

                // Left column header (accent colored)
                s.addText(slide.left.header, {
                    x: 0.8, y: 1.3, w: 5.5, h: 0.5,
                    fontSize: 16, bold: true, color: BRAND.accentDark,
                    ...arOpts(slide.left.header),
                });
                s.addShape('rect' as any, {
                    x: 0.8, y: 1.78, w: 1.5, h: 0.03,
                    fill: { color: BRAND.accent },
                });

                const leftBullets = slide.left.bullets.map(b => {
                    const ar = containsArabic(b);
                    return {
                        text: b,
                        options: { fontSize: 13, color: BRAND.body, bullet: true, breakLine: true, fontFace: ar ? ARABIC_FONT : LATIN_FONT, rtlMode: ar || undefined },
                    };
                });
                const leftAnyArabic = slide.left.bullets.some(containsArabic);
                s.addText(leftBullets as any, {
                    x: 1.0, y: 2.0, w: 5.3, h: 4.8,
                    fontFace: leftAnyArabic ? ARABIC_FONT : LATIN_FONT,
                    rtlMode: leftAnyArabic || undefined,
                    valign: 'top',
                    lineSpacingMultiple: 1.25,
                });

                // Vertical divider
                s.addShape('rect' as any, {
                    x: 6.55, y: 1.3, w: 0.015, h: 5.5,
                    fill: { color: BRAND.lighter },
                });

                // Right column header
                s.addText(slide.right.header, {
                    x: 6.9, y: 1.3, w: 5.5, h: 0.5,
                    fontSize: 16, bold: true, color: BRAND.accentDark,
                    ...arOpts(slide.right.header),
                });
                s.addShape('rect' as any, {
                    x: 6.9, y: 1.78, w: 1.5, h: 0.03,
                    fill: { color: BRAND.accent },
                });

                const rightBullets = slide.right.bullets.map(b => {
                    const ar = containsArabic(b);
                    return {
                        text: b,
                        options: { fontSize: 13, color: BRAND.body, bullet: true, breakLine: true, fontFace: ar ? ARABIC_FONT : LATIN_FONT, rtlMode: ar || undefined },
                    };
                });
                const rightAnyArabic = slide.right.bullets.some(containsArabic);
                s.addText(rightBullets as any, {
                    x: 7.1, y: 2.0, w: 5.3, h: 4.8,
                    fontFace: rightAnyArabic ? ARABIC_FONT : LATIN_FONT,
                    rtlMode: rightAnyArabic || undefined,
                    valign: 'top',
                    lineSpacingMultiple: 1.25,
                });

                addSlideNumber(s, idx + 1, totalSlides);
                break;
            }

            case 'table': {
                addAccentBar(s);
                addFooterBar(s);

                // Title
                s.addText(slide.title, {
                    x: 0.8, y: 0.3, w: 11.73, h: 0.8,
                    fontSize: 24, bold: true, color: BRAND.title,
                    ...arOpts(slide.title),
                });

                // Per-cell font detection — a single Arabic cell in an
                // otherwise-Latin table still renders with proper shaping.
                const headerRow = slide.headers.map(h => {
                    const headerText = h.toUpperCase();
                    const ar = containsArabic(headerText);
                    return {
                        text: headerText,
                        options: {
                            bold: true,
                            color: BRAND.title,
                            fontSize: 11,
                            fill: { color: BRAND.tableHeader },
                            fontFace: ar ? ARABIC_FONT : LATIN_FONT,
                        },
                    };
                });

                const dataRows = slide.rows.map((row, ri) =>
                    row.map(cell => {
                        const cellText = String(cell);
                        const ar = containsArabic(cellText);
                        return {
                            text: cellText,
                            options: {
                                fontSize: 11,
                                color: BRAND.body,
                                fill: ri % 2 === 0 ? { color: BRAND.tableStripe } : undefined,
                                fontFace: ar ? ARABIC_FONT : LATIN_FONT,
                            },
                        };
                    })
                );

                // Table-level fontFace falls back if a cell didn't set one;
                // cells always do, but pptxgenjs requires the outer option.
                const anyArabicCell = slide.headers.some(containsArabic) ||
                    slide.rows.some(r => r.some(c => containsArabic(String(c))));
                s.addTable([headerRow, ...dataRows] as any, {
                    x: 0.8, y: 1.3, w: 11.73,
                    fontSize: 11,
                    fontFace: anyArabicCell ? ARABIC_FONT : LATIN_FONT,
                    border: { type: 'solid', pt: 0.5, color: BRAND.lighter },
                    colW: slide.headers.map(() => 11.73 / slide.headers.length),
                    rowH: [0.45, ...slide.rows.map(() => 0.38)],
                    autoPage: true,
                });

                addSlideNumber(s, idx + 1, totalSlides);
                break;
            }

            case 'closing': {
                s.background = { fill: BRAND.bgDark };

                s.addShape('rect' as any, {
                    x: 0, y: 0, w: 13.33, h: 0.08,
                    fill: { color: BRAND.accent },
                });

                s.addText(slide.title, {
                    x: 1, y: 2.5, w: 11.33, h: 1.4,
                    fontSize: 36, bold: true, color: BRAND.white,
                    align: 'center', valign: 'bottom',
                    ...arOpts(slide.title),
                });

                s.addShape('rect' as any, {
                    x: 5.2, y: 4.1, w: 3, h: 0.05,
                    fill: { color: BRAND.accent },
                });

                if (slide.subtitle) {
                    s.addText(slide.subtitle, {
                        x: 1, y: 4.4, w: 11.33, h: 0.8,
                        fontSize: 16, color: BRAND.light,
                        align: 'center', valign: 'top',
                        ...arOpts(slide.subtitle),
                    });
                }

                s.addText('Klypix', {
                    x: 5, y: 6.5, w: 3.33, h: 0.4,
                    fontSize: 10, color: BRAND.muted,
                    align: 'center', fontFace: LATIN_FONT,
                });
                break;
            }
        }

        if (slide.notes) {
            s.addNotes(slide.notes);
        }
    }

    const output = await pptx.write({ outputType: 'nodebuffer' });
    return output as Buffer;
}
