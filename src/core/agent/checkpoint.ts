/**
 * Checkpoint & Resume (Innovation #8).
 *
 * Saves agent state to localStorage after each step. If the app crashes,
 * user closes the window, or the API times out, the agent can resume
 * from the last checkpoint instead of starting over.
 *
 * Checkpoints expire after 1 hour (stale state is worse than fresh start).
 */

import type { CostSummary } from './costTracker';
import type { ExecutionPlan, AgentMemory } from './types';

export interface Checkpoint {
  /** The execution plan with current step statuses */
  planState: ExecutionPlan;
  /** Compressed results from completed steps */
  completedResults: Array<[number, Array<{ tool: string; result: string }>]>;
  /** Agent memory state */
  agentMemory: AgentMemory;
  /** Compressed context summary */
  contextSummary: string;
  /** Cost tracking so far */
  costSoFar: CostSummary;
  /** Number of turns used */
  turnCount: number;
  /** Timestamp of last save */
  timestamp: number;
  /** Original user prompt */
  originalPrompt: string;
  /** Model ID used */
  modelId: string;
}

const STORAGE_KEY = 'klypix:agentCheckpoint';
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export class CheckpointManager {
  /**
   * Save a checkpoint after a step completes.
   */
  save(checkpoint: Checkpoint): void {
    try {
      // Serialize Map-like data
      const serializable = {
        ...checkpoint,
        timestamp: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
      console.log('[Checkpoint] Saved at step', this.getCurrentStepId(checkpoint));
    } catch (err) {
      console.warn('[Checkpoint] Failed to save:', err);
    }
  }

  /**
   * Load a checkpoint if one exists and is not expired.
   */
  load(): Checkpoint | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;

      const checkpoint: Checkpoint = JSON.parse(raw);

      // Expire old checkpoints
      if (Date.now() - checkpoint.timestamp > MAX_AGE_MS) {
        console.log('[Checkpoint] Expired (older than 1 hour)');
        this.clear();
        return null;
      }

      return checkpoint;
    } catch {
      this.clear();
      return null;
    }
  }

  /**
   * Clear the stored checkpoint.
   */
  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Check if there's a resumable checkpoint.
   */
  hasResumable(): boolean {
    return this.load() !== null;
  }

  /**
   * Get a human-readable description of the checkpoint for the resume prompt.
   */
  describe(): string | null {
    const cp = this.load();
    if (!cp) return null;

    const completedSteps = cp.planState.steps.filter(s => s.status === 'completed').length;
    const totalSteps = cp.planState.steps.length;
    const currentStep = cp.planState.steps.find(s => s.status === 'running' || s.status === 'pending');
    const ageMinutes = Math.round((Date.now() - cp.timestamp) / 60000);

    return `Previous task interrupted ${ageMinutes}m ago at Step ${completedSteps + 1}/${totalSteps}` +
           (currentStep ? `: ${currentStep.action}` : '') +
           ` — "${cp.originalPrompt.substring(0, 60)}${cp.originalPrompt.length > 60 ? '...' : ''}"`;
  }

  private getCurrentStepId(cp: Checkpoint): number {
    const running = cp.planState.steps.find(s => s.status === 'running');
    return running?.id || 0;
  }
}

export const checkpointManager = new CheckpointManager();
