// Memory system types — opt-in persistent memory for KLYPIX agent.
// Data stored locally in %APPDATA%/klypix/memory.db via sql.js.

export type MemoryType = 'semantic' | 'episodic' | 'procedural';
export type MemorySource = 'extracted' | 'user_added' | 'user_edited';

export interface Memory {
  id: string;                           // UUID
  type: MemoryType;
  content: string;
  category: string;                     // "personal" | "work" | "preferences" | "technical" | "project" | "general"
  confidence: number;                   // 0-1
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
  sessionId: string | null;
  pinned: boolean;
  archived: boolean;
}

export interface MemorySettings {
  enabled: boolean;                     // master toggle — OFF by default
  consentShown: boolean;                // true after user has seen the consent dialog once
  rememberFacts: boolean;               // semantic
  rememberSessions: boolean;            // episodic
  rememberWorkflows: boolean;           // procedural
  autoExtract: boolean;
  askBeforeSaving: boolean;             // true = show pending in panel; false = auto-save
  extractionModel: 'flash' | 'claude';
  neverRemember: string[];
  autoDeleteAfterDays: number | null;
  maxMemoriesPerSession: number;
  prioritizePinned: boolean;
  prioritizeRecent: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: false,
  consentShown: false,
  rememberFacts: true,
  rememberSessions: true,
  rememberWorkflows: true,
  autoExtract: true,
  askBeforeSaving: false,               // default OFF per user spec — simplest UX is no UX
  extractionModel: 'flash',
  neverRemember: ['password', 'credit card', 'social security', 'bank account', 'api key', 'token'],
  autoDeleteAfterDays: null,
  maxMemoriesPerSession: 20,
  prioritizePinned: true,
  prioritizeRecent: true,
};

export interface PendingMemory {
  content: string;
  type: MemoryType;
  category: string;
  confidence: number;
  approved: boolean | null;             // null = pending user decision
}

export interface MemoryExport {
  version: string;
  exportedAt: string;
  memoryCount: number;
  memories: Memory[];
  settings: MemorySettings;
}

export interface MemoryStats {
  total: number;
  semantic: number;
  episodic: number;
  procedural: number;
  pinned: number;
}
