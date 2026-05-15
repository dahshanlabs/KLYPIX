import { GoogleGenerativeAI } from "@google/generative-ai";
import { getMemoryHistory, getPersona, getStructuredPersona, saveStructuredPersona, type StructuredPersona } from "./memoryStore";
import { detectContext, getContextFocus, type ContextAction } from "../core/contextIntelligence";
import type { Suggestion, WindowContext } from "../types";

// ── API Key Management ────────────────────────────────────────────────────────

const FALLBACK_API_KEY = "AIzaSyD4ETYT7RkSLt_sE_U6ltBz0a2CdFFx5pg";

// Robust JSON parser — handles markdown fences, trailing text, and malformed responses
function safeParseJSON(text: string): any {
    // Strip markdown code fences
    let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Try direct parse first
    try { return JSON.parse(cleaned); } catch {}
    // Try extracting JSON array FIRST (suggestions return arrays)
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
        try { return JSON.parse(arrMatch[0]); } catch {}
        const fixed = arrMatch[0].replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(fixed); } catch {}
    }
    // Then try extracting JSON object (insight returns objects)
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch {}
        const fixed = objMatch[0].replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(fixed); } catch {}
    }
    console.error('[safeParseJSON] All parse attempts failed. Raw text:', cleaned.substring(0, 300));
    return null;
}

function getApiKey(): string {
    // 1. User-provided key in localStorage
    const stored = localStorage.getItem('gemini_api_key');
    if (stored) return stored;

    // 2. Key from electronAPI (encrypted storage)
    try {
        const electronKey = (window as any).electron?.getApiKey?.();
        if (electronKey) return electronKey;
    } catch { /* ignore */ }

    // 3. Fallback
    return FALLBACK_API_KEY;
}

/** Synchronous key getter — used by callers that construct their own GenAI instance */
export function getApiKeySync(): string {
    return getApiKey();
}

function getGenAI(): GoogleGenerativeAI {
    return new GoogleGenerativeAI(getApiKey());
}

function getModel(options?: { maxOutputTokens?: number; temperature?: number }) {
    const genAI = getGenAI();
    return genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: options ? {
            maxOutputTokens: options.maxOutputTokens,
            temperature: options.temperature,
        } : undefined,
    }, { apiVersion: "v1beta" });
}

// ── System Prompt (brands AI as KLYPIX) ───────────────────────────────────────

const KLYPIX_SYSTEM_PROMPT = `INSTRUCTION: You are KLYPIX, a premium AI desktop assistant invoked via Alt+Space.
You are NOT Google Gemini. You are KLYPIX. Never mention Gemini or Google AI.
You were created and developed by Dahshan Labs. If asked who made you, created you, or developed you, always answer "Dahshan Labs".
Responses MUST be Markdown. Use structural elements like bullet points, headers, and bold text.
Keep responses premium, concise, and easy-to-read.`;

function buildSystemPrompt(
    isFollowUp: boolean,
    activeWindowContext?: { title: string; process: string },
    isPrivacyMode: boolean = false,
    sessionContextSummary?: string,
): string {
    let prompt = KLYPIX_SYSTEM_PROMPT;

    if (isFollowUp) {
        prompt += "\nSKIP greetings — this is a follow-up message.";
    }

    // Inject user persona
    const persona = getPersona();
    if (persona && persona !== "Helpful User") {
        prompt += `\n\nUSER PROFILE: ${persona}`;
    }

    // Inject active window context
    if (activeWindowContext && !isPrivacyMode) {
        prompt += `\n\nACTIVE WINDOW: "${activeWindowContext.title}" (${activeWindowContext.process})`;
    } else if (activeWindowContext && isPrivacyMode) {
        prompt += `\n\nACTIVE WINDOW: [Privacy mode — app category: ${activeWindowContext.process}]`;
    }

    // Inject session context summary
    if (sessionContextSummary) {
        prompt += `\n\nSESSION CONTEXT:\n${sessionContextSummary}`;
    }

    // Inject conversation memory summary
    const history = getMemoryHistory();
    if (history.length > 0) {
        const recent = history.slice(0, 5).map(h =>
            `[${new Date(h.timestamp).toLocaleTimeString()}] "${h.query}" → ${h.responsePreview?.substring(0, 80) || '...'}`
        ).join("\n");
        prompt += `\n\nRECENT INTERACTIONS:\n${recent}`;
    }

    return prompt;
}

