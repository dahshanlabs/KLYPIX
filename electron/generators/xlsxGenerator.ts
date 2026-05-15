import ExcelJS from 'exceljs';

export interface XLSXSpec {
    filename?: string;
    metadata?: { title?: string; author?: string; date?: string };
    sheets: {
        name: string;
        columns: { header: string; width?: number }[];
        rows: any[][];
    }[];
}

const BRAND = {
    accent: '10B981',
    accentDark: '059669',
    headerBg: '111827',
    headerText: 'FFFFFF',
    stripeBg: 'F9FAFB',
    borderColor: 'E5E7EB',
    titleColor: '111827',
    bodyColor: '374151',
    mutedColor: '6B7280',
};

export async function generateXLSX(spec: XLSXSpec): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = spec.metadata?.author || 'Klypix';
    workbook.created = new Date();

    for (const sheet of spec.sheets) {
        const ws = workbook.addWorksheet(sheet.name || 'Sheet1', {
            views: [{ state: 'frozen', ySplit: 1 }], // Freeze header row
        });

        // ── Define columns ──────────────────────────────────────────────
        ws.columns = sheet.columns.map(c => ({
            header: c.header,
            width: c.width || Math.max(c.header.length + 4, 14),
        }));

        // ── Style header row ────────────────────────────────────────────
        const headerRow = ws.getRow(1);
        headerRow.font = {
            name: 'Calibri',
            size: 11,
            bold: true,
            color: { argb: BRAND.headerText },
        };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: BRAND.headerBg },
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
        headerRow.height = 28;

        // Header bottom border (accent colored)
        headerRow.eachCell((cell) => {
            cell.border = {
                bottom: { style: 'medium', color: { argb: BRAND.accent } },
            };
        });

        // ── Add data rows ───────────────────────────────────────────────
        for (let i = 0; i < sheet.rows.length; i++) {
            const row = sheet.rows[i];
            const wsRow = ws.addRow(row);
            const rowNum = i + 2; // 1-indexed, row 1 is header

            // Row font
            wsRow.font = {
                name: 'Calibri',
                size: 10.5,
                color: { argb: BRAND.bodyColor },
            };
            wsRow.alignment = { vertical: 'middle' };
            wsRow.height = 22;

            // Alternating stripe
            if (i % 2 === 0) {
                wsRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: BRAND.stripeBg },
                };
            }

            // Subtle bottom border on each row
            wsRow.eachCell((cell) => {
                cell.border = {
                    bottom: { style: 'thin', color: { argb: BRAND.borderColor } },
                };
            });

            // ── Auto-detect formulas and number formatting ─────────────
            for (let j = 0; j < row.length; j++) {
                const cell = wsRow.getCell(j + 1);
                const val = row[j];

                if (typeof val === 'string') {
                    // Formula: =SUM(...), =A1+B1, etc.
                    if (val.trim().startsWith('=')) {
                        cell.value = { formula: val.trim().slice(1) } as any;
                        continue;
                    }
                    // Currency: $1,234.56
                    if (/^\$[\d,.]+$/.test(val.trim())) {
                        const num = parseFloat(val.replace(/[$,]/g, ''));
                        if (!isNaN(num)) {
                            cell.value = num;
                            cell.numFmt = '$#,##0.00';
                        }
                    }
                    // Percentage: 45.5%
                    else if (/^[\d.]+%$/.test(val.trim())) {
                        const num = parseFloat(val) / 100;
                        if (!isNaN(num)) {
                            cell.value = num;
                            cell.numFmt = '0.0%';
                        }
                    }
                    // Pure number with commas: 1,234
                    else if (/^[\d,]+\.?\d*$/.test(val.trim()) && val.includes(',')) {
                        const num = parseFloat(val.replace(/,/g, ''));
                        if (!isNaN(num)) {
                            cell.value = num;
                            cell.numFmt = '#,##0';
                        }
                    }
                }
            }
        }

        // ── Auto-filter ─────────────────────────────────────────────────
        const lastCol = sheet.columns.length;
        const lastRow = sheet.rows.length + 1;
        ws.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: lastRow, column: lastCol },
        };

        // ── Auto-width: expand columns if content is wider than header ──
        ws.columns.forEach((col, colIdx) => {
            let maxLen = col.width || 14;
            sheet.rows.forEach(row => {
                const val = String(row[colIdx] || '');
                maxLen = Math.max(maxLen, Math.min(val.length + 3, 50));
            });
            col.width = maxLen;
        });
    }

    // ── Write to buffer ─────────────────────────────────────────────────
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
