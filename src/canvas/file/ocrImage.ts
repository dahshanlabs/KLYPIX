import { GoogleGenerativeAI } from '@google/generative-ai';
import { getApiKeySync } from '../../api/gemini';
import { getAsset, bytesToBase64 } from './assetRegistry';

const OCR_PROMPT = `Extract ALL readable text from this image.
Output ONLY the text content. Preserve line breaks, lists, numbered sequences, and table layout where you can. Use simple ASCII / unicode characters; do not wrap output in markdown code fences or quotes; do not add any commentary, descriptions of the image, or labels like "Here is the text:".
If the image contains no readable text, output exactly: (no text detected)`;

/**
 * Run Gemini vision over a single canvas image asset and return the
 * extracted text (or null if the call failed). Caller is responsible for
 * showing loading state and dropping the result onto the canvas.
 *
 * Re-uses the shared user-or-fallback API key resolution from gemini.ts so
 * BYO-key users hit their own quota and free-tier users hit the bundled key.
 */
export async function ocrImageAsset(assetId: string): Promise<string | null> {
    const asset = getAsset(assetId);
    if (!asset) return null;
    try {
        const genAI = new GoogleGenerativeAI(getApiKeySync());
        const model = genAI.getGenerativeModel(
            { model: 'gemini-2.5-flash' },
            { apiVersion: 'v1beta' },
        );
        const base64 = bytesToBase64(asset.bytes);
        const result = await model.generateContent([
            { text: OCR_PROMPT },
            { inlineData: { mimeType: asset.mime, data: base64 } } as any,
        ]);
        const text = result.response?.text?.()?.trim();
        return text || null;
    } catch (err) {
        console.error('[canvas OCR] failed:', err);
        return null;
    }
}