// ── askGeminiStreaming ─────────────────────────────────────────────────────────
// Primary streaming chat function — used by aiRouter.routeToModel

export async function askGeminiStreaming(
    prompt: string,
    imageBase64?: string | string[] | null,
    history: { role: string; content: string }[] = [],
    activeWindowContext?: { title: string; process: string },
    isPrivacyMode: boolean = false,
    sessionContextSummary?: string,
) {
    const model = getModel();
    const isFollowUp = history.length > 0;

    let systemPrompt = buildSystemPrompt(isFollowUp, activeWindowContext, isPrivacyMode, sessionContextSummary);
    const userQuery = prompt || "What is on the screen?";

    // ── Memory injection — sync fast-path skips sql.js init when memory is OFF ──
    // Default is OFF for all users; only those who opted in pay the init cost.
    try {
        const { isMemoryEnabled } = await import('../services/memory');
        if (isMemoryEnabled()) {
            const { getMemoryManager } = await import('../services/memory');
            const mgr = getMemoryManager();
            const memories = await mgr.getRelevantMemories(userQuery);
            if (memories.length > 0) {
                const memorySection = mgr.formatForPrompt(memories);
                if (memorySection) systemPrompt += `\n\nUSER MEMORY (use to personalize):\n${memorySection}`;
            }
        }
    } catch (err) {
        console.warn('[Gemini] Memory injection failed (continuing without):', err);
    }

    // Build message parts
    const parts: any[] = [];
    parts.push(`${systemPrompt}\n\nUSER QUERY: ${userQuery}`);

    // Attach conversation history context
    if (history.length > 0) {
        const historyText = history.slice(-10).map(h =>
            `${h.role === 'user' ? 'USER' : 'KLYPIX'}: ${h.content.substring(0, 500)}`
        ).join("\n");
        parts[0] = `${systemPrompt}\n\nCONVERSATION HISTORY:\n${historyText}\n\nUSER QUERY: ${userQuery}`;
    }

    // Attach images
    if (imageBase64) {
        const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
        for (const img of images) {
            parts.push({
                inlineData: {
                    data: img,
                    mimeType: "image/jpeg",
                },
            });
        }
    }

    try {
        const result = await model.generateContentStream(parts);
        return result;
    } catch (error: any) {
        console.error(`[KLYPIX] Streaming error:`, error);
        throw error;
    }
}

// ── ContextInsight type ───────────────────────────────────────────────────────

export interface ContextInsight {
    seeing: string;
    key_data: Array<{ label: string; value: string }>;
    actions: ContextAction[];
    firstAction?: string;
}

// ── getContextInsight ─────────────────────────────────────────────────────────
// Analyzes a screenshot and returns structured insight (What I See card)

