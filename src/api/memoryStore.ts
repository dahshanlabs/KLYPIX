import { getLocalRationale } from "./localRationale";

export interface MemoryEvent {
    timestamp: number;
    app: string;
    title: string;
    query: string;
    responsePreview: string;
    type?: 'chat' | 'docgen' | 'file-analysis' | 'screenshot-analysis' | 'action';
}

export interface StructuredPersona {
    role: string;
    domain: string;
    primaryTools: string[];
    language: string;
    focus: string;
    patterns: string[]; // max 5 observed behaviors
}

const MEMORY_KEY = 'alt_space_memory_v1';
const PERSONA_KEY = 'alt_space_persona_v1';
const PERSONA_V2_KEY = 'klypix_persona_v2';
const MAX_MEMORY_EVENTS = 20;

/**
 * Saves a new interaction to the local memory buffer.
 * Keeps only the last 20 events to maintain performance and privacy.
 */
export const saveMemoryEvent = (event: MemoryEvent) => {
    try {
        const existing = getMemoryHistory();
        // Add new event to the front and trim the list
        const updated = [event, ...existing].slice(0, MAX_MEMORY_EVENTS);
        localStorage.setItem(MEMORY_KEY, JSON.stringify(updated));
    } catch (e) {
        console.error("Failed to save memory event", e);
    }
};

/**
 * Retrieves the recent interaction history from local storage.
 */
export const getMemoryHistory = (): MemoryEvent[] => {
    try {
        const saved = localStorage.getItem(MEMORY_KEY);
        if (!saved) return [];
        
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error("Failed to load memory history", e);
        return [];
    }
};

/**
 * Summarizes the memory into a concise string for AI context injection.
 */
export const getMemorySummary = (isPrivacyMode: boolean = false): string => {
    const history = getMemoryHistory();
    if (history.length === 0) return "No recent history.";

    return history.map(h => {
        let app = h.app;
        let query = h.query;
        if (isPrivacyMode) {
            app = getLocalRationale(h.app, h.title);
            // Optional: Mask query if it looks like a file path or has sensitive keywords
            // For now, just keep it but titles are already masked in the main context
        }
        return `[${new Date(h.timestamp).toLocaleTimeString()}] In ${app}: "${query}"`;
    }).join("\n");
};

export const clearMemory = () => {
    localStorage.removeItem(MEMORY_KEY);
    localStorage.removeItem(PERSONA_KEY);
};

/**
 * Saves the synthesized AI assessment of the user's role and preferences.
 */
export const savePersona = (persona: string) => {
    localStorage.setItem(PERSONA_KEY, persona);
};

/**
 * Retrieves the persistent User Profile (v1 string fallback).
 */
export const getPersona = (): string => {
    // Try structured persona first, format as string for backward compat
    const v2 = getStructuredPersona();
    if (v2) {
        const parts = [`${v2.role} | ${v2.domain}`];
        if (v2.primaryTools.length > 0) parts.push(`Tools: ${v2.primaryTools.join(', ')}`);
        if (v2.language) parts.push(`Lang: ${v2.language}`);
        if (v2.focus) parts.push(`Focus: ${v2.focus}`);
        if (v2.patterns.length > 0) parts.push(`Patterns: ${v2.patterns.join('; ')}`);
        return parts.join(' | ');
    }
    return localStorage.getItem(PERSONA_KEY) || "Helpful User";
};

/**
 * Saves structured persona (v2).
 */
export const saveStructuredPersona = (persona: StructuredPersona) => {
    try {
        localStorage.setItem(PERSONA_V2_KEY, JSON.stringify(persona));
    } catch (e) {
        console.error('Failed to save structured persona', e);
    }
};

/**
 * Retrieves structured persona (v2), or null if not set.
 */
export const getStructuredPersona = (): StructuredPersona | null => {
    try {
        const saved = localStorage.getItem(PERSONA_V2_KEY);
        if (!saved) return null;
        const parsed = JSON.parse(saved);
        if (parsed && parsed.role && parsed.domain) return parsed as StructuredPersona;
        return null;
    } catch {
        return null;
    }
};

/**
 * Returns the entire memory state for export.
 */
export const exportMemoryData = () => {
    return {
        exportDate: new Date().toISOString(),
        persona: getPersona(),
        history: getMemoryHistory()
    };
};
