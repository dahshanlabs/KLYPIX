import { useState, useRef, useCallback } from 'react';
import { classifyIntent, meetsExecutionThreshold, isObviousChatMessage } from '../core/engine/intentEngine';
import type { Intent, ActionResult } from '../core/engine/intentTypes';
import type { WindowContext as EngineWindowContext } from '../core/engine/intentTypes';

// ── Types ──────────────────────────────────────────────────────────────

export interface QuickAction {
    label: string;
    icon: string;
    intent: Partial<Intent>;
    requiresConfirm: boolean;
}

export interface AgentHistoryEntry {
    intent: Intent;
    result: ActionResult;
    timestamp: number;
}

export interface ClipboardInfo {
    text: string;
    html: string;
    type: 'table' | 'json' | 'code' | 'urls' | 'emails' | 'plain';
    wordCount?: number;
    suggestion?: string;
}

export interface ScreenActionPending {
    action: ScreenAction['action'];
    outputFormat: 'xlsx' | 'csv' | 'json' | 'txt' | 'clipboard';
}

export interface AmbientNotice {
    id: string;
    icon: string;
    message: string;
    action?: { label: string; handler: () => void };
    dismissedAt?: number;
}

export interface DocumentMemory {
    docName: string;
    entities: ExtractedEntity[];
    analyzedAt: number;
    hash: string; // simple content hash for version detection
}

export interface ExtractedEntity {
    type: 'date' | 'amount' | 'name' | 'obligation' | 'deadline' | 'number' | 'term';
    value: string;
    context: string; // surrounding sentence
}

interface UseAgentOptions {
    activeWindowContext: { title: string; process: string };
    isAgentMode: boolean;
}

// ── Content Classifier ────────────────────────────────────────────────

function classifyClipboardContent(text: string): ClipboardInfo['type'] {
    if (!text || text.trim().length === 0) return 'plain';

    // JSON detection
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { JSON.parse(trimmed); return 'json'; } catch { /* not json */ }
    }

    // Table detection (tab-separated or pipe-separated rows)
    const lines = trimmed.split('\n');
    if (lines.length >= 2) {
        const tabCols = lines[0].split('\t').length;
        if (tabCols >= 2 && lines.slice(1).every(l => l.split('\t').length >= tabCols - 1)) return 'table';

        const pipeCols = lines[0].split('|').length;
        if (pipeCols >= 3 && lines.slice(1, 3).every(l => l.split('|').length >= pipeCols - 1)) return 'table';
    }

    // Code detection
    const codePatterns = /^(import |from |const |let |var |function |class |def |public |private |#include|package |using |<\?php)/m;
    if (codePatterns.test(trimmed)) return 'code';
    if ((trimmed.match(/[{};()]/g) || []).length > 5) return 'code';

    // Email list detection
    const emailPattern = /[\w.-]+@[\w.-]+\.\w+/g;
    const emails = trimmed.match(emailPattern);
    if (emails && emails.length >= 2) return 'emails';

    // URL list detection
    const urlPattern = /https?:\/\/[\S]+/g;
    const urls = trimmed.match(urlPattern);
    if (urls && urls.length >= 2) return 'urls';

    return 'plain';
}

function getClipboardSuggestion(type: ClipboardInfo['type']): string | undefined {
    switch (type) {
        case 'table': return 'Paste as formatted table';
        case 'json': return 'Paste formatted JSON';
        case 'code': return 'Paste with syntax formatting';
        case 'urls': return 'Save URLs as list';
        case 'emails': return 'Save email addresses';
        default: return undefined;
    }
}

// ── Quick Actions (context → action mapping) ──────────────────────────