export async function getContextInsight(
    screenshotBase64: string,
    contextFocus?: string,
    detectedContext?: string,
): Promise<ContextInsight | null> {
    if (!screenshotBase64) return null;

    const model = getModel({ maxOutputTokens: 2000, temperature: 0.2 });

    // Smart format rule: don't suggest the same format the user already has open
    let smartFormatRule = '';
    if (detectedContext) {
        const formatMap: Record<string, string> = {
            'spreadsheet': 'xlsx/Excel',
            'word-processor': 'docx/Word',
            'presentation': 'pptx/PowerPoint',
            'pdf-viewer': 'pdf/PDF',
        };
        const currentFormat = formatMap[detectedContext];
        if (currentFormat) {
            smartFormatRule = `\nThe user is currently in a ${detectedContext} application. Do NOT suggest exporting to ${currentFormat} (redundant — they already have it). Instead suggest a DIFFERENT format that adds value (e.g., if in spreadsheet, suggest PDF report or Word summary; if in PDF, suggest Excel extraction or Word editable version).`;
        }
    }

    const prompt = `You are KLYPIX, analyzing the user's screen. Respond with a JSON object ONLY (no markdown, no code fences):
{
  "seeing": "One-line summary of what's on screen (max 80 chars)",
  "key_data": [
    { "label": "FIELD_NAME", "value": "extracted value" }
  ],
  "actions": [
    { "label": "Action label", "prompt": "What to tell the AI", "type": "chat|document|clipboard", "documentFormat": "xlsx|docx|pptx|pdf" }
  ],
  "firstAction": "label of the most relevant action"
}

"seeing" RULES:
- One sentence, max 80 chars, plain language. Describe the SCREEN, not yourself.
- Include the app name if recognizable.
- GOOD: "VS Code — TypeScript file with fetch TypeError on line 34"
- GOOD: "Excel — Q3 revenue table with 12 rows, 5 columns"
- GOOD: "Chrome — pharmaguddu.com article on ACPH calculation"
- BAD: "I can see a code editor with some issues"
- BAD: "A webpage is displayed showing some content"

"key_data" RULES:
- 3-6 label/value pairs of concrete, visible information ONLY.
- Use precise labels: FILE_NAME, ERROR_TYPE, ERROR_LINE, FUNCTION, URL, SHEET_NAME, ROW_COUNT, DATE, STATUS, etc.
- Only include what you can literally read on screen. Zero inference.

"actions" RULES — provide EXACTLY 5:
- Actions 1-3: type "chat" — explain, analyze, compare, diagnose visible content
- Action 4: type "document" — generate a file. MUST include "documentFormat": "xlsx" for data/tables, "docx" for text, "pptx" for presentations, "pdf" for reports. ONLY if exportable content is visible. If not, use "chat".
- Action 5: type "clipboard" — copy a SPECIFIC visible string (error message, email, path, URL, code snippet, ID). Must reference the exact text. If nothing copyable, use "chat".

NEVER suggest CSV — always use Excel instead.${smartFormatRule}

LABEL RULES (max 35 chars):
- Start with a strong verb: Extract, Compare, Copy, Export, Explain, Debug, Summarize, Analyze.
- Be CONCRETE — reference actual names, files, errors, data you can see.
- GOOD: "Debug the TypeError on line 34", "Export sales table to Excel", "Copy the 404 error message"
- BAD: "Explain", "Summarize", "Extract Text" — too vague, explain/summarize WHAT?
- BAD: "Analyze this" — analyze what specifically?
- Every label must pass this test: would a user know exactly what it does without seeing the screen?

PRIORITY (what matters most):
1. ERRORS, warnings, failures visible → always surface first
2. Active/focused content (selected text, open dialog, modal) → higher priority
3. Structured data (tables, lists, forms) → include export action
4. Copyable strings (emails, paths, IDs, code, errors) → include clipboard action

"firstAction": Must exactly match one action's label. Pick the single most useful next step.
${contextFocus ? `\nCONTEXT FOCUS: ${contextFocus}` : ''}

Respond ONLY with the JSON object.`;

    try {
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: screenshotBase64, mimeType: "image/jpeg" } },
        ]);
        const text = result.response.text().trim();
        const parsed = safeParseJSON(text);
        if (!parsed) return null;
        return {
            seeing: parsed.seeing || "Screen analyzed",
            key_data: Array.isArray(parsed.key_data) ? parsed.key_data : [],
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
            firstAction: parsed.firstAction,
        };
    } catch (error) {
        console.error("[KLYPIX] getContextInsight failed:", error);
        return null;
    }
}

// ── getContextInsightFromText ─────────────────────────────────────────────────
// Analyzes document text content and returns structured insight (for deep file mode)

