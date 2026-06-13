import PDFDocument from 'pdfkit';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { containsArabic } from './arabicUtil';

// ── Corporate PDF Generator ─────────────────────────────────────────────────
// Clean corporate style inspired by McKinsey/Deloitte reports.
// Features: header/footer on every page, page numbers, accent bars,
// professional typography, clean tables, proper spacing.
//
// Arabic support: when a text run contains Arabic-script characters, the run
// renders with Thmanyah Sans (an OpenType font with GSUB tables) and the
// paragraph is right-aligned. Glyph shaping (isolated/initial/medial/final
// letter forms) is handled by fontkit which pdfkit uses internally. Full
// bidi reordering (UAX #9) is NOT implemented here — for Arabic-heavy
// documents, prefer DOCX which has native bidi support in Word/LibreOffice.
// Mixed Latin+Arabic lines render in logical order; right-aligned Arabic
// paragraphs read correctly for the common case of a single-language body.

const FONTS = {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    mono: 'Courier',
};

// Thmanyah font keys registered with pdfkit. After registerFont() runs in
// generatePDF(), these names can be passed to doc.font(...) just like the
// base-14 Helvetica family above.
const ARABIC_FONTS = {
    regular: 'Thmanyah-Regular',
    bold: 'Thmanyah-Bold',
    // No italic/mono in the bundled subset — italic falls back to regular,
    // mono stays Courier (Latin-only, fine since code runs are Latin).
    italic: 'Thmanyah-Regular',
    mono: 'Courier',
};

// Pick the right registered font key for a run based on whether it contains
// Arabic. Latin runs keep the base-14 Helvetica family (zero embedded bytes);
// Arabic runs switch to the embedded Thmanyah Sans.
function fontKey(text: string | undefined | null, style: 'regular' | 'bold' | 'italic' | 'mono'): string {
    if (style === 'mono') return FONTS.mono;
    return containsArabic(text) ? ARABIC_FONTS[style] : FONTS[style];
}

const BRAND = {
    accent: '#10b981',       // Emerald
    accentDark: '#059669',
    title: '#111827',
    body: '#374151',
    muted: '#6b7280',
    light: '#9ca3af',
    tableBorder: '#e5e7eb',
    tableHeader: '#f3f4f6',
    tableStripe: '#f9fafb',
    codeBg: '#f3f4f6',
    white: '#ffffff',
};

const LAYOUT = {
    marginTop: 72,
    marginBottom: 60,
    marginLeft: 65,
    marginRight: 65,
    headerY: 28,
    footerY: 15,
};

const SPACING = {
    sectionGap: 1.0,
    subsectionGap: 0.8,
    paragraphGap: 0.35,
    listItemGap: 0.25,
    blankLineGap: 0.4,
    tableGap: 0.4,
};

// Resolve the on-disk path to a bundled font file. In dev the public folder
// is alongside source; in a packaged build Vite copies it to dist/ and the
// electron main process runs from dist-electron/, so the relative jump is
// ../dist/. Mirrors the pattern used for logo.png in electron/main.ts.
function resolveFontPath(filename: string): string {
    // Compiled to dist-electron/generators/, so fonts are two levels up
    // (../../public in dev, ../../dist when packaged). This previously used a
    // single ../ and keyed only off NODE_ENV, so the Thmanyah load silently
    // failed and Arabic fell back to Helvetica.
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    const base = isDev
        ? path.join(__dirname, '../../public/fonts/thmanyah')
        : path.join(__dirname, '../../dist/fonts/thmanyah');
    return path.join(base, filename);
}

// Register the Thmanyah Sans OTF subset (Regular + Bold) with the document.
// Wrapped in a try/catch so a missing file doesn't blow up the whole PDF —
// Arabic content will fall back to Helvetica (which can't shape it, but the
// document still renders).
function registerArabicFonts(doc: typeof PDFDocument.prototype): void {
    try {
        doc.registerFont(ARABIC_FONTS.regular, resolveFontPath('thmanyahsans-Regular.otf'));
        doc.registerFont(ARABIC_FONTS.bold, resolveFontPath('thmanyahsans-Bold.otf'));
    } catch (err) {
        console.error('[pdfGenerator] Failed to register Thmanyah fonts:', err);
    }
}

