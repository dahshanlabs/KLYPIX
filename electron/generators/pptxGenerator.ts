import PptxGenJS from 'pptxgenjs';

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
                    fontFace: 'Calibri', valign: 'bottom',
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
                        fontFace: 'Calibri', valign: 'top',
                    });
                }

                // Date
                s.addText(date, {
                    x: 1.2, y: 6.5, w: 5, h: 0.4,
                    fontSize: 11, color: BRAND.muted,
                    fontFace: 'Calibri',
                });

                // Branding
                s.addText('Klypix', {
                    x: 10, y: 6.5, w: 2.5, h: 0.4,
                    fontSize: 10, color: BRAND.muted,
                    fontFace: 'Calibri', align: 'right',
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
                    fontFace: 'Calibri', valign: 'bottom',
                });

                if (slide.subtitle) {
                    s.addText(slide.subtitle, {
                        x: 1.5, y: 4.2, w: 10, h: 0.8,
                        fontSize: 16, color: BRAND.light,
                        fontFace: 'Calibri',
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
                    fontFace: 'Calibri',
                });

                // Accent underline
                s.addShape('rect' as any, {
                    x: 0.8, y: 1.05, w: 2.5, h: 0.04,
                    fill: { color: BRAND.accent },
                });

                // Bullets with custom styling
                const bulletItems = slide.bullets.map(b => {
                    const isBold = b.startsWith('**') && b.includes('**');
                    const cleanText = b.replace(/\*\*/g, '');
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
                        },
                    };
                });
                s.addText(bulletItems as any, {
                    x: 1.0, y: 1.4, w: 11.3, h: 5.3,
                    fontFace: 'Calibri', valign: 'top',
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
                    fontFace: 'Calibri',
                });

                // Left column header (accent colored)
                s.addText(slide.left.header, {
                    x: 0.8, y: 1.3, w: 5.5, h: 0.5,
                    fontSize: 16, bold: true, color: BRAND.accentDark,
                    fontFace: 'Calibri',
                });
                s.addShape('rect' as any, {
                    x: 0.8, y: 1.78, w: 1.5, h: 0.03,
                    fill: { color: BRAND.accent },
                });

                const leftBullets = slide.left.bullets.map(b => ({
                    text: b,
                    options: { fontSize: 13, color: BRAND.body, bullet: true, breakLine: true },
                }));
                s.addText(leftBullets as any, {
                    x: 1.0, y: 2.0, w: 5.3, h: 4.8,
                    fontFace: 'Calibri', valign: 'top',
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
                    fontFace: 'Calibri',
                });
                s.addShape('rect' as any, {
                    x: 6.9, y: 1.78, w: 1.5, h: 0.03,
                    fill: { color: BRAND.accent },
                });

                const rightBullets = slide.right.bullets.map(b => ({
                    text: b,
                    options: { fontSize: 13, color: BRAND.body, bullet: true, breakLine: true },
                }));
                s.addText(rightBullets as any, {
                    x: 7.1, y: 2.0, w: 5.3, h: 4.8,
                    fontFace: 'Calibri', valign: 'top',
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
                    fontFace: 'Calibri',
                });

                // Table with corporate styling
                const headerRow = slide.headers.map(h => ({
                    text: h.toUpperCase(),
                    options: {
                        bold: true,
                        color: BRAND.title,
                        fontSize: 11,
                        fill: { color: BRAND.tableHeader },
                    },
                }));

                const dataRows = slide.rows.map((row, ri) =>
                    row.map(cell => ({
                        text: String(cell),
                        options: {
                            fontSize: 11,
                            color: BRAND.body,
                            fill: ri % 2 === 0 ? { color: BRAND.tableStripe } : undefined,
                        },
                    }))
                );

                s.addTable([headerRow, ...dataRows] as any, {
                    x: 0.8, y: 1.3, w: 11.73,
                    fontSize: 11,
                    fontFace: 'Calibri',
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
                    fontFace: 'Calibri',
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
                        fontFace: 'Calibri',
                    });
                }

                s.addText('Klypix', {
                    x: 5, y: 6.5, w: 3.33, h: 0.4,
                    fontSize: 10, color: BRAND.muted,
                    align: 'center', fontFace: 'Calibri',
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