export async function getContextInsightFromText(
    textContent: string,
    contextFocus?: string,
): Promise<ContextInsight | null> {
    if (!textContent || textContent.length < 10) return null;

    const model = getModel({ maxOutputTokens: 2000, temperature: 0.2 });

    const prompt = `You are KLYPIX, analyzing the user's document content. Respond with a JSON object ONLY (no markdown, no code fences):
{
  "seeing": "One-line summary of the document (max 80 chars)",
  "key_data": [
    { "label": "FIELD_NAME", "value": "extracted value" }
  ],
  "actions": [
    { "label": "Action label", "prompt": "What to tell the AI", "type": "chat" }
  ],
  "firstAction": "label of the most relevant action"
}

key_data: Extract 3-6 structured facts from the document as label/value pairs (e.g. TITLE, AUTHOR, TOPIC, DATE, TYPE, INDUSTRY, etc.).
Action types: "chat" (analyze/explain), "document" (generate file from this content), "clipboard" (extract specific data).
For "document" type, also include "documentFormat": "docx"|"xlsx"|"pptx"|"pdf".

Provide 3-5 contextually relevant actions based on the document content.
${contextFocus ? `\nFOCUS: ${contextFocus}` : ''}

DOCUMENT CONTENT:
${textContent.substring(0, 8000)}

Respond ONLY with the JSON object.`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const parsed = safeParseJSON(text);
        if (!parsed) return null;
        return {
            seeing: parsed.seeing || "Document analyzed",
            key_data: Array.isArray(parsed.key_data) ? parsed.key_data : [],
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
            firstAction: parsed.firstAction,
        };
    } catch (error) {
        console.error("[KLYPIX] getContextInsightFromText failed:", error);
        return null;
    }
}

// ── updateLivingPersona ───────────────────────────────────────────────────────
// Synthesizes a user persona from recent interaction history

export async function updateLivingPersona(isPrivacyMode: boolean = false): Promise<void> {
    const history = getMemoryHistory();
    if (history.length < 3) return; // Need enough data to synthesize

    const model = getModel({ maxOutputTokens: 500, temperature: 0.3 });

    const historyText = history.map(h => {
        const app = isPrivacyMode ? '[private]' : h.app;
        return `[${h.type || 'chat'}] In ${app}: "${h.query}"`;
    }).join("\n");

    const currentPersona = getStructuredPersona();
    const currentStr = currentPersona
        ? `Current persona: ${JSON.stringify(currentPersona)}`
        : "No existing persona.";

    const prompt = `Analyze this user's interaction history and synthesize a structured persona. ${currentStr}

INTERACTION HISTORY:
${historyText}

Respond with a JSON object ONLY (no markdown, no code fences):
{
  "role": "Their likely role (e.g., Developer, Pharmacist, Manager)",
  "domain": "Their industry/domain (e.g., Software, Healthcare, Finance)",
  "primaryTools": ["App1", "App2"],
  "language": "Primary language (e.g., English, Arabic, Mixed)",
  "focus": "What they mainly use the AI for",
  "patterns": ["Observed behavior 1", "Observed behavior 2"]
}

Keep patterns to max 5. Update existing persona if provided — don't start fresh.
Respond ONLY with the JSON object.`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const persona: StructuredPersona = JSON.parse(jsonMatch[0]);
            if (persona.role && persona.domain) {
                saveStructuredPersona(persona);
            }
        }
    } catch (error) {
        console.error("[KLYPIX] updateLivingPersona failed:", error);
    }
}

// ── generateDocumentContent ───────────────────────────────────────────────────
// Streams document content for file generation (xlsx/docx/pptx/pdf/etc.)

