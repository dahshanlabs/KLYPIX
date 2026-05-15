import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

// ── Corporate PDF Generator ─────────────────────────────────────────────────
// Clean corporate style inspired by McKinsey/Deloitte reports.
// Features: header/footer on every page, page numbers, accent bars,
// professional typography, clean tables, proper spacing.

const FONTS = {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    mono: 'Courier',
};

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
                if (isFirstHeading) {
                    docTitle = text;
                    isFirstHeading = false;
                    // Title with accent bar
                    doc.moveDown(0.8);
                    doc.save();
                    doc.rect(LAYOUT.marginLeft - 4, doc.y - 2, 4, 32).fill(BRAND.accent);
                    doc.restore();
                    doc.font(FONTS.bold).fontSize(26).fillColor(BRAND.title);
                    doc.text(text, LAYOUT.marginLeft + 8, doc.y);
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
                    doc.font(FONTS.bold).fontSize(22).fillColor(BRAND.title);
                    doc.text(text, LAYOUT.marginLeft + 8, doc.y);
                    doc.moveDown(0.5);
                }
            }
            // ── H2 ─────────────────────────────────────────────────────────
            else if (trimmed.startsWith('## ')) {
                doc.moveDown(0.8);
                doc.font(FONTS.bold).fontSize(16).fillColor(BRAND.title);
                doc.text(trimmed.slice(3));
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
                doc.moveDown(0.6);
                doc.font(FONTS.bold).fontSize(13).fillColor(BRAND.accentDark);
                doc.text(trimmed.slice(4));
                doc.moveDown(0.3);
            }
            // ── Blockquote ─────────────────────────────────────────────────
            else if (trimmed.startsWith('> ')) {
                doc.moveDown(0.2);
                doc.save();
                const quoteY = doc.y;
                doc.rect(LAYOUT.marginLeft + 10, quoteY - 2, 3, 18).fill(BRAND.accent);
                doc.restore();
                doc.font(FONTS.italic).fontSize(10.5).fillColor(BRAND.muted);
                doc.text(trimmed.slice(2), LAYOUT.marginLeft + 22, doc.y, { width: pageWidth - 30 });
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
                    doc.font(FONTS.regular).fontSize(7.5).fillColor(BRAND.light);
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
    const tokens: { text: string; font: string; color?: string }[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
        if (boldMatch) {
            tokens.push({ text: boldMatch[1], font: FONTS.bold });
            remaining = remaining.slice(boldMatch[0].length);
            continue;
        }
        const italicMatch = remaining.match(/^\*(.+?)\*/);
        if (italicMatch) {
            tokens.push({ text: italicMatch[1], font: FONTS.italic });
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
            tokens.push({ text: remaining.slice(0, nextSpecial), font: FONTS.regular });
            remaining = remaining.slice(nextSpecial);
        } else {
            tokens.push({ text: remaining, font: FONTS.regular });
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

    // Calculate dynamic column widths using actual font metrics
    const maxContentWidths = headers.map((_, colIdx) => {
        doc.font(FONTS.bold).fontSize(9);
        let maxW = doc.widthOfString(headers[colIdx].toUpperCase());
        doc.font(FONTS.regular).fontSize(9);
        for (const row of rows) {
            const cellW = doc.widthOfString(String(row[colIdx] || ''));
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
            doc.font(isHeader ? FONTS.bold : FONTS.regular).fontSize(9);
            const textWidth = doc.widthOfString(String(cell));
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

    doc.font(FONTS.bold).fontSize(9).fillColor(BRAND.title);
    let xOffset = 0;
    headers.forEach((header, i) => {
        doc.text(header.toUpperCase(), startX + xOffset + cellPadding, y + cellVPadding, {
            width: finalWidths[i] - cellPadding * 2,
            align: 'left',
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

        doc.font(FONTS.regular).fontSize(9).fillColor(BRAND.body);
        xOffset = 0;
        row.forEach((cell, i) => {
            doc.text(String(cell), startX + xOffset + cellPadding, y + cellVPadding, {
                width: finalWidths[i] - cellPadding * 2,
                align: 'left',
            });
            xOffset += finalWidths[i];
        });
        y += rowHeight;
    });

    doc.x = LAYOUT.marginLeft;
    doc.y = y + 12;
    doc.moveDown(0.3);
}
