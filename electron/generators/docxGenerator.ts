import {
    Document, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType,
    AlignmentType, Packer, PageBreak,
    LevelFormat, BorderStyle, ShadingType,
    Header, Footer, PageNumber, NumberFormat,
    Tab, TabStopPosition, TabStopType,
    convertInchesToTwip,
} from 'docx';

export interface DOCXSpec {
    filename?: string;
    metadata?: { title?: string; author?: string; subject?: string; date?: string };
    sections: DOCXSection[];
}

type DOCXSection =
    | { type: 'heading1'; text: string }
    | { type: 'heading2'; text: string }
    | { type: 'heading3'; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'bullet_list'; items: string[] }
    | { type: 'numbered_list'; items: string[] }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'blockquote'; text: string }
    | { type: 'page_break' };

const BRAND = {
    accent: '10b981',
    accentDark: '059669',
    title: '111827',
    body: '374151',
    muted: '6b7280',
    light: '9ca3af',
    tableBorder: 'e5e7eb',
    tableHeader: 'f3f4f6',
    tableStripe: 'f9fafb',
    white: 'ffffff',
};

function parseInlineFormatting(text: string): TextRun[] {
    const runs: TextRun[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
        if (boldMatch) {
            runs.push(new TextRun({ text: boldMatch[1], bold: true, font: 'Calibri', color: BRAND.title }));
            remaining = remaining.slice(boldMatch[0].length);
            continue;
        }
        const italicMatch = remaining.match(/^\*(.+?)\*/);
        if (italicMatch) {
            runs.push(new TextRun({ text: italicMatch[1], italics: true, font: 'Calibri', color: BRAND.muted }));
            remaining = remaining.slice(italicMatch[0].length);
            continue;
        }
        const codeMatch = remaining.match(/^`(.+?)`/);
        if (codeMatch) {
            runs.push(new TextRun({
                text: ` ${codeMatch[1]} `,
                font: 'Consolas',
                size: 19,
                color: BRAND.accentDark,
                shading: { type: ShadingType.SOLID, color: BRAND.tableHeader, fill: BRAND.tableHeader },
            }));
            remaining = remaining.slice(codeMatch[0].length);
            continue;
        }
        const nextSpecial = remaining.search(/[*`]/);
        if (nextSpecial > 0) {
            runs.push(new TextRun({ text: remaining.slice(0, nextSpecial), font: 'Calibri', color: BRAND.body }));
            remaining = remaining.slice(nextSpecial);
        } else {
            runs.push(new TextRun({ text: remaining, font: 'Calibri', color: BRAND.body }));
            remaining = '';
        }
    }

    if (runs.length === 0) {
        runs.push(new TextRun({ text, font: 'Calibri', color: BRAND.body }));
    }
    return runs;
}

function buildCorporateTable(headers: string[], rows: string[][]): Table {
    // Content-proportional column widths
    const totalDxa = 9500;
    const maxLengths = headers.map((h, colIdx) => {
        let maxLen = h.length;
        for (const row of rows) {
            const cellLen = String(row[colIdx] || '').length;
            if (cellLen > maxLen) maxLen = cellLen;
        }
        return maxLen;
    });
    const totalLen = maxLengths.reduce((a, b) => a + b, 0) || 1;
    const rawWidths = maxLengths.map(len => {
        const proportional = Math.round((len / totalLen) * totalDxa);
        return Math.max(Math.round(totalDxa * 0.08), Math.min(proportional, Math.round(totalDxa * 0.5)));
    });
    const rawSum = rawWidths.reduce((a, b) => a + b, 0);
    const colWidths = rawWidths.map(w => Math.round(w * (totalDxa / rawSum)));

    const headerRow = new TableRow({
        children: headers.map((h, colIdx) => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({
                    text: h.toUpperCase(),
                    bold: true,
                    font: 'Calibri',
                    size: 18,
                    color: BRAND.title,
                })],
                spacing: { before: 80, after: 80 },
            })],
            width: { size: colWidths[colIdx], type: WidthType.DXA },
            shading: { type: ShadingType.SOLID, color: BRAND.tableHeader, fill: BRAND.tableHeader },
            borders: {
                bottom: { style: BorderStyle.SINGLE, size: 4, color: BRAND.accent },
                top: { style: BorderStyle.NONE, size: 0, color: BRAND.white },
                left: { style: BorderStyle.NONE, size: 0, color: BRAND.white },
                right: { style: BorderStyle.NONE, size: 0, color: BRAND.white },
            },
        })),
        tableHeader: true,
    });

    const dataRows = rows.map((row, rowIdx) => new TableRow({
        children: row.map((cell, colIdx) => new TableCell({
            children: [new Paragraph({
                children: parseInlineFormatting(String(cell)),
                spacing: { before: 60, after: 60 },
            })],
            width: { size: colWidths[colIdx] || colWidths[0], type: WidthType.DXA },
            shading: rowIdx % 2 === 0
                ? { type: ShadingType.SOLID, color: BRAND.tableStripe, fill: BRAND.tableStripe }
                : undefined,
            borders: {
                bottom: { style: BorderStyle.SINGLE, size: 1, color: BRAND.tableBorder },
                top: { style: BorderStyle.NONE, size: 0, color: BRAND.white },
                left: { style: BorderStyle.NONE, size: 0, color: BRAND.white },
                right: { style: BorderStyle.NONE, size: 0, color: BRAND.white },
            },
        })),
    }));

    return new Table({
        rows: [headerRow, ...dataRows],
        width: { size: 100, type: WidthType.PERCENTAGE },
    });
}

export async function generateDOCX(spec: DOCXSpec): Promise<Buffer> {
    const children: (Paragraph | Table)[] = [];
    const title = spec.metadata?.title || '';
    const date = spec.metadata?.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    for (const section of spec.sections) {
        switch (section.type) {
            case 'heading1':
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: section.text, bold: true, font: 'Calibri', size: 44, color: BRAND.title }),
                    ],
                    spacing: { before: 360, after: 120 },
                    border: {
                        bottom: { style: BorderStyle.SINGLE, size: 2, color: BRAND.accent, space: 8 },
                    },
                }));
                break;

            case 'heading2':
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: section.text, bold: true, font: 'Calibri', size: 32, color: BRAND.title }),
                    ],
                    spacing: { before: 280, after: 100 },
                }));
                break;

            case 'heading3':
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: section.text, bold: true, font: 'Calibri', size: 26, color: BRAND.accentDark }),
                    ],
                    spacing: { before: 200, after: 80 },
                }));
                break;

            case 'paragraph':
                children.push(new Paragraph({
                    children: parseInlineFormatting(section.text),
                    spacing: { after: 140, line: 276 },
                }));
                break;

            case 'blockquote':
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: section.text, italics: true, font: 'Calibri', color: BRAND.muted, size: 21 }),
                    ],
                    spacing: { before: 120, after: 120 },
                    indent: { left: convertInchesToTwip(0.4) },
                    border: {
                        left: { style: BorderStyle.SINGLE, size: 6, color: BRAND.accent, space: 10 },
                    },
                }));
                break;

            case 'bullet_list':
                for (const item of section.items) {
                    children.push(new Paragraph({
                        children: parseInlineFormatting(item),
                        bullet: { level: 0 },
                        spacing: { after: 70, line: 260 },
                    }));
                }
                children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
                break;

            case 'numbered_list':
                for (const item of section.items) {
                    children.push(new Paragraph({
                        children: parseInlineFormatting(item),
                        numbering: { reference: 'corporate-numbering', level: 0 },
                        spacing: { after: 70, line: 260 },
                    }));
                }
                children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
                break;

            case 'table':
                children.push(buildCorporateTable(section.headers, section.rows));
                children.push(new Paragraph({ text: '', spacing: { after: 160 } }));
                break;

            case 'page_break':
                children.push(new Paragraph({ children: [new PageBreak()] }));
                break;
        }
    }

    const doc = new Document({
        creator: spec.metadata?.author || 'Klypix',
        title: title,
        description: spec.metadata?.subject,
        styles: {
            default: {
                document: {
                    run: {
                        font: 'Calibri',
                        size: 22,
                        color: BRAND.body,
                    },
                    paragraph: {
                        spacing: { line: 276 },
                    },
                },
            },
        },
        numbering: {
            config: [{
                reference: 'corporate-numbering',
                levels: [{
                    level: 0,
                    format: LevelFormat.DECIMAL,
                    text: '%1.',
                    alignment: AlignmentType.START,
                    style: {
                        run: { bold: true, color: BRAND.accent, font: 'Calibri' },
                    },
                }],
            }],
        },
        sections: [{
            headers: {
                default: new Header({
                    children: [new Paragraph({
                        children: [
                            new TextRun({ text: title, font: 'Calibri', size: 16, color: BRAND.light }),
                            new TextRun({ text: '\t' }),
                            new TextRun({ text: date, font: 'Calibri', size: 16, color: BRAND.light }),
                        ],
                        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                        border: {
                            bottom: { style: BorderStyle.SINGLE, size: 1, color: BRAND.tableBorder, space: 4 },
                        },
                    })],
                }),
            },
            footers: {
                default: new Footer({
                    children: [new Paragraph({
                        children: [
                            new TextRun({ text: 'Klypix', font: 'Calibri', size: 14, color: BRAND.light }),
                            new TextRun({ text: '\t' }),
                            new TextRun({ text: 'Page ', font: 'Calibri', size: 14, color: BRAND.light }),
                            new TextRun({ children: [PageNumber.CURRENT], font: 'Calibri', size: 14, color: BRAND.muted }),
                            new TextRun({ text: ' of ', font: 'Calibri', size: 14, color: BRAND.light }),
                            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Calibri', size: 14, color: BRAND.muted }),
                        ],
                        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                        border: {
                            top: { style: BorderStyle.SINGLE, size: 1, color: BRAND.tableBorder, space: 4 },
                        },
                    })],
                }),
            },
            children,
        }],
    });

    return Packer.toBuffer(doc);
}