export async function generatePDF(markdownContent: string, options?: { title?: string; author?: string; date?: string }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            margins: {
                top: LAYOUT.marginTop,
                bottom: LAYOUT.marginBottom,
                left: LAYOUT.marginLeft,
                right: LAYOUT.marginRight,
            },
            size: 'A4',
            bufferPages: true,
            info: {
                Title: options?.title || 'Document',
                Author: options?.author || 'Klypix',
                Creator: 'Klypix by Dahshan Labs',
            },
        });

        registerArabicFonts(doc);

        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const pageWidth = doc.page.width - LAYOUT.marginLeft - LAYOUT.marginRight;
        // Strip trailing whitespace and blank lines to prevent empty pages
        const cleanedContent = markdownContent.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '').trim();
        const lines = cleanedContent.split('\n');
        let numberedCounter = 0;
        let inTable = false;
        let tableHeaders: string[] = [];
        let tableRows: string[][] = [];
        let isFirstHeading = true;
        let docTitle = options?.title || '';

        const flushTable = () => {
            if (tableHeaders.length > 0) {
                renderTable(doc, tableHeaders, tableRows, pageWidth);
                tableHeaders = [];
                tableRows = [];
            }
            inTable = false;
        };

        // ── Render content ──────────────────────────────────────────────────

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
                if (inTable) flushTable();
                // Don't reset numberedCounter on blank lines — only reset on non-list content
                // Only add spacing if we're not near the bottom of the page
                if (doc.y < doc.page.height - LAYOUT.marginBottom - 40) {
                    doc.moveDown(0.4);
                }
                continue;
            }

            // Horizontal rule (---, ***, ___, === separators)
            if (/^[-*_=]{3,}$/.test(trimmed)) {
                if (inTable) flushTable();
                numberedCounter = 0;
                doc.moveDown(0.5);
                doc.save();
                const lineY = doc.y;
                doc.moveTo(LAYOUT.marginLeft, lineY)
                   .lineTo(LAYOUT.marginLeft + pageWidth, lineY)
                   .strokeColor(BRAND.tableBorder)
                   .lineWidth(0.75)
                   .stroke();
                doc.restore();
                doc.moveDown(0.7);
                continue;
            }

            // ── Image: ![alt](path) ────────────────────────────────────
            const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
            if (imgMatch) {
                if (inTable) flushTable();
                numberedCounter = 0;
                const altText = imgMatch[1];
                let imgPath = imgMatch[2];

                // Resolve relative paths: check sandbox shared folder and common locations
                if (!path.isAbsolute(imgPath)) {
                    const sandboxShared = path.join(process.env.APPDATA || '', 'klypix', 'sandbox');
                    const candidates = [
                        path.join(sandboxShared, imgPath),
                        path.join(sandboxShared, 'output', imgPath),
                        path.join(process.env.USERPROFILE || '', 'Desktop', imgPath),
                    ];
                    const found = candidates.find(c => fs.existsSync(c));
                    if (found) imgPath = found;
                }

                if (fs.existsSync(imgPath)) {
                    try {
                        // Page break if not enough space for image (280 image + caption + margin)
                        const MAX_IMG_HEIGHT = 280;
                        const captionHeight = altText ? 20 : 0;
                        const requiredSpace = MAX_IMG_HEIGHT + captionHeight + 30;
                        if (doc.y > doc.page.height - LAYOUT.marginBottom - requiredSpace) {
                            doc.addPage();
                        }
                        doc.moveDown(0.5);
                        const imageTopY = doc.y;
                        doc.image(imgPath, LAYOUT.marginLeft, imageTopY, {
                            fit: [pageWidth, MAX_IMG_HEIGHT],
                            align: 'center',
                        });
                        // doc.image() does NOT advance doc.y when given explicit coordinates.
                        // Reserve the full max height so subsequent content doesn't overlap.
                        doc.y = imageTopY + MAX_IMG_HEIGHT + 8;
                        // Caption below image
                        if (altText) {
                            doc.font(FONTS.italic).fontSize(9).fillColor(BRAND.muted);
                            doc.text(altText, LAYOUT.marginLeft, doc.y, { width: pageWidth, align: 'center' });
                            doc.fillColor(BRAND.body);
                        }
                        doc.moveDown(0.8);
                    } catch (imgErr) {
                        // Image failed — render as text fallback
                        doc.font(FONTS.italic).fontSize(9.5).fillColor(BRAND.muted);
                        doc.text(`[Image: ${altText || imgPath}]`, LAYOUT.marginLeft, doc.y, { width: pageWidth });
                        doc.fillColor(BRAND.body);
                        doc.moveDown(0.3);
                    }
                } else {
                    // Image file not found — render as text
                    doc.font(FONTS.italic).fontSize(9.5).fillColor(BRAND.muted);
                    doc.text(`[Image not found: ${altText || imgPath}]`, LAYOUT.marginLeft, doc.y, { width: pageWidth });
                    doc.fillColor(BRAND.body);
                    doc.moveDown(0.3);
                }
                continue;
            }

            // Table separator
            if (/^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/.test(trimmed)) {
                continue;
            }

            // Table row
            if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
                const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
                if (!inTable) {
                    inTable = true;
                    tableHeaders = cells;
                } else {
                    tableRows.push(cells);
                }
                continue;
            }

            if (inTable) flushTable();

            // ── Page break guard: ensure headings don't render at page bottom
            const isHeading = trimmed.startsWith('#');
            const remainingSpace = doc.page.height - LAYOUT.marginBottom - doc.y;
            if (isHeading && remainingSpace < 55) {
                doc.addPage();
            }

            // ── H1: Title heading ───────────────────────────────────────────
            if (trimmed.startsWith('# ')) {
                const text = trimmed.slice(2);
                const ar = containsArabic(text);
                if (isFirstHeading) {
                    docTitle = text;
                    isFirstHeading = false;
                    // Title with accent bar
                    doc.moveDown(0.8);
                    doc.save();
                    doc.rect(LAYOUT.marginLeft - 4, doc.y - 2, 4, 32).fill(BRAND.accent);
                    doc.restore();
                    doc.font(fontKey(text, 'bold')).fontSize(26).fillColor(BRAND.title);
                    doc.text(text, LAYOUT.marginLeft + 8, doc.y, ar ? { width: pageWidth - 8, align: 'right' } : undefined);
                    doc.moveDown(0.6);
                    // Thin line under title
                    doc.save();
                    doc.moveTo(LAYOUT.marginLeft, doc.y)
                       .lineTo(LAYOUT.marginLeft + pageWidth, doc.y)
                       .strokeColor(BRAND.tableBorder)
                       .lineWidth(0.5)
                       .stroke();
                    doc.restore();
                    doc.moveDown(0.8);
                } else {
                    doc.moveDown(1.0);
                    doc.save();
                    doc.rect(LAYOUT.marginLeft - 4, doc.y - 2, 4, 28).fill(BRAND.accent);
                    doc.restore();
                    doc.font(fontKey(text, 'bold')).fontSize(22).fillColor(BRAND.title);
                    doc.text(text, LAYOUT.marginLeft + 8, doc.y, ar ? { width: pageWidth - 8, align: 'right' } : undefined);
                    doc.moveDown(0.5);
                }
            }
            // ── H2 ─────────────────────────────────────────────────────────
            else if (trimmed.startsWith('## ')) {
                const text = trimmed.slice(3);
                const ar = containsArabic(text);
                doc.moveDown(0.8);
                doc.font(fontKey(text, 'bold')).fontSize(16).fillColor(BRAND.title);
                doc.text(text, ar ? { width: pageWidth, align: 'right' } : undefined as any);
                doc.moveDown(0.15);
                // Subtle accent underline
                doc.save();
                doc.moveTo(doc.x, doc.y)
                   .lineTo(doc.x + 60, doc.y)
                   .strokeColor(BRAND.accent)
                   .lineWidth(1.5)
                   .stroke();
                doc.restore();
                doc.moveDown(0.4);
            }
            // ── H3 ─────────────────────────────────────────────────────────
            else if (trimmed.startsWith('### ')) {
                const text = trimmed.slice(4);
                const ar = containsArabic(text);
                doc.moveDown(0.6);
                doc.font(fontKey(text, 'bold')).fontSize(13).fillColor(BRAND.accentDark);
                doc.text(text, ar ? { width: pageWidth, align: 'right' } : undefined as any);
                doc.moveDown(0.3);
            }
            // ── Blockquote ─────────────────────────────────────────────────
            else if (trimmed.startsWith('> ')) {
                const text = trimmed.slice(2);
                const ar = containsArabic(text);
                doc.moveDown(0.2);
                doc.save();
                const quoteY = doc.y;
                doc.rect(LAYOUT.marginLeft + 10, quoteY - 2, 3, 18).fill(BRAND.accent);
                doc.restore();
                doc.font(fontKey(text, 'italic')).fontSize(10.5).fillColor(BRAND.muted);
                doc.text(text, LAYOUT.marginLeft + 22, doc.y, ar ? { width: pageWidth - 30, align: 'right' } : { width: pageWidth - 30 });
                doc.fillColor(BRAND.body);
                doc.moveDown(0.3);
            }
            // ── Bullet list ────────────────────────────────────────────────
            else if (/^[-*•]\s/.test(trimmed)) {
                numberedCounter = 0;
                doc.fontSize(10.5).fillColor(BRAND.body);
                const bulletContent = trimmed.replace(/^[-*•]\s+/, '');
                // Orphan control: ensure bullet + at least one line fits on current page
                const pageBottom = doc.page.height - LAYOUT.marginBottom;
                if (doc.y + 20 > pageBottom) {
                    doc.addPage();
                }
                // Emerald bullet dot
                doc.save();
                doc.circle(LAYOUT.marginLeft + 18, doc.y + 5, 2.5).fill(BRAND.accent);
                doc.restore();
                doc.fillColor(BRAND.body);
                doc.font(FONTS.regular).text('', { continued: false });
                renderInlineFormatting(doc, bulletContent, LAYOUT.marginLeft + 28, pageWidth - 28);
                doc.moveDown(0.25);
            }
            // ── Numbered list ──────────────────────────────────────────────
            else if (/^\d+\.\s/.test(trimmed)) {
                numberedCounter++;
                doc.fontSize(10.5).fillColor(BRAND.body);
                const content = trimmed.replace(/^\d+\.\s/, '');
                // Orphan control: ensure number + text fits
                const pageBottom2 = doc.page.height - LAYOUT.marginBottom;
                if (doc.y + 20 > pageBottom2) {
                    doc.addPage();
                }
                // Capture y BEFORE writing the number — doc.text() with `continued: false`
                // advances doc.y to the next line, which would push the content onto a new line.
                const rowY = doc.y;
                // Number in accent color
                doc.save();
                doc.font(FONTS.bold).fontSize(10.5).fillColor(BRAND.accent);
                doc.text(`${numberedCounter}.`, LAYOUT.marginLeft + 12, rowY, { lineBreak: false, width: 20 });
                doc.restore();
                doc.fillColor(BRAND.body);
                // Reset doc.y so renderInlineFormatting draws on the SAME line as the number
                doc.y = rowY;
                renderInlineFormatting(doc, content, LAYOUT.marginLeft + 28, pageWidth - 28);
                doc.moveDown(0.25);
            }
            // ── Regular paragraph ──────────────────────────────────────────
            else {
                numberedCounter = 0;
                // Page break if near bottom
                if (doc.y > doc.page.height - LAYOUT.marginBottom - 30) {
                    doc.addPage();
                }
                doc.font(FONTS.regular).fontSize(10.5).fillColor(BRAND.body);
                renderInlineFormatting(doc, trimmed, undefined, pageWidth);
                doc.moveDown(0.35);
            }
        }

        if (inTable) flushTable();

        // ── Add headers and footers to ALL pages ─────────────────────────
        const totalPages = doc.bufferedPageRange().count;

        // Helper: render text on a buffered page WITHOUT triggering auto-pagination
        // PDFKit's doc.text() creates new pages even with lineBreak:false on buffered pages.
        // The workaround: temporarily set huge page margins to prevent overflow detection.
        const safeText = (text: string, x: number, y: number, opts: any = {}) => {
            const origMarginBottom = doc.page.margins.bottom;
            doc.page.margins.bottom = 0; // disable bottom overflow detection
            doc.text(text, x, y, { ...opts, lineBreak: false });
            doc.page.margins.bottom = origMarginBottom;
        };

        for (let i = 0; i < totalPages; i++) {
            doc.switchToPage(i);

            // Header: thin line + document title (right aligned)
            if (i > 0 || !docTitle) {
                doc.save();
                doc.moveTo(LAYOUT.marginLeft, LAYOUT.headerY + 14)
                   .lineTo(doc.page.width - LAYOUT.marginRight, LAYOUT.headerY + 14)
                   .strokeColor(BRAND.tableBorder)
                   .lineWidth(0.5)
                   .stroke();
                if (docTitle) {
                    doc.font(fontKey(docTitle, 'regular')).fontSize(7.5).fillColor(BRAND.light);
                    safeText(docTitle, LAYOUT.marginLeft, LAYOUT.headerY + 2, {
                        width: pageWidth,
                        align: 'right',
                    });
                }
                doc.restore();
            }

            // Footer: accent line + page number + branding + date
            doc.save();
            const footerLineY = doc.page.height - LAYOUT.footerY - 12;
            doc.moveTo(LAYOUT.marginLeft, footerLineY)
               .lineTo(doc.page.width - LAYOUT.marginRight, footerLineY)
               .strokeColor(BRAND.tableBorder)
               .lineWidth(0.5)
               .stroke();

            const footerY = doc.page.height - LAYOUT.footerY;

            // Page number (centered)
            doc.font(FONTS.regular).fontSize(8).fillColor(BRAND.light);
            safeText(`${i + 1} / ${totalPages}`, LAYOUT.marginLeft, footerY, {
                width: pageWidth, align: 'center',
            });

            // Branding (left)
            doc.font(FONTS.regular).fontSize(7).fillColor(BRAND.light);
            safeText('Klypix', LAYOUT.marginLeft, footerY, {
                width: pageWidth, align: 'left',
            });

            // Date (right)
            safeText(
                options?.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
                LAYOUT.marginLeft, footerY,
                { width: pageWidth, align: 'right' }
            );
            doc.restore();
        }

        doc.end();
    });
}