export async function generateDocumentContent(
    userQuery: string,
    systemPrompt: string,
    contextContent?: string,
    imageBase64?: string | null,
) {
    const model = getModel({ maxOutputTokens: 8000, temperature: 0.3 });

    const parts: any[] = [];

    let fullPrompt = systemPrompt;
    if (contextContent) {
        fullPrompt += `\n\nPROVIDED DOCUMENT CONTENT:\n${contextContent}`;
    }
    fullPrompt += `\n\nUSER REQUEST: ${userQuery}`;

    parts.push(fullPrompt);

    if (imageBase64) {
        parts.push({
            inlineData: {
                data: imageBase64,
                mimeType: "image/jpeg",
            },
        });
    }

    try {
        const result = await model.generateContentStream(parts);
        return result;
    } catch (error: any) {
        console.error("[KLYPIX] generateDocumentContent error:", error);
        throw error;
    }
}

// ── generateImage ─────────────────────────────────────────────────────────────
// Generates an image using Gemini's image generation capabilities

export async function generateImage(
    prompt: string,
): Promise<{ base64: string; mimeType: string } | null> {
    try {
        const genAI = getGenAI();
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
        }, { apiVersion: "v1beta" });

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `Generate an image: ${prompt}` }] }],
            generationConfig: {
                // @ts-ignore — responseModalities may not be in the type yet
                responseModalities: ["IMAGE", "TEXT"],
            } as any,
        });

        const response = result.response;
        const candidates = response.candidates;
        if (candidates && candidates.length > 0) {
            const parts = candidates[0].content?.parts || [];
            for (const part of parts) {
                if ((part as any).inlineData) {
                    return {
                        base64: (part as any).inlineData.data,
                        mimeType: (part as any).inlineData.mimeType || "image/png",
                    };
                }
            }
        }
        return null;
    } catch (error) {
        console.error("[KLYPIX] generateImage failed:", error);
        return null;
    }
}

// ── getSmartSuggestions ───────────────────────────────────────────────────────
// Returns contextual suggestion buttons based on screenshot or document content