function getQuickActions(context: { title: string; process: string }, hasMessages?: boolean): QuickAction[] {
    const actions: QuickAction[] = [];
    const proc = (context.process || '').toLowerCase();
    const title = context.title || '';
    const titleLower = title.toLowerCase();

    // ── Detect file in title bar ────────────────────────────────────
    const fileMatch = title.match(/[-–—]\s*(.+\.\w{2,5})\s*(?:[-–—]|$)/);
    const fileName = fileMatch ? fileMatch[1].trim() : null;

    // ── Browser Actions ─────────────────────────────────────────────
    const isBrowser = ['chrome', 'msedge', 'firefox', 'brave', 'opera'].includes(proc);
    if (isBrowser) {
        actions.push({
            label: 'Save page content',
            icon: '📄',
            intent: { type: 'clipboard_save', parameters: { filename: 'page_content.txt' } as any },
            requiresConfirm: false,
        });
        actions.push({
            label: 'Extract table to Excel',
            icon: '📊',
            intent: { type: 'clipboard_save', parameters: { filename: 'table_data.xlsx' } as any },
            requiresConfirm: false,
        });
    }

    // ── PDF / Document Viewer ───────────────────────────────────────
    const isPDF = proc.includes('acrobat') || proc.includes('foxitreader') || proc.includes('sumatrapdf') || titleLower.includes('.pdf');
    if (isPDF) {
        actions.push({
            label: 'Summarize document',
            icon: '📝',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
        actions.push({
            label: 'Extract key data',
            icon: '📋',
            intent: { type: 'clipboard_save', parameters: { filename: 'extracted.txt' } as any },
            requiresConfirm: false,
        });
    }

    // ── Excel / Spreadsheet ─────────────────────────────────────────
    const isSpreadsheet = proc.includes('excel') || titleLower.includes('.xlsx') || titleLower.includes('.csv') || titleLower.includes('.xls');
    if (isSpreadsheet) {
        actions.push({
            label: 'Save a backup',
            icon: '💾',
            intent: { type: 'file_save', parameters: { destination: 'C:\\Users\\HP\\Desktop' } as any },
            requiresConfirm: false,
        });
        actions.push({
            label: 'Summarize data',
            icon: '📊',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
    }

    // ── Word / Document Editor ──────────────────────────────────────
    const isWordDoc = proc.includes('winword') || proc.includes('wordpad') || titleLower.includes('.docx') || titleLower.includes('.doc');
    if (isWordDoc) {
        actions.push({
            label: 'Summarize document',
            icon: '📝',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
        actions.push({
            label: 'Convert to PDF',
            icon: '📄',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
    }

    // ── PowerPoint ──────────────────────────────────────────────────
    const isPPT = proc.includes('powerpnt') || titleLower.includes('.pptx') || titleLower.includes('.ppt');
    if (isPPT) {
        actions.push({
            label: 'Summarize slides',
            icon: '📊',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
    }

    // ── Code Editor / IDE ───────────────────────────────────────────
    const isCodeEditor = proc.includes('code') || proc.includes('devenv') || proc.includes('idea') || proc.includes('webstorm') || proc.includes('notepad++') || proc.includes('sublime');
    if (isCodeEditor) {
        actions.push({
            label: 'Explain this code',
            icon: '💡',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
        actions.push({
            label: 'Find bugs',
            icon: '🐛',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
    }

    // ── File Actions (when any file detected in title) ──────────────
    if (fileName && !isBrowser) {
        actions.push({
            label: `Save "${fileName.length > 20 ? fileName.substring(0, 18) + '...' : fileName}" to Desktop`,
            icon: '💾',
            intent: { type: 'file_save', parameters: { sourcePath: fileName, destination: 'C:\\Users\\HP\\Desktop' } as any },
            requiresConfirm: false,
        });
        actions.push({
            label: `Rename file`,
            icon: '✏️',
            intent: { type: 'file_rename', parameters: { sourcePath: fileName } as any },
            requiresConfirm: true,
        });
    }

    // ── Error Detection (window title contains error keywords) ──────
    if (titleLower.includes('error') || titleLower.includes('exception') || titleLower.includes('failed') || titleLower.includes('crash')) {
        actions.unshift({
            label: 'Search this error',
            icon: '🔍',
            intent: { type: 'chat' as any, parameters: {} as any },
            requiresConfirm: false,
        });
    }

    // ── Universal Actions (always available) ────────────────────────
    // Only add if we have fewer than 3 context-specific actions
    if (actions.length < 2) {
        actions.push({
            label: 'Screenshot & analyze',
            icon: '📸',
            intent: { type: 'system_screenshot', parameters: {} as any },
            requiresConfirm: false,
        });
    }
    if (actions.length < 3) {
        actions.push({
            label: 'Open app...',
            icon: '🚀',
            intent: { type: 'system_open', parameters: {} as any },
            requiresConfirm: false,
        });
    }

    return actions.slice(0, 5);
}

// ── Screen Content Classifier ─────────────────────────────────────────

export interface ScreenAction {
    label: string;
    icon: string;
    action: 'extract_table' | 'extract_data' | 'search_error' | 'save_content';
    prompt: string;
    outputFormat: 'xlsx' | 'csv' | 'json' | 'txt' | 'clipboard';
}

function getScreenActions(context: { title: string; process: string }, hasScreenshot: boolean): ScreenAction[] {
    if (!hasScreenshot) return [];
    const actions: ScreenAction[] = [];
    const title = (context.title || '').toLowerCase();
    const proc = (context.process || '').toLowerCase();

    // ── Error dialog detection ──────────────────────────────────────
    if (title.includes('error') || title.includes('exception') || title.includes('warning') || title.includes('failed') || title.includes('crash')) {
        actions.push({
            label: 'Search this error',
            icon: '🔍',
            action: 'search_error',
            outputFormat: 'txt',
            prompt: 'Read the error message in this screenshot. Search for the exact error text and provide: 1) What causes this error, 2) The most likely fix, 3) If it\'s a common issue. Be specific to the exact error shown.',
        });
        actions.push({
            label: 'Copy error text',
            icon: '📋',
            action: 'extract_data',
            outputFormat: 'clipboard',
            prompt: 'Extract ONLY the error message text from this screenshot. Return the exact error message as plain text, nothing else.',
        });
    }

    // ── Spreadsheet / table on screen ───────────────────────────────
    const isTableContext = proc.includes('excel') || proc.includes('sheets') || proc.includes('calc') ||
        ['chrome', 'msedge', 'firefox', 'brave'].includes(proc);
    if (isTableContext) {
        actions.push({
            label: 'Extract table to Excel',
            icon: '📊',
            action: 'extract_table',
            outputFormat: 'xlsx',
            prompt: `Extract ALL data visible in the table/spreadsheet in this screenshot.
Return ONLY a JSON object in this exact format (no markdown, no commentary, no code fences):
{"sheets":[{"name":"Sheet1","columns":[{"header":"Column1"},{"header":"Column2"}],"rows":[["val1","val2"],["val3","val4"]]}]}
Use the actual header names from the table. Include ALL visible rows. Numbers should be numbers, not strings.`,
        });
    }

    // ── Code on screen ──────────────────────────────────────────────
    const isCodeContext = proc.includes('code') || proc.includes('devenv') || proc.includes('idea') || proc.includes('notepad');
    if (isCodeContext) {
        actions.push({
            label: 'Explain this code',
            icon: '💡',
            action: 'extract_data',
            outputFormat: 'txt',
            prompt: 'Read the code visible in this screenshot. Explain what it does, identify any bugs or issues, and suggest improvements. Be specific to the exact code shown.',
        });
        actions.push({
            label: 'Copy code as text',
            icon: '📋',
            action: 'extract_data',
            outputFormat: 'clipboard',
            prompt: 'Extract ONLY the source code visible in this screenshot. Return the code as plain text with proper indentation. No explanations, no commentary, just the code.',
        });
    }

    // ── General: always offer these ─────────────────────────────────
    if (actions.length < 3) {
        actions.push({
            label: 'Extract all data',
            icon: '📋',
            action: 'extract_data',
            outputFormat: 'json',
            prompt: `Extract ALL specific data points from this screenshot: names, numbers, dates, amounts, IDs, email addresses, phone numbers, URLs.
Return ONLY a JSON object in this exact format (no markdown, no commentary, no code fences):
{"items":[{"type":"date|amount|name|id|email|phone|url","value":"the value","context":"the surrounding text"}]}
Only include data that is actually visible — do not guess or infer.`,
        });
    }

    if (actions.length < 4) {
        actions.push({
            label: 'Read screen text',
            icon: '👁️',
            action: 'save_content',
            outputFormat: 'txt',
            prompt: 'Read and transcribe ALL text visible in this screenshot. Preserve the layout and structure as much as possible. Include headings, body text, labels, buttons, and any other visible text.',
        });
    }

    return actions.slice(0, 4);
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useAgent(opts: UseAgentOptions) {
    const [isAgentMode, setIsAgentMode] = useState(opts.isAgentMode);
    const [pendingIntent, setPendingIntent] = useState<Intent | null>(null);
    const [isClassifying, setIsClassifying] = useState(false);
    const [lastResult, setLastResult] = useState<ActionResult | null>(null);
    const [history, setHistory] = useState<AgentHistoryEntry[]>(() => {
        try {
            const saved = localStorage.getItem('agent_history');
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });
    const [clipboardInfo, setClipboardInfo] = useState<ClipboardInfo | null>(null);

    const historyRef = useRef(history);
    historyRef.current = history;

    // Save history to localStorage
    const saveHistory = useCallback((entries: AgentHistoryEntry[]) => {
        const capped = entries.slice(-100); // Keep last 100
        setHistory(capped);
        historyRef.current = capped;
        localStorage.setItem('agent_history', JSON.stringify(capped));
    }, []);

    // ── Classify user command ──────────────────────────────────────────
    const classify = useCallback(async (command: string): Promise<Intent | null> => {
        if (isObviousChatMessage(command)) return null;

        setIsClassifying(true);
        try {
            const ctx: EngineWindowContext = {
                windowTitle: opts.activeWindowContext.title,
                processName: opts.activeWindowContext.process,
                filePath: null,
                fileName: null,
                browserUrl: null,
                textContent: null,
            };
            const intent = await classifyIntent(command, ctx);
            if (intent) {
                setPendingIntent(intent);
            }
            return intent;
        } catch (err) {
            console.error('[Agent] Classification error:', err);
            return null;
        } finally {
            setIsClassifying(false);
        }
    }, [isAgentMode, opts.activeWindowContext]);

    // ── Execute a confirmed intent ─────────────────────────────────────
    const execute = useCallback(async (intent: Intent): Promise<ActionResult> => {
        setPendingIntent(null);
        try {
            const result = await (window as any).electron.executeAction(intent);
            const actionResult: ActionResult = {
                success: result.success,
                intentType: intent.type,
                message: result.message,
                undoPayload: result.undoPayload,
                executedAt: result.executedAt || new Date().toISOString(),
            };
            setLastResult(actionResult);

            // Add to history
            const entry: AgentHistoryEntry = { intent, result: actionResult, timestamp: Date.now() };
            saveHistory([...historyRef.current, entry]);

            return actionResult;
        } catch (err: any) {
            const failResult: ActionResult = {
                success: false,
                intentType: intent.type,
                message: err.message || 'Execution failed',
                executedAt: new Date().toISOString(),
            };
            setLastResult(failResult);
            return failResult;
        }
    }, [saveHistory]);

    // ── Undo last action ──────────────────────────────────────────────
    const undo = useCallback(async (entry: AgentHistoryEntry): Promise<boolean> => {
        const payload = entry.result.undoPayload as any;
        if (!payload) return false;

        try {
            let undoIntent: any;
            switch (payload.type) {
                case 'rename':
                    undoIntent = { type: 'file_rename', parameters: { sourcePath: payload.from, newName: payload.originalName } };
                    break;
                case 'move':
                    undoIntent = { type: 'file_move', parameters: { sourcePath: payload.from, destination: payload.to } };
                    break;
                case 'delete':
                    // Can't undo a delete from recycle bin via IPC — just inform user
                    return false;
                case 'clipboard_restore':
                    undoIntent = { type: 'clipboard_copy', parameters: { text: payload.text } };
                    break;
                default:
                    return false;
            }
            const result = await (window as any).electron.executeAction(undoIntent);
            if (result.success) {
                // Remove the undone entry from history
                saveHistory(historyRef.current.filter(e => e.timestamp !== entry.timestamp));
            }
            return result.success;
        } catch {
            return false;
        }
    }, [saveHistory]);

    // ── Dismiss pending intent ─────────────────────────────────────────
    const dismiss = useCallback(() => {
        setPendingIntent(null);
        setLastResult(null);
    }, []);

    // ── Check clipboard for Smart Paste ────────────────────────────────
    const lastClipRef = useRef('');

    const checkClipboard = useCallback(async () => {
        try {
            const data = await (window as any).electron.readClipboard();
            if (!data.text || data.text.trim().length === 0) {
                setClipboardInfo(null);
                return null;
            }
            // Skip if clipboard hasn't changed
            if (data.text === lastClipRef.current) return clipboardInfo;
            lastClipRef.current = data.text;

            const type = classifyClipboardContent(data.text);
            const wordCount = data.text.trim().split(/\s+/).length;

            // Show for structured data OR plain text with 10+ words
            if (type === 'plain' && wordCount < 10) {
                setClipboardInfo(null);
                return null;
            }

            const info: ClipboardInfo = {
                text: data.text,
                html: data.html,
                type,
                wordCount,
                suggestion: getClipboardSuggestion(type),
            };
            setClipboardInfo(info);
            return info;
        } catch {
            setClipboardInfo(null);
            return null;
        }
    }, [clipboardInfo]);

    // ── Get context-aware quick actions ─────────────────────────────────
    const quickActions = isAgentMode ? getQuickActions(opts.activeWindowContext) : [];

    // ── Get screen-aware actions ────────────────────────────────────────
    const getScreenActionsForContext = useCallback((hasScreenshot: boolean) => {
        return getScreenActions(opts.activeWindowContext, hasScreenshot);
    }, [opts.activeWindowContext]);

    // ── Screen → Data → Destination: response interceptor ───────────────
    const [screenActionPending, setScreenActionPending] = useState<ScreenActionPending | null>(null);

    const startScreenAction = useCallback((action: ScreenAction) => {
        setScreenActionPending({ action: action.action, outputFormat: action.outputFormat });
    }, []);

    const handleScreenActionResponse = useCallback(async (aiResponse: string): Promise<{ handled: boolean; message?: string }> => {
        if (!screenActionPending) return { handled: false };

        const pending = screenActionPending;
        setScreenActionPending(null);

        // Search error — no file generation, just display the response
        if (pending.action === 'search_error') {
            return { handled: false }; // Let normal chat display handle it
        }

        // Try to parse JSON from the response
        let jsonData: any = null;
        try {
            // Strip markdown code fences if present
            const cleaned = aiResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            jsonData = JSON.parse(cleaned);
        } catch {
            // Try to find JSON object in the response
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { jsonData = JSON.parse(jsonMatch[0]); } catch { /* give up */ }
            }
        }

        if (!jsonData) {
            return { handled: false, message: 'Could not parse structured data from AI response. Showing as text.' };
        }

        // Route to file generator based on format
        try {
            if (pending.outputFormat === 'xlsx' && jsonData.sheets) {
                const result = await (window as any).electron.generateFile({
                    format: 'xlsx',
                    spec: { ...jsonData, filename: `extracted_${Date.now()}.xlsx` },
                });
                if (result.success) return { handled: true, message: `Saved to ${result.path}` };
                if (result.reason === 'cancelled') return { handled: true, message: 'Save cancelled' };
                return { handled: true, message: `Save failed: ${result.reason}` };
            }

            if (pending.outputFormat === 'json') {
                const result = await (window as any).electron.generateFile({
                    format: 'json',
                    content: JSON.stringify(jsonData, null, 2),
                    spec: { filename: `extracted_${Date.now()}.json` },
                });
                if (result.success) return { handled: true, message: `Saved to ${result.path}` };
                if (result.reason === 'cancelled') return { handled: true, message: 'Save cancelled' };
                return { handled: true, message: `Save failed: ${result.reason}` };
            }

            if (pending.outputFormat === 'csv') {
                // Convert JSON array to CSV
                const items = jsonData.items || jsonData.rows || (Array.isArray(jsonData) ? jsonData : []);
                if (items.length > 0) {
                    const headers = Object.keys(items[0]);
                    const csvLines = [headers.join(','), ...items.map((r: any) => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))];
                    const result = await (window as any).electron.generateFile({
                        format: 'csv',
                        content: csvLines.join('\n'),
                        spec: { filename: `extracted_${Date.now()}.csv` },
                    });
                    if (result.success) return { handled: true, message: `Saved to ${result.path}` };
                }
            }
        } catch (err: any) {
            return { handled: true, message: `File generation error: ${err.message}` };
        }

        return { handled: false };
    }, [screenActionPending]);

    // ── Smart Paste: direct actions (no AI needed) ──────────────────────
    const smartPasteAction = useCallback(async (clipInfo: ClipboardInfo, action: 'format' | 'save' | 'copy'): Promise<{ success: boolean; message: string }> => {
        try {
            if (action === 'save') {
                if (clipInfo.type === 'table') {
                    // Parse tab-separated table → XLSX
                    const lines = clipInfo.text.trim().split('\n');
                    const headers = lines[0].split('\t');
                    const rows = lines.slice(1).map(l => l.split('\t'));
                    const result = await (window as any).electron.generateFile({
                        format: 'xlsx',
                        spec: { filename: 'clipboard_table.xlsx', sheets: [{ name: 'Sheet1', columns: headers.map((h: string) => ({ header: h })), rows }] },
                    });
                    return result.success ? { success: true, message: `Saved to ${result.path}` } : { success: false, message: result.reason || 'Failed' };
                }
                if (clipInfo.type === 'json') {
                    const formatted = JSON.stringify(JSON.parse(clipInfo.text), null, 2);
                    const result = await (window as any).electron.generateFile({
                        format: 'json',
                        content: formatted,
                        spec: { filename: 'clipboard_data.json' },
                    });
                    return result.success ? { success: true, message: `Saved to ${result.path}` } : { success: false, message: result.reason || 'Failed' };
                }
                if (clipInfo.type === 'emails') {
                    const emails = clipInfo.text.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
                    const result = await (window as any).electron.generateFile({
                        format: 'csv',
                        content: 'Email\n' + emails.join('\n'),
                        spec: { filename: 'emails.csv' },
                    });
                    return result.success ? { success: true, message: `Saved ${emails.length} emails to ${result.path}` } : { success: false, message: result.reason || 'Failed' };
                }
                if (clipInfo.type === 'urls') {
                    const urls = clipInfo.text.match(/https?:\/\/[\S]+/g) || [];
                    const result = await (window as any).electron.generateFile({
                        format: 'txt',
                        content: urls.join('\n'),
                        spec: { filename: 'urls.txt' },
                    });
                    return result.success ? { success: true, message: `Saved ${urls.length} URLs to ${result.path}` } : { success: false, message: result.reason || 'Failed' };
                }
                if (clipInfo.type === 'code') {
                    const result = await (window as any).electron.generateFile({
                        format: 'txt',
                        content: clipInfo.text,
                        spec: { filename: 'clipboard_code.txt' },
                    });
                    return result.success ? { success: true, message: `Saved to ${result.path}` } : { success: false, message: result.reason || 'Failed' };
                }
            }

            if (action === 'format' || action === 'copy') {
                let formatted = clipInfo.text;
                if (clipInfo.type === 'json') {
                    try { formatted = JSON.stringify(JSON.parse(clipInfo.text), null, 2); } catch { /* keep original */ }
                }
                (window as any).electron.copyToClipboard({ text: formatted, html: '' });
                return { success: true, message: 'Formatted and copied to clipboard' };
            }

            return { success: false, message: 'Unknown action' };
        } catch (err: any) {
            return { success: false, message: err.message };
        }
    }, []);

    // ── Feature 4: Ambient Awareness ────────────────────────────────────
    const [ambientNotices, setAmbientNotices] = useState<AmbientNotice[]>([]);
    const fileTracker = useRef<Map<string, { firstSeen: number; lastTitle: string }>>(new Map());
    const clipboardCounter = useRef(0);
    const lastClipboardText = useRef('');
    const dismissedNoticeIds = useRef<Set<string>>(new Set());

    const updateAmbientAwareness = useCallback((discoveredFiles?: any[], browserTabs?: any[]) => {
        if (!isAgentMode) return;
        const notices: AmbientNotice[] = [];
        const now = Date.now();

        // Track open files
        if (discoveredFiles) {
            for (const f of discoveredFiles) {
                const existing = fileTracker.current.get(f.id);
                if (!existing) {
                    fileTracker.current.set(f.id, { firstSeen: now, lastTitle: f.name });
                } else {
                    const ageMinutes = (now - existing.firstSeen) / 60000;
                    if (ageMinutes > 60 && f.type !== 'web') {
                        const id = `stale-file-${f.id}`;
                        if (!dismissedNoticeIds.current.has(id)) {
                            notices.push({
                                id,
                                icon: '📄',
                                message: `${f.name} open for ${Math.round(ageMinutes / 60)}h`,
                            });
                        }
                    }
                }
            }

            // Count stale browser tabs (open > 2 hours)
            const staleTabs = discoveredFiles.filter(f => {
                if (f.type !== 'web') return false;
                const existing = fileTracker.current.get(f.id);
                if (!existing) return false;
                return (now - existing.firstSeen) / 60000 > 120;
            });
            if (staleTabs.length >= 3) {
                const id = 'stale-tabs';
                if (!dismissedNoticeIds.current.has(id)) {
                    notices.push({
                        id,
                        icon: '🌐',
                        message: `${staleTabs.length} browser tabs open 2h+`,
                    });
                }
            }
        }

        // Clipboard counter
        if (clipboardCounter.current >= 5) {
            const id = 'clipboard-count';
            if (!dismissedNoticeIds.current.has(id)) {
                notices.push({
                    id,
                    icon: '📋',
                    message: `You copied ${clipboardCounter.current} items today`,
                });
            }
        }

        // Only show if 3+ notices (per user preference)
        if (notices.length >= 3) {
            setAmbientNotices(notices);
        } else {
            setAmbientNotices([]);
        }
    }, [isAgentMode]);

    const dismissAmbientNotice = useCallback((id: string) => {
        dismissedNoticeIds.current.add(id);
        setAmbientNotices(prev => prev.filter(n => n.id !== id));
    }, []);

    // Track clipboard changes for counter
    const trackClipboardChange = useCallback((text: string) => {
        if (text && text !== lastClipboardText.current) {
            lastClipboardText.current = text;
            clipboardCounter.current++;
        }
    }, []);

    // ── Feature 5: Cross-Reference Memory ───────────────────────────────
    const [crossRefNotice, setCrossRefNotice] = useState<string | null>(null);

    const ENTITY_EXTRACTION_PROMPT = `Extract key entities from this content. Return ONLY a JSON array (no markdown, no code fences):
[{"type":"date|amount|name|obligation|deadline|number|term","value":"exact value","context":"surrounding sentence"}]
Focus on: dates, deadlines, monetary amounts, party names, obligations, key terms. Max 20 entities.`;

    const saveDocumentMemory = useCallback(async (docName: string, content: string) => {
        if (!isAgentMode || !content || content.length < 100) return;

        try {
            const { callGeminiFlash } = await import('../api/gemini');
            const response = await callGeminiFlash(ENTITY_EXTRACTION_PROMPT, content.substring(0, 3000), { maxOutputTokens: 800 });
            const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const entities: ExtractedEntity[] = JSON.parse(cleaned);

            const hash = simpleHash(content.substring(0, 1000));
            const memory: DocumentMemory = { docName, entities, analyzedAt: Date.now(), hash };

            // Load existing memories
            const existing: DocumentMemory[] = JSON.parse(localStorage.getItem('document_memory') || '[]');

            // Check for existing entry with same name
            const idx = existing.findIndex(m => m.docName === docName);
            if (idx >= 0) {
                existing[idx] = memory;
            } else {
                existing.push(memory);
                if (existing.length > 50) existing.shift(); // FIFO eviction
            }

            localStorage.setItem('document_memory', JSON.stringify(existing));
        } catch (err) {
            console.error('[Agent] Entity extraction failed:', err);
        }
    }, [isAgentMode]);

    const checkCrossReferences = useCallback((docName: string, content: string) => {
        if (!isAgentMode) return;

        try {
            const memories: DocumentMemory[] = JSON.parse(localStorage.getItem('document_memory') || '[]');
            const currentHash = simpleHash(content.substring(0, 1000));

            // Find similar documents (fuzzy name match)
            const baseName = docName.replace(/[-_]?v?\d+/gi, '').replace(/\.\w+$/, '').toLowerCase().trim();
            const matches = memories.filter(m => {
                if (m.docName === docName && m.hash === currentHash) return false; // Same exact version
                const mBase = m.docName.replace(/[-_]?v?\d+/gi, '').replace(/\.\w+$/, '').toLowerCase().trim();
                return mBase === baseName || levenshteinSimilarity(mBase, baseName) > 0.7;
            });

            if (matches.length === 0) return;

            // Compare entities
            const diffs: string[] = [];
            for (const match of matches) {
                for (const oldEntity of match.entities) {
                    // Look for same-type entities with different values
                    if (oldEntity.type === 'date' || oldEntity.type === 'deadline' || oldEntity.type === 'amount') {
                        const matchingContext = content.toLowerCase().includes(oldEntity.context.substring(0, 30).toLowerCase());
                        if (!matchingContext && content.includes(oldEntity.type === 'amount' ? '$' : '/')) {
                            // Entity context not found in new doc — might have changed
                            continue;
                        }
                        // Check if value appears in current content
                        if (!content.includes(oldEntity.value)) {
                            diffs.push(`${oldEntity.type}: "${oldEntity.value}" (from ${match.docName}) not found in current document`);
                        }
                    }
                }
            }

            if (diffs.length > 0) {
                setCrossRefNotice(`Compared to ${matches[0].docName}: ${diffs.slice(0, 3).join('; ')}`);
            }
        } catch (err) {
            console.error('[Agent] Cross-reference check failed:', err);
        }
    }, [isAgentMode]);

    const dismissCrossRef = useCallback(() => setCrossRefNotice(null), []);

    // ── Feature 6: Repetition Detector (clipboard + app switch) ─────────
    const [repetitionNotice, setRepetitionNotice] = useState<string | null>(null);
    const appSwitchLog = useRef<{ proc: string; title: string; clipboard: string; time: number }[]>([]);
    const repetitionDismissed = useRef<Set<string>>(new Set());

    const trackAppSwitch = useCallback(async () => {
        if (!isAgentMode) return;

        try {
            const ctx = await (window as any).electron.getActiveWindowContext();
            const clip = await (window as any).electron.readClipboard();
            const now = Date.now();
            const clipText = clip?.text || '';

            // Track clipboard change
            trackClipboardChange(clipText);

            const log = appSwitchLog.current;
            log.push({ proc: ctx.process, title: ctx.title, clipboard: clipText, time: now });

            // Keep last 20 entries, last 3 minutes
            const cutoff = now - 180000;
            appSwitchLog.current = log.filter(e => e.time > cutoff).slice(-20);

            // Detect pattern: copying from app A and pasting in app B
            const recent = appSwitchLog.current;
            if (recent.length < 6) return;

            // Find clipboard changes that coincide with app switches
            const clipChanges: { fromApp: string; toApp: string; time: number }[] = [];
            for (let i = 1; i < recent.length; i++) {
                if (recent[i].clipboard !== recent[i - 1].clipboard && recent[i].proc !== recent[i - 1].proc) {
                    clipChanges.push({
                        fromApp: recent[i - 1].proc,
                        toApp: recent[i].proc,
                        time: recent[i].time,
                    });
                }
            }

            if (clipChanges.length >= 3) {
                // Check if same two apps appear in the pattern
                const pairs = clipChanges.map(c => [c.fromApp, c.toApp].sort().join('↔'));
                const pairCounts = pairs.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {} as Record<string, number>);
                const topPair = Object.entries(pairCounts).sort((a, b) => b[1] - a[1])[0];

                if (topPair && topPair[1] >= 3) {
                    const pairKey = topPair[0];
                    if (!repetitionDismissed.current.has(pairKey)) {
                        const [app1, app2] = pairKey.split('↔');
                        setRepetitionNotice(`You've been copying between ${app1} and ${app2}. Want help automating this?`);
                    }
                }
            }
        } catch { /* ignore tracking errors */ }
    }, [isAgentMode, trackClipboardChange]);

    const dismissRepetition = useCallback(() => {
        // Blacklist the current pair for 30 minutes
        const notice = repetitionNotice;
        if (notice) {
            const match = notice.match(/between (.+) and (.+)\./);
            if (match) {
                const key = [match[1], match[2]].sort().join('↔');
                repetitionDismissed.current.add(key);
                setTimeout(() => repetitionDismissed.current.delete(key), 1800000); // 30 min
            }
        }
        setRepetitionNotice(null);
    }, [repetitionNotice]);

    return {
        // State
        isAgentMode,
        setIsAgentMode,
        pendingIntent,
        isClassifying,
        lastResult,
        history,
        clipboardInfo,
        setClipboardInfo,
        quickActions,
        screenActionPending,
        ambientNotices,
        crossRefNotice,
        repetitionNotice,

        // Actions
        classify,
        execute,
        undo,
        dismiss,
        checkClipboard,
        getScreenActionsForContext,
        clearHistory: () => saveHistory([]),

        // Feature 1: Screen → Data → Destination
        startScreenAction,
        handleScreenActionResponse,

        // Feature 2: Smart Paste
        smartPasteAction,

        // Feature 4: Ambient Awareness
        updateAmbientAwareness,
        dismissAmbientNotice,
        trackAppSwitch,

        // Feature 5: Cross-Reference Memory
        saveDocumentMemory,
        checkCrossReferences,
        dismissCrossRef,

        // Feature 6: Repetition Detector
        dismissRepetition,
    };
}

// ── Utility functions ──────────────────────────────────────────────────

function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(36);
}

function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const matrix: number[][] = [];
    for (let i = 0; i <= a.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= b.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        }
    }
    return 1 - matrix[a.length][b.length] / maxLen;
}