function renderInlineFormatting(doc: typeof PDFDocument.prototype, text: string, x?: number, width?: number) {
    // Detect Arabic up front: if the paragraph contains Arabic, right-align
    // the whole paragraph so it reads natively. Per-token font selection
    // happens below so a mixed run (e.g. "اسم: Klypix") picks the right
    // shaping font for each segment.
    const paragraphAr = containsArabic(text);
    const tokens: { text: string; font: string; color?: string }[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
        if (boldMatch) {
            tokens.push({ text: boldMatch[1], font: fontKey(boldMatch[1], 'bold') });
            remaining = remaining.slice(boldMatch[0].length);
            continue;
        }
        const italicMatch = remaining.match(/^\*(.+?)\*/);
        if (italicMatch) {
            tokens.push({ text: italicMatch[1], font: fontKey(italicMatch[1], 'italic') });
            remaining = remaining.slice(italicMatch[0].length);
            continue;
        }
        const codeMatch = remaining.match(/^`(.+?)`/);
        if (codeMatch) {
            tokens.push({ text: ` ${codeMatch[1]} `, font: FONTS.mono, color: BRAND.accentDark });
            remaining = remaining.slice(codeMatch[0].length);
            continue;
        }
        const nextSpecial = remaining.search(/[*`]/);
        if (nextSpecial > 0) {
            const seg = remaining.slice(0, nextSpecial);
            tokens.push({ text: seg, font: fontKey(seg, 'regular') });
            remaining = remaining.slice(nextSpecial);
        } else {
            tokens.push({ text: remaining, font: fontKey(remaining, 'regular') });
            remaining = '';
        }
    }

    if (tokens.length === 0) {
        doc.text('');
        return;
    }

    for (let i = 0; i < tokens.length; i++) {
        const isFirst = i === 0;
        const isLast = i === tokens.length - 1;
        const opts: any = { continued: !isLast };
        if (isFirst && x !== undefined) opts.indent = 0;
        if (isFirst && width !== undefined) opts.width = width;
        if (paragraphAr) opts.align = 'right';

        doc.font(tokens[i].font);
        if (tokens[i].color) doc.fillColor(tokens[i].color!);
        else doc.fillColor(BRAND.body);

        if (isFirst && x !== undefined) {
            doc.text(tokens[i].text, x, doc.y, opts);
        } else {
            doc.text(tokens[i].text, opts);
        }
    }
}

function renderTable(doc: typeof PDFDocument.prototype, headers: string[], rows: string[][], maxWidth: number) {
    const startX = LAYOUT.marginLeft;
    const colCount = headers.length;
    const cellPadding = 6;
    const lineHeight = 12;
    const cellVPadding = 6;

    // Calculate dynamic column widths using actual font metrics. Pick the
    // bold/regular variant per-cell so Arabic cells measure against Thmanyah
    // instead of falling through to Helvetica's "missing-glyph" width.
    const maxContentWidths = headers.map((_, colIdx) => {
        const headerText = headers[colIdx].toUpperCase();
        doc.font(fontKey(headerText, 'bold')).fontSize(9);
        let maxW = doc.widthOfString(headerText);
        for (const row of rows) {
            const cellText = String(row[colIdx] || '');
            doc.font(fontKey(cellText, 'regular')).fontSize(9);
            const cellW = doc.widthOfString(cellText);
            if (cellW > maxW) maxW = cellW;
        }
        return maxW + cellPadding * 2;
    });
    const totalContentWidth = maxContentWidths.reduce((a, b) => a + b, 0) || 1;
    const colWidths = maxContentWidths.map(w => {
        const proportional = (w / totalContentWidth) * maxWidth;
        const minWidth = 40;
        const maxCol = maxWidth * 0.5;
        return Math.max(minWidth, Math.min(proportional, maxCol));
    });
    const widthSum = colWidths.reduce((a, b) => a + b, 0);
    const widthScale = maxWidth / widthSum;
    const finalWidths = colWidths.map(w => w * widthScale);

    // Calculate row height using actual font metrics for wrapping
    function getRowHeight(cells: string[], isHeader: boolean): number {
        let maxLines = 1;
        cells.forEach((cell, i) => {
            const availWidth = finalWidths[i] - cellPadding * 2;
            const cellText = String(cell);
            doc.font(fontKey(cellText, isHeader ? 'bold' : 'regular')).fontSize(9);
            const textWidth = doc.widthOfString(cellText);
            const lines = Math.max(1, Math.ceil(textWidth / Math.max(1, availWidth)));
            if (lines > maxLines) maxLines = lines;
        });
        return Math.max(isHeader ? 28 : 24, maxLines * lineHeight + cellVPadding * 2);
    }

    doc.moveDown(0.4);
    let y = doc.y;

    // Header row — light gray background with bold text
    const headerHeight = getRowHeight(headers, true);
    doc.save();
    doc.rect(startX, y, maxWidth, headerHeight).fill(BRAND.tableHeader);
    doc.rect(startX, y + headerHeight - 2, maxWidth, 2).fill(BRAND.accent);
    doc.restore();

    let xOffset = 0;
    doc.fillColor(BRAND.title).fontSize(9);
    headers.forEach((header, i) => {
        const headerText = header.toUpperCase();
        const ar = containsArabic(headerText);
        doc.font(fontKey(headerText, 'bold'));
        doc.text(headerText, startX + xOffset + cellPadding, y + cellVPadding, {
            width: finalWidths[i] - cellPadding * 2,
            align: ar ? 'right' : 'left',
        });
        xOffset += finalWidths[i];
    });
    y += headerHeight;

    // Data rows with alternating stripe and dynamic height
    rows.forEach((row, rowIdx) => {
        const rowHeight = getRowHeight(row, false);

        // Check page break
        if (y + rowHeight > doc.page.height - LAYOUT.marginBottom - 30) {
            doc.addPage();
            y = LAYOUT.marginTop;
        }

        if (rowIdx % 2 === 0) {
            doc.save();
            doc.rect(startX, y, maxWidth, rowHeight).fill(BRAND.tableStripe);
            doc.restore();
        }

        // Bottom border for each row
        doc.save();
        doc.moveTo(startX, y + rowHeight)
           .lineTo(startX + maxWidth, y + rowHeight)
           .strokeColor(BRAND.tableBorder)
           .lineWidth(0.5)
           .stroke();
        doc.restore();

        xOffset = 0;
        doc.fillColor(BRAND.body).fontSize(9);
        row.forEach((cell, i) => {
            const cellText = String(cell);
            const ar = containsArabic(cellText);
            doc.font(fontKey(cellText, 'regular'));
            doc.text(cellText, startX + xOffset + cellPadding, y + cellVPadding, {
                width: finalWidths[i] - cellPadding * 2,
                align: ar ? 'right' : 'left',
            });
            xOffset += finalWidths[i];
        });
        y += rowHeight;
    });

    doc.x = LAYOUT.marginLeft;
    doc.y = y + 12;
    doc.moveDown(0.3);
}