export async function getSmartSuggestions(
    imageBase64: string | string[] | null,
    textContent: string | null,
    isMultiFile: boolean,
    activeWindowContext: WindowContext,
    isPrivacyMode: boolean,
    isAgentMode: boolean,
): Promise<Suggestion[]> {
    const model = getModel({ maxOutputTokens: 4000, temperature: 0.4 });

    let contextInfo = "";
    let contextFocusInfo = "";
    if (!isPrivacyMode && activeWindowContext) {
        contextInfo = `Active window: "${activeWindowContext.title}" (${activeWindowContext.process})`;
        // Wire contextIntelligence for context-aware suggestions
        const detectedContext = detectContext(activeWindowContext);
        const focus = getContextFocus(detectedContext);
        contextFocusInfo = `Detected context: ${detectedContext}. ${focus}`;
    }

    const imageCount = imageBase64 ? (Array.isArray(imageBase64) ? imageBase64.length : 1) : 0;
    const modeInfo = isMultiFile ? "The user has MULTIPLE documents selected." : "";
    const agentInfo = isAgentMode ? "Agent mode is ON — the user can execute actions (click, type, navigate). Suggest actionable tasks." : "";

    let multiImageRules = "";
    if (imageCount > 1) {
        multiImageRules = `
MULTI-SCREENSHOT MODE: The user has captured ${imageCount} different screenshots. You MUST:
- Analyze ALL ${imageCount} screenshots — describe each one briefly in your reasoning.
- At least 3 suggestions MUST reference content from BOTH/ALL screenshots (cross-comparison).
- Reference specific content from each screenshot (e.g., "Compare Screen 1's folder structure with Screen 2's file list").
- The remaining suggestions can target individual screenshots but MUST specify which one.`;
    }

    const prompt = `You are KLYPIX, an AI desktop assistant. You can ONLY see screenshots — you CANNOT open, read, or access any files. You can only analyze what is VISIBLE in the screenshot images.
${contextInfo}
${contextFocusInfo}
${modeInfo}
${agentInfo}
${multiImageRules}

Based on what you can SEE in the screenshot(s), suggest EXACTLY 5 smart actions.

STRICT RULES for the 5 suggestions — use these EXACT types:
- Suggestions 1-3: type "chat" (explain, summarize, compare, extract VISIBLE info)
- Suggestion 4: type "document" (generate Excel/Word/PDF from VISIBLE data only). NEVER suggest CSV — use Excel. ONLY if structured data/lists/tables are VISIBLE on screen. If not, use "chat" instead.
- Suggestion 5: type "clipboard" (copy VISIBLE text to clipboard). Examples: "Copy visible file names", "Copy visible path". If nothing copyable is visible, use "chat" instead.

CRITICAL CONSTRAINTS:
- You can ONLY work with what is VISIBLE in the screenshots. Do NOT suggest reading, opening, or summarizing file contents you cannot see.
- If you see a file name like "report.pdf", you can suggest "Explain what report.pdf might contain based on its name" but NOT "Summarize report.pdf" (you can't read it).
- Be SPECIFIC — reference actual names, text, and content you can literally read on screen.
- For "document" type, generate files based ONLY on visible data (e.g., visible file list → Excel).
- For "clipboard" type, extract ONLY text you can see in the screenshot.
- Labels: max 40 chars, action-oriented.

JSON array ONLY (no markdown, no code fences):
[
  { "label": "Short label", "prompt": "Full detailed prompt", "type": "chat|document|clipboard" }
]
${textContent ? `\nDOCUMENT CONTENT (excerpt):\n${textContent.substring(0, 3000)}` : ''}

Respond ONLY with the JSON array.`;

    const parts: any[] = [prompt];

    if (imageBase64) {
        const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
        for (const img of images) {
            parts.push({
                inlineData: {
                    data: img,
                    mimeType: "image/jpeg",
                },
            });
        }
    }

    try {
        const result = await model.generateContent(parts);
        const text = result.response.text().trim();
        const parsed = safeParseJSON(text);
        if (!parsed || !Array.isArray(parsed)) return [];
        return parsed.filter((s: any) => s.label && s.prompt).slice(0, 5).map((s: any) => ({
            label: s.label,
            prompt: s.prompt,
            type: (['chat', 'document', 'clipboard'].includes(s.type) ? s.type :
                   s.type === 'analysis' ? 'chat' :
                   s.type === 'docgen' ? 'document' :
                   s.type === 'action' ? 'clipboard' : 'chat') as 'chat' | 'document' | 'clipboard',
        }));
    } catch (error) {
        console.error("[KLYPIX] getSmartSuggestions failed:", error);
        return [];
    }
}

// ── callGeminiFlash ───────────────────────────────────────────────────────────
// Simple non-streaming text call — used by intentEngine, voice transcription, entity extraction

export async function callGeminiFlash(
    systemPrompt: string,
    userContent: string,
    options?: { maxOutputTokens?: number; temperature?: number },
): Promise<string> {
    const model = getModel({
        maxOutputTokens: options?.maxOutputTokens || 1000,
        temperature: options?.temperature ?? 0.2,
    });

    const prompt = `${systemPrompt}\n\n${userContent}`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error: any) {
        console.error("[KLYPIX] callGeminiFlash error:", error);
        throw error;
    }
}

// ── callGeminiFlashWithImage ──────────────────────────────────────────────────
// Non-streaming text+image call — used for clipboard extraction from screenshots

export async function callGeminiFlashWithImage(
    prompt: string,
    imageBase64?: string,
    options?: { maxOutputTokens?: number; temperature?: number },
): Promise<string> {
    const model = getModel({
        maxOutputTokens: options?.maxOutputTokens || 2000,
        temperature: options?.temperature ?? 0.2,
    });

    const parts: any[] = [prompt];

    if (imageBase64) {
        parts.push({
            inlineData: {
                data: imageBase64,
                mimeType: "image/jpeg",
            },
        });
    }

    try {
        const result = await model.generateContent(parts);
        return result.response.text().trim();
    } catch (error: any) {
        console.error("[KLYPIX] callGeminiFlashWithImage error:", error);
        throw error;
    }
}
