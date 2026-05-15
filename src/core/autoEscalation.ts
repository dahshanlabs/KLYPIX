// ── Auto-Escalation: Read active file for On Screen actions ──────────────
// Called in parallel with the Gemini insight when the On Screen card loads.
// If the active document/tab is readable, actions get full file content.

export interface FileAccessResult {
    fileContent: string | null;
    fileName: string | null;
    pageCount: number;
    accessGranted: boolean;
    error?: string;
}

const EMPTY_RESULT: FileAccessResult = {
    fileContent: null, fileName: null, pageCount: 0, accessGranted: false,
};

/**
 * Attempts to read the active file/tab via the existing readActiveFile IPC.
 * Returns file content if accessible, or a graceful failure otherwise.
 */
export async function tryReadActiveFile(timeoutMs = 8000): Promise<FileAccessResult> {
    try {
        const electron = (window as any).electron;
        if (!electron?.readActiveFile) return EMPTY_RESULT;

        const result = await Promise.race([
            electron.readActiveFile(),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('File read timeout')), timeoutMs)
            ),
        ]);

        if (!result || !result.content) {
            return { ...EMPTY_RESULT, error: result?.error || 'No content returned' };
        }

        return {
            fileContent: result.content,
            fileName: result.fileName || null,
            pageCount: result.pageCount || 1,
            accessGranted: true,
        };
    } catch (err: any) {
        return { ...EMPTY_RESULT, error: err?.message || 'File read failed' };
    }
}

/**
 * Wraps an action prompt with file content context (or a screenshot-only caveat).
 */
export function buildEscalatedPrompt(
    originalPrompt: string,
    fileAccess: FileAccessResult | null
): string {
    if (fileAccess?.accessGranted && fileAccess.fileContent) {
        const content = fileAccess.fileContent.length > 30000
            ? fileAccess.fileContent.substring(0, 30000) + '\n\n[... content truncated at 30,000 characters ...]'
            : fileAccess.fileContent;
        const pageInfo = fileAccess.pageCount > 1 ? ` (${fileAccess.pageCount} pages)` : '';
        return [
            `You have access to the FULL document content below${pageInfo}. Use this complete content to answer the user's request thoroughly.`,
            '',
            `--- DOCUMENT: ${fileAccess.fileName || 'Active File'} ---`,
            content,
            '--- END DOCUMENT ---',
            '',
            originalPrompt,
        ].join('\n');
    }

    return [
        'IMPORTANT: You can ONLY see what is visible on the user\'s screen (a partial view).',
        'You do NOT have access to the full document. Only describe/analyze what is visible.',
        'If asked about the "entire" document, clarify that you can only see the current view.',
        '',
        originalPrompt,
    ].join('\n');
}

// ── Web Content Access (On-Screen Browser Reading) ──────────────────────────

export interface WebAccessResult {
    webContent: string | null;
    url: string | null;
    method: 'fetch' | 'cdp' | 'clipboard' | 'file' | 'none';
    accessGranted: boolean;
    fileName?: string | null;
    pageCount?: number;
}

const EMPTY_WEB: WebAccessResult = {
    webContent: null, url: null, method: 'none', accessGranted: false,
};

/**
 * Attempts to read the web page content from the given URL via fetch→CDP chain.
 * No clipboard fallback — that's triggered manually via a separate button.
 */
export async function tryReadWebContent(url: string, title: string, timeoutMs = 12000): Promise<WebAccessResult> {
    try {
        const electron = (window as any).electron;
        if (!electron?.readWebContent) return EMPTY_WEB;

        const result = await Promise.race([
            electron.readWebContent({ url, title }),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('Web read timeout')), timeoutMs)
            ),
        ]);

        if (!result || !result.content) {
            return { ...EMPTY_WEB, url };
        }

        return {
            webContent: result.content,
            url: result.url || url,
            method: result.method || 'fetch',
            accessGranted: true,
            fileName: result.fileName || null,
            pageCount: result.pageCount || 0,
        };
    } catch {
        return { ...EMPTY_WEB, url };
    }
}

/**
 * Wraps a user prompt with full webpage content for Gemini.
 */
export function buildWebEscalatedPrompt(
    originalPrompt: string,
    webAccess: WebAccessResult | null
): string {
    if (webAccess?.accessGranted && webAccess.webContent) {
        const content = webAccess.webContent.length > 30000
            ? webAccess.webContent.substring(0, 30000) + '\n\n[... content truncated ...]'
            : webAccess.webContent;
        return [
            `You have access to the FULL webpage content below. Use this to answer thoroughly — the user may be asking about content not visible on screen.`,
            '',
            `--- WEBPAGE: ${webAccess.url || 'Active Page'} ---`,
            content,
            '--- END WEBPAGE ---',
            '',
            originalPrompt,
        ].join('\n');
    }

    return [
        'IMPORTANT: You can ONLY see what is visible on the user\'s screen (a partial view).',
        'You do NOT have access to the full webpage content. Only describe/analyze what is visible.',
        '',
        originalPrompt,
    ].join('\n');
}
