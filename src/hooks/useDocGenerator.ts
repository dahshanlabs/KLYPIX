import { useState, useCallback, useRef } from 'react';
import { detectGenerationIntent, isStructuredFormat, GENERATION_PROMPTS, FORMAT_LABELS, FORMAT_EXTENSIONS, buildDocGenPrompt } from '../core/docGeneration';
import type { GenerationFormat } from '../core/docGeneration';
import { generateDocumentContent, generateImage } from '../api/gemini';

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

            const streamResult = await generateDocumentContent(query, systemPrompt, contextContent, imageBase64);

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
                // Parse JSON spec — extract JSON object if buried in other text
                try {
                    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
                    if (jsonMatch) fullContent = jsonMatch[0];
                    spec = JSON.parse(fullContent);
                    filename = spec.filename || filename;

                    // Generate a human-readable preview
                    if (format === 'xlsx' && spec.sheets) {
                        const sheet = spec.sheets[0];
                        const headers = sheet.columns?.map((c: any) => c.header).join(' | ') || '';
                        const rowCount = sheet.rows?.length || 0;
                        preview = `Spreadsheet: ${sheet.name || 'Sheet1'}\n${headers}\n(${rowCount} rows, ${spec.sheets.length} sheet${spec.sheets.length > 1 ? 's' : ''})`;
                    } else if (format === 'docx' && spec.sections) {
                        const headings = spec.sections.filter((s: any) => s.type?.startsWith('heading')).map((s: any) => s.text);
                        preview = `Document: ${spec.metadata?.title || filename}\nSections: ${headings.join(', ') || 'None'}`;
                    } else if (format === 'pptx' && spec.slides) {
                        preview = `Presentation: ${spec.slides.length} slides\n${spec.slides.map((s: any) => `- ${s.title || s.layout}`).join('\n')}`;
                    }
                } catch {
                    // JSON parse failed — treat as plain text
                    preview = `Failed to parse structured output. Raw content available for download.`;
                    spec = null;
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
