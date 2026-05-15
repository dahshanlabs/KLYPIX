import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

// ── Session Context Bus ──────────────────────────────────────────────────
// Shared in-memory context that all modes read/write to.
// Survives mode switches. Clears on chat clear or app restart.

export interface AnalyzedFile {
    name: string;
    summary: string;
    type: string; // 'pdf' | 'docx' | 'xlsx' | 'web' | etc.
}

export interface ScreenAnalysis {
    seeing: string;
    keyData: Array<{ label: string; value: string }>;
    timestamp: number;
}

export interface GeneratedDoc {
    filename: string;
    format: string;
    prompt: string;
    timestamp: number;
}

export type SourceMode = 'chat' | 'full-screenshot' | 'partial-screenshot' | 'deep-file';

// Forward-compat stub for the Canvas .any document. Real shape lands in Slice 3
// (see docs/CLAUDE-KLYPIX-CANVAS.md §10 CanvasDocument). Kept loose here so
// session bus can hold a reference across mode switches without coupling to
// the canvas module yet.
export interface CanvasDocStub {
    version?: string;
    title?: string;
    filePath?: string | null;
    [key: string]: unknown;
}

export interface SessionContextData {
    analyzedFiles: AnalyzedFile[];
    screenAnalyses: ScreenAnalysis[]; // capped at 5
    activeApp: { title: string; process: string } | null;
    generatedDocs: GeneratedDoc[];
    lastSourceMode: SourceMode;
    canvasDoc: CanvasDocStub | null;
}

interface SessionContextValue {
    data: SessionContextData;
    addAnalyzedFile: (file: AnalyzedFile) => void;
    addScreenAnalysis: (analysis: ScreenAnalysis) => void;
    addGeneratedDoc: (doc: GeneratedDoc) => void;
    setActiveApp: (app: { title: string; process: string } | null) => void;
    setLastSourceMode: (mode: SourceMode) => void;
    setCanvasDoc: (doc: CanvasDocStub | null) => void;
    clear: () => void;
    // Get a formatted summary for prompt injection
    getContextSummary: () => string;
}

const INITIAL_DATA: SessionContextData = {
    analyzedFiles: [],
    screenAnalyses: [],
    activeApp: null,
    generatedDocs: [],
    lastSourceMode: 'chat',
    canvasDoc: null,
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionContextProvider({ children }: { children: React.ReactNode }) {
    const [data, setData] = useState<SessionContextData>({ ...INITIAL_DATA });
    const dataRef = useRef(data);
    dataRef.current = data;

    const addAnalyzedFile = useCallback((file: AnalyzedFile) => {
        setData(prev => ({
            ...prev,
            analyzedFiles: [...prev.analyzedFiles, file],
            lastSourceMode: 'deep-file',
        }));
    }, []);

    const addScreenAnalysis = useCallback((analysis: ScreenAnalysis) => {
        setData(prev => ({
            ...prev,
            screenAnalyses: [...prev.screenAnalyses, analysis].slice(-5), // cap at 5
            lastSourceMode: prev.lastSourceMode.includes('screenshot') ? prev.lastSourceMode : 'full-screenshot',
        }));
    }, []);

    const addGeneratedDoc = useCallback((doc: GeneratedDoc) => {
        setData(prev => ({
            ...prev,
            generatedDocs: [...prev.generatedDocs, doc],
        }));
    }, []);

    const setActiveApp = useCallback((app: { title: string; process: string } | null) => {
        setData(prev => ({ ...prev, activeApp: app }));
    }, []);

    const setLastSourceMode = useCallback((mode: SourceMode) => {
        setData(prev => ({ ...prev, lastSourceMode: mode }));
    }, []);

    const setCanvasDoc = useCallback((doc: CanvasDocStub | null) => {
        setData(prev => ({ ...prev, canvasDoc: doc }));
    }, []);

    const clear = useCallback(() => {
        setData({ ...INITIAL_DATA });
    }, []);

    const getContextSummary = useCallback((currentMode?: 'chat' | 'full-screenshot' | 'partial-screenshot' | 'deep-file'): string => {
        const d = dataRef.current;
        const parts: string[] = [];

        // Only inject file context when in deep-file mode or chat (follow-up)
        // Do NOT inject file context when user is asking about a screenshot
        if (d.analyzedFiles.length > 0 && currentMode !== 'full-screenshot' && currentMode !== 'partial-screenshot') {
            parts.push(`[Session Files — from earlier analysis] ${d.analyzedFiles.map(f => `${f.name} (${f.type}): ${f.summary}`).join('; ')}`);
        }

        // Only inject screen context when in screenshot mode or chat (follow-up)
        if (d.screenAnalyses.length > 0 && currentMode !== 'deep-file') {
            const latest = d.screenAnalyses[d.screenAnalyses.length - 1];
            parts.push(`[Recent Screen] ${latest.seeing}${latest.keyData.length > 0 ? ' | ' + latest.keyData.map(k => `${k.label}: ${k.value}`).join(', ') : ''}`);
        }

        if (d.generatedDocs.length > 0) {
            const recent = d.generatedDocs.slice(-3);
            parts.push(`[Generated Docs] ${recent.map(g => `${g.filename} (${g.format})`).join(', ')}`);
        }

        if (d.activeApp) {
            parts.push(`[Active App] ${d.activeApp.title} (${d.activeApp.process})`);
        }

        return parts.length > 0 ? '\n\n--- Session Context (background, lower priority than current query/image) ---\n' + parts.join('\n') + '\n--- End Context ---' : '';
    }, []);

    return React.createElement(SessionContext.Provider, {
        value: { data, addAnalyzedFile, addScreenAnalysis, addGeneratedDoc, setActiveApp, setLastSourceMode, setCanvasDoc, clear, getContextSummary },
    }, children);
}

export function useSessionContext(): SessionContextValue {
    const ctx = useContext(SessionContext);
    if (!ctx) throw new Error('useSessionContext must be used within SessionContextProvider');
    return ctx;
}
