export interface AgentFileInfo {
    path: string;
    name: string;
    format: string;
    size?: number;
}

export interface Message {
    role: 'user' | 'assistant';
    content: string;
    attachedImage?: string;
    attachedFile?: { name: string; content: string };
    attachedFiles?: string[];
    sourceMode?: 'chat' | 'full-screenshot' | 'partial-screenshot' | 'deep-file' | 'agent';
    agentFiles?: AgentFileInfo[];
}

export interface PinnedChat {
    id: string;
    timestamp: number;
    previewText: string;
    messages: Message[];
}

export interface DiscoveredFile {
    id: string;
    name: string;
    originalTitle: string;
    source: string;
    type?: 'file' | 'web';
    url?: string;
    localPath?: string;
    status?: 'linked' | 'web-only' | 'title-only';
}

export interface AttachedFile {
    path: string;
    name: string;
    size: number;
    ext: string;
}

export interface WindowContext {
    title: string;
    process: string;
}

export type SuggestionType = 'chat' | 'document' | 'clipboard' | 'analysis' | 'docgen' | 'action';

export interface Suggestion {
    label: string;
    prompt: string;
    type: SuggestionType;
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
export const MAX_ATTACHED = 5;
