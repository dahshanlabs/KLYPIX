import { useState, useCallback, useRef } from 'react';
import { detectGenerationIntent, isStructuredFormat, GENERATION_PROMPTS, FORMAT_LABELS, FORMAT_EXTENSIONS, buildDocGenPrompt, INSUFFICIENT_CONTENT_MARKER } from '../core/docGeneration';
import type { GenerationFormat } from '../core/docGeneration';
import { generateDocumentContent, generateImage, safeParseJSON } from '../api/gemini';
import { getLocale } from '../i18n/strings';

// Per-format generation tuning. Bigger token budget for multi-section docs/decks
// (the old fixed 8000 truncated long output); low temperature for structured
// JSON so it parses reliably; higher for long-form prose.
const DOC_GEN_CONFIG: Record<string, { maxOutputTokens: number; temperature: number }> = {
    docx: { maxOutputTokens: 16000, temperature: 0.2 },
    pptx: { maxOutputTokens: 16000, temperature: 0.3 },
    xlsx: { maxOutputTokens: 16000, temperature: 0.1 },
    pdf:  { maxOutputTokens: 16000, temperature: 0.4 },
    md:   { maxOutputTokens: 12000, temperature: 0.4 },
    code: { maxOutputTokens: 12000, temperature: 0.2 },
    csv:  { maxOutputTokens: 8000,  temperature: 0.1 },
    json: { maxOutputTokens: 8000,  temperature: 0.1 },
    txt:  { maxOutputTokens: 8000,  temperature: 0.4 },
};

export interface GeneratedDoc {
    format: GenerationFormat;
    rawContent: string;          // Raw AI output (JSON string for structured, text for plain)
    spec: any | null;            // Parsed JSON spec (for xlsx/docx/pptx)
    filename: string;
    preview: string;             // Human-readable preview for chat
    imageBase64: string | null;  // For image generation
    imageMimeType: string | null;
}

