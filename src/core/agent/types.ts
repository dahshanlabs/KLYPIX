/**
 * Shared types for the KLYPIX Agent Orchestration Engine.
 * Used across orchestrator, planner, validator, contextManager, and modelProfiles.
 */

// ── Execution Plan Types ──────────────────────────────────────────────

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  successCriteria: SuccessCriterion[];
  estimatedTurns: number;
}

export interface PlanStep {
  id: number;
  action: string;
  tools: string[];
  depends: number[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: string;
  retries: number;
  maxRetries: number;
}

export interface SuccessCriterion {
  type: 'file_exists' | 'data_count' | 'data_nonempty' | 'content_contains' | 'custom';
  description: string;
  check: CriterionCheck;
  met: boolean;
}

export interface CriterionCheck {
  tool?: string;
  toolInput?: Record<string, any>;
  expectedPattern?: string;
  minCount?: number;
}

// ── Step Execution Types ──────────────────────────────────────────────

export interface StepResult {
  success: boolean;
  toolResults: Array<{ tool: string; result: string }>;
  summary: string;
  turnsUsed: number;
}

export interface ResultEvaluation {
  success: boolean;
  dataQuality: 'good' | 'partial' | 'empty' | 'error';
  extractedItems: number;
  shouldContinueStep: boolean;
  shouldModifyPlan: boolean;
  planModification?: {
    skipSteps?: number[];
    addSteps?: PlanStep[];
    modifyStep?: { id: number; changes: Partial<PlanStep> };
  };
}

// ── Validation Types ──────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL';

export interface ValidationResult {
  allPassed: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface AdversarialVerdict {
  verdict: Verdict;
  reason: string;
  screenshotBase64?: string;
}

// ── Context & Memory Types ────────────────────────────────────────────

export interface CompressedContext {
  /** Section 1: What the user asked for */
  primaryRequest: string;
  /** Section 2: Key technical details discovered */
  technicalContext: string;
  /** Section 3: Files read/created with paths */
  fileOperations: Array<{ path: string; action: 'read' | 'write' | 'create'; summary: string }>;
  /** Section 4: Errors encountered and how they were resolved */
  errorsAndFixes: Array<{ error: string; resolution: string }>;
  /** Section 5: Decision log (why we chose this approach) */
  decisions: Array<{ decision: string; reason: string }>;
  /** Section 6: Data collected (summaries, not raw content) */
  collectedData: string;
  /** Section 7: Pending tasks (what remains) */
  pendingTasks: string[];
  /** Section 8: Current active work */
  currentWork: string;
  /** Section 9: Suggested next step */
  suggestedNext: string;
}

export interface SynthesizedBrief {
  /** Pre-extracted structured data for creation steps */
  items: Array<{ title: string; source?: string; url?: string; date?: string; summary?: string }>;
  /** Raw text summary for non-structured tasks */
  textSummary: string;
  /** Total items collected */
  totalCount: number;
}

export interface AgentMemory {
  goal: string;
  constraints: string[];
  decisions: Array<{ what: string; why: string; stepId: number }>;
  openQuestions: string[];
  verificationState: {
    tested: string[];
    untested: string[];
    verdicts: Array<{ check: string; verdict: Verdict }>;
  };
}

// ── Turn Budgeting Types ──────────────────────────────────────────────

export interface TurnBudget {
  total: number;
  perStep: Map<number, number>;
  used: number;
  hardCeiling: number;
}

// ── Stall Detection Types ─────────────────────────────────────────────

export interface StallDetection {
  isStalled: boolean;
  reason: 'repeated_tool_calls' | 'consecutive_errors' | 'narrating_not_acting' | 'none';
  recommendation: string;
}

// ── Decision System Types ─────────────────────────────────────────────

export interface Decision {
  choice: string;
  confidence: number;
  reasoning: string;
}

// ── Ambient Context Types ─────────────────────────────────────────────

export interface AmbientContext {
  activeWindow: string;
  screenshot: string | null;
  activeFileContent: string | null;
  openFiles: string[];
  clipboardText: string | null;
}

// ── Progress Checkpoint Types ─────────────────────────────────────────

export interface ProgressCheckpoint {
  stepId: number;
  previewAvailable: boolean;
  previewType: 'file' | 'data_table' | 'screenshot' | 'text';
  previewContent: string;
  completionPercentage: number;
  estimatedRemainingTime: string;
}

// ── Multi-Model Allocation Types ──────────────────────────────────────

export interface ModelAllocation {
  planning: string;
  research: string;
  synthesis: string;
  implementation: string;
  verification: string;
}

export interface EscalationPolicy {
  startWith: string;
  escalateTo: string;
  escalateAfter: number;
  escalateOnQuality: boolean;
}

// ── Session Learning Types ────────────────────────────────────────────

export interface LearnedPattern {
  type: 'blocked_url' | 'preferred_path' | 'tool_failure' | 'user_correction';
  pattern: string;
  confidence: number;
  lastSeen: number;
  count: number;
}

// ── Extended Callbacks (orchestrator additions) ───────────────────────

export interface OrchestratorCallbacks {
  onPlanGenerated: (plan: ExecutionPlan) => void;
  onStepProgress: (stepId: number, status: PlanStep['status']) => void;
  onProgressCheckpoint: (checkpoint: ProgressCheckpoint) => void;
}
