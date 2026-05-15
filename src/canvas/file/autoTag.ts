import { GoogleGenerativeAI } from '@google/generative-ai';
import { getApiKeySync } from '../../api/gemini';

// Ask Gemini Flash to suggest 1-3 short lowercase tags for a newly-dropped
// file. Cheap call, best-effort — on any failure we return [] and the item
// just doesn't get tags. Keeps each tag short (≤ 16 chars) and lowercase
// so they fit the tag-pill rendering.

const MODEL = 'gemini-2.5-flash';

export interface TagSourceBlob {
    fileName: string;
    extension: string;
    // Optional small content sample — first ~400 chars of text/CSV/doc
    // preview, or a description of the file type for binary.
    contentSample?: string;
}

const SYSTEM = `Suggest 1 to 3 short lowercase tags for the file below.
Output format: a JSON array of strings, nothing else. Example: ["invoice","2025","acme"].
Guidelines:
- Each tag is 1-3 words, lowercase, hyphens-for-spaces, max 16 chars.
- Tag by topic/domain/entity, not by file extension.
- Return [] if you aren't sure.`;

export async function suggestTags(src: TagSourceBlob, signal?: AbortSignal): Promise<string[]> {
    try {
        const key = getApiKeySync();
        if (!key) return [];
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: SYSTEM });
        const prompt = [
            `FILENAME: ${src.fileName}`,
            `EXTENSION: ${src.extension}`,
            src.contentSample ? `CONTENT SAMPLE:\n${src.contentSample.slice(0, 400)}` : '(no content sample)',
        ].join('\n');
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        if (signal?.aborted) return [];
        const text = result.response.text().trim();
        // Strip markdown code fences if the model wrapped the JSON.
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const arr = JSON.parse(cleaned);
        if (!Array.isArray(arr)) return [];
        return arr
            .map((t: any) => String(t || '').toLowerCase().trim().replace(/\s+/g, '-').slice(0, 16))
            .filter(Boolean)
            .slice(0, 3);
    } catch {
        return [];
    }
}