export function useDocGenerator() {
    const [isGenerating, setIsGenerating] = useState(false);
    const [generatedDoc, setGeneratedDoc] = useState<GeneratedDoc | null>(null);
    const [genProgress, setGenProgress] = useState('');
    const [activeFormat, setActiveFormat] = useState<GenerationFormat>('txt');
    const [showFormatPicker, setShowFormatPicker] = useState(false);
    const [pendingQuery, setPendingQuery] = useState('');
    const [pickerFormats, setPickerFormats] = useState<GenerationFormat[]>([]);
    const cancelledRef = useRef(false);

    // Check if a query is a generation request
    const checkIntent = useCallback((query: string) => {
        return detectGenerationIntent(query);
    }, []);

    // Cancel generation
    const cancelGeneration = useCallback(() => {
        cancelledRef.current = true;
        setIsGenerating(false);
        setGenProgress('Generation cancelled.');
    }, []);

    // Generate a document
    const generate = useCallback(async (query: string, format: GenerationFormat, contextContent?: string, imageBase64?: string | null) => {
        cancelledRef.current = false;
        setIsGenerating(true);
        setGenProgress('Generating...');
        setActiveFormat(format);
        setGeneratedDoc(null);

        try {
            // Image generation — special path
            if (format === 'image') {
                setGenProgress('Generating image...');
                const result = await generateImage(query);
                if (result) {
                    setGeneratedDoc({
                        format: 'image',
                        rawContent: '',
                        spec: null,
                        filename: 'generated-image.png',
                        preview: 'Image generated successfully.',
                        imageBase64: result.base64,
                        imageMimeType: result.mimeType,
                    });
                } else {
                    setGenProgress('Image generation failed. The model may not support image output.');
                }
                setIsGenerating(false);
                return;
            }

            // Text/document generation — use streaming
            const basePrompt = GENERATION_PROMPTS[format] || GENERATION_PROMPTS.txt;
            const isScreenshot = !!imageBase64;
            // When screenshot is attached, the image IS the context — don't treat the placeholder text as document content
            const hasDocContext = !isScreenshot && !!contextContent && contextContent.length > 50 && !contextContent.includes('[object Object]');
            const systemPrompt = buildDocGenPrompt(basePrompt, hasDocContext, isScreenshot);

            // Fix 4: Verify content is real, not error text
            if (contextContent && (contextContent.includes('[object Object]') || contextContent.includes('Cannot read properties of'))) {
                setGenProgress('Error: Could not read the selected files. Please re-select them and try again.');
                setIsGenerating(false);
                return;
            }

            const genConfig = DOC_GEN_CONFIG[format] || { maxOutputTokens: 8000, temperature: 0.3 };
            const streamResult = await generateDocumentContent(query, systemPrompt, contextContent, imageBase64, genConfig);

            let fullContent = '';
            for await (const chunk of streamResult.stream) {
                if (cancelledRef.current) {
                    break; // User cancelled
                }
                const text = chunk.text();
                fullContent += text;
                // Show streaming progress for plain formats
                if (!isStructuredFormat(format)) {
                    setGenProgress(fullContent.length > 200 ? fullContent.slice(0, 200) + '...' : fullContent);
                } else {
                    setGenProgress(`Generating ${FORMAT_LABELS[format]}... (${fullContent.length} chars)`);
                }
            }

            if (cancelledRef.current) {
                setGenProgress('Generation cancelled.');
                setIsGenerating(false);
                return;
            }

            // Clean up the content
            fullContent = fullContent.trim();
            // Strip markdown code fences if present
            if (fullContent.startsWith('```')) {
                fullContent = fullContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
            }

            // Grounded mode can emit the "# Insufficient Content" sentinel when the
            // source is too thin. Catch it here so the user sees a friendly message
            // (in their language, written by the model after the marker) instead of
            // a broken file being produced.
            if (fullContent.startsWith(INSUFFICIENT_CONTENT_MARKER)) {
                const explanation = fullContent.slice(INSUFFICIENT_CONTENT_MARKER.length).trim();
                setGenProgress(explanation || (getLocale() === 'ar'
                    ? 'المصدر المُقدَّم غير كافٍ لإنشاء هذا المستند. أضف تفاصيل أكثر.'
                    : 'The provided source is not enough to generate this document. Add more detail.'));
                setIsGenerating(false);
                return;
            }

            let spec: any = null;
            // Generate meaningful filename from content
            let filename = `generated.${FORMAT_EXTENSIONS[format]}`;
            try {
                const firstLine = fullContent.split('\n').find(l => l.trim().length > 3) || '';
                const cleanName = firstLine.replace(/^#+\s*/, '').replace(/[*_`#]/g, '').trim().substring(0, 50);
                if (cleanName.length > 3) {
                    filename = `${cleanName.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_')}.${FORMAT_EXTENSIONS[format]}`;
                }
            } catch { /* keep default */ }
            let preview = '';

            if (isStructuredFormat(format)) {
                // Robust parse (handles fences, trailing commas, buried object).
                spec = safeParseJSON(fullContent);

                // One repair retry: re-ask the model for valid JSON only.
                if (!spec) {
                    setGenProgress(getLocale() === 'ar' ? 'جارٍ إصلاح بنية المستند...' : 'Fixing document structure...');
                    try {
                        const repairPrompt = `${basePrompt}\n\nYour previous output was NOT valid JSON and could not be used. Return ONLY a single valid JSON object — no prose, no explanation, no code fences.`;
                        const retry = await generateDocumentContent(`Convert the following into the required valid JSON object:\n\n${fullContent}`, repairPrompt, undefined, null, { maxOutputTokens: genConfig.maxOutputTokens, temperature: 0.1 });
                        let repaired = '';
                        for await (const chunk of retry.stream) {
                            if (cancelledRef.current) break;
                            repaired += chunk.text();
                        }
                        spec = safeParseJSON(repaired);
                        if (spec) fullContent = JSON.stringify(spec);
                    } catch { /* fall through to the error below */ }
                }

                // Still unusable → surface a clear error; NEVER save a raw JSON blob as a .docx/.xlsx/.pptx.
                if (!spec) {
                    setGenProgress(getLocale() === 'ar'
                        ? 'تعذّر إنشاء بنية مستند صحيحة. حاول مرة أخرى.'
                        : 'Could not produce a valid document structure. Please try again.');
                    setIsGenerating(false);
                    return;
                }

                filename = spec.filename || filename;
                // Human-readable preview (defensive: arrays may be missing on odd specs).
                if (format === 'xlsx' && Array.isArray(spec.sheets) && spec.sheets[0]) {
                    const sheet = spec.sheets[0];
                    const headers = sheet.columns?.map((c: any) => c.header).join(' | ') || '';
                    const rowCount = sheet.rows?.length || 0;
                    preview = `Spreadsheet: ${sheet.name || 'Sheet1'}\n${headers}\n(${rowCount} rows, ${spec.sheets.length} sheet${spec.sheets.length > 1 ? 's' : ''})`;
                } else if (format === 'docx' && Array.isArray(spec.sections)) {
                    const headings = spec.sections.filter((s: any) => s.type?.startsWith('heading')).map((s: any) => s.text);
                    preview = `Document: ${spec.metadata?.title || filename}\nSections: ${headings.join(', ') || 'None'}`;
                } else if (format === 'pptx' && Array.isArray(spec.slides)) {
                    preview = `Presentation: ${spec.slides.length} slides\n${spec.slides.map((s: any) => `- ${s.title || s.layout}`).join('\n')}`;
                }
            } else {
                preview = fullContent.length > 500 ? fullContent.slice(0, 500) + '\n...' : fullContent;
            }

            setGeneratedDoc({
                format,
                rawContent: fullContent,
                spec,
                filename,
                preview,
                imageBase64: null,
                imageMimeType: null,
            });
            setGenProgress('');
        } catch (err: any) {
            setGenProgress(`Error: ${err.message || 'Generation failed'}`);
        } finally {
            setIsGenerating(false);
        }
    }, []);

    // Download the generated file
    const downloadFile = useCallback(async (doc?: GeneratedDoc) => {
        const target = doc || generatedDoc;
        if (!target) return;

        if (target.format === 'image' && target.imageBase64) {
            // Save image via IPC
            const buffer = Uint8Array.from(atob(target.imageBase64), c => c.charCodeAt(0));
            const result = await (window as any).electron.generateFile({
                format: target.imageMimeType?.includes('jpeg') ? 'jpg' : 'png',
                content: target.imageBase64,
            });
            return result;
        }

        if (isStructuredFormat(target.format) && target.spec) {
            // Send structured spec to file generator
            return (window as any).electron.generateFile({
                format: target.format,
                spec: target.spec,
            });
        }

        // Plain text formats
        return (window as any).electron.generateFile({
            format: target.format,
            content: target.rawContent,
        });
    }, [generatedDoc]);

    // Handle ambiguous format — show picker, then generate
    const handleAmbiguousIntent = useCallback((query: string, formats: GenerationFormat[]) => {
        setPendingQuery(query);
        setPickerFormats(formats);
        setShowFormatPicker(true);
    }, []);

    const selectFormat = useCallback((format: GenerationFormat) => {
        setShowFormatPicker(false);
        if (pendingQuery) {
            generate(pendingQuery, format);
        }
    }, [pendingQuery, generate]);

    const cancelFormatPicker = useCallback(() => {
        setShowFormatPicker(false);
        setPendingQuery('');
        setPickerFormats([]);
    }, []);

    const clearGenerated = useCallback(() => {
        setGeneratedDoc(null);
        setGenProgress('');
    }, []);

    return {
        isGenerating,
        generatedDoc,
        genProgress,
        activeFormat,
        showFormatPicker,
        pickerFormats,
        checkIntent,
        generate,
        cancelGeneration,
        downloadFile,
        handleAmbiguousIntent,
        selectFormat,
        cancelFormatPicker,
        clearGenerated,
    };
}
