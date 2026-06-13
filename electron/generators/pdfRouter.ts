import { generatePDF } from './pdfGenerator';
import { generatePDFViaChromium } from './htmlPdfGenerator';

export type PdfOptions = { title?: string; author?: string; date?: string };

// Single entry point for PDF generation. Chooses the engine and guarantees a
// PDF can never hard-fail: the Chromium path (correct Arabic bidi, themed HTML)
// is the default, with an automatic fall back to the legacy pdfkit generator on
// any error.
//
// Revert switch — no rebuild needed:
//   set KLYPIX_PDF_ENGINE=pdfkit   → use the legacy generator for every PDF
//   set KLYPIX_PDF_ENGINE=chromium → force the new engine (this is the default)
export async function renderPdf(content: string, options?: PdfOptions): Promise<Buffer> {
    const engine = (process.env.KLYPIX_PDF_ENGINE || 'chromium').toLowerCase();

    if (engine === 'pdfkit') {
        return generatePDF(content, options);
    }

    try {
        return await generatePDFViaChromium(content, options);
    } catch (err) {
        console.error('[pdfRouter] Chromium engine failed — falling back to pdfkit:', err);
        return generatePDF(content, options);
    }
}
