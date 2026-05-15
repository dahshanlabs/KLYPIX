import type { AgentStep } from './claudeAgent';
import type { CostSummary } from './costTracker';
import type { ExecutionPlan, PlanStep, AgentMemory } from './types';

export interface AgentSession {
  id: string;
  prompt: string;
  steps: AgentStep[];
  finalResponse: string;
  cost?: CostSummary;
  status: 'running' | 'completed' | 'error' | 'aborted';
  startTime: number;
  endTime?: number;
}

export class AgentSessionManager {
  private current: AgentSession | null = null;
  private currentPlan: ExecutionPlan | null = null;
  private currentMemory: AgentMemory | null = null;
  private sessionContextCallbacks: {
    onFileAnalyzed?: (path: string) => void;
    onDocGenerated?: (format: string) => void;
    onScreenAnalyzed?: (desc: string) => void;
  } = {};

  setSessionContextCallbacks(cbs: {
    onFileAnalyzed?: (path: string) => void;
    onDocGenerated?: (format: string) => void;
    onScreenAnalyzed?: (desc: string) => void;
  }): void {
    this.sessionContextCallbacks = cbs;
  }

  start(prompt: string): AgentSession {
    this.currentPlan = null;
    this.currentMemory = null;
    this.current = {
      id: `agent_${Date.now()}`,
      prompt,
      steps: [],
      finalResponse: '',
      status: 'running',
      startTime: Date.now(),
    };
    return this.current;
  }

  addStep(step: AgentStep): void {
    if (!this.current) return;
    this.current.steps.push(step);

    if (step.type === 'tool_result' && step.status === 'completed') {
      if (step.toolName === 'read_file' || step.toolName === 'read_active_file') {
        this.sessionContextCallbacks.onFileAnalyzed?.(step.toolInput?.file_path || 'active file');
      }
      if (step.toolName === 'generate_document') {
        this.sessionContextCallbacks.onDocGenerated?.(step.toolInput?.format || 'unknown');
      }
      if (step.toolName === 'capture_screenshot') {
        this.sessionContextCallbacks.onScreenAnalyzed?.('Agent captured screenshot');
      }
    }
  }

  complete(finalResponse: string, cost?: CostSummary, status: 'completed' | 'error' | 'aborted' = 'completed'): void {
    if (!this.current) return;
    this.current.finalResponse = finalResponse;
    this.current.cost = cost;
    this.current.status = status;
    this.current.endTime = Date.now();
    this.saveToHistory(this.current);
    this.current = null;
  }

  /** Store the current execution plan (from orchestrator) */
  setPlan(plan: ExecutionPlan): void {
    this.currentPlan = plan;
  }

  /** Update a step's status in the stored plan */
  updateStepStatus(stepId: number, status: PlanStep['status']): void {
    if (!this.currentPlan) return;
    const step = this.currentPlan.steps.find(s => s.id === stepId);
    if (step) step.status = status;
  }

  /** Store the agent memory state */
  setMemory(memory: AgentMemory): void {
    this.currentMemory = memory;
  }

  /** Get the current plan */
  getPlan(): ExecutionPlan | null { return this.currentPlan; }

  /** Get the current memory */
  getMemory(): AgentMemory | null { return this.currentMemory; }

  getCurrent(): AgentSession | null { return this.current; }

  getHistory(): AgentSession[] {
    try {
      return JSON.parse(localStorage.getItem('klypix:agentHistory') || '[]');
    } catch { return []; }
  }

  private saveToHistory(session: AgentSession): void {
    const history = this.getHistory();
    history.unshift(session);
    if (history.length > 50) history.length = 50;
    try {
      localStorage.setItem('klypix:agentHistory', JSON.stringify(history));
    } catch (e) {
      console.warn('[AgentSessionManager] Failed to persist:', e);
    }
  }
}

export const agentSessionManager = new AgentSessionManager();
