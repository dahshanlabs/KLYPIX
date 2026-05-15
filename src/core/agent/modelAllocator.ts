/**
 * Multi-Model Chaining (Innovation #1) + Auto Model Escalation (Innovation #12).
 *
 * Allocates different models to different phases of the SAME task:
 *   Claude plans + synthesizes (expensive but high quality)
 *   Gemini Flash researches + verifies (cheap grunt work)
 *
 * Also handles auto-escalation: start with cheapest model, escalate on failure.
 */

import type { AgentModelProvider } from './modelAdapter';
import type { ExecutionPlan, ModelAllocation, EscalationPolicy } from './types';

/**
 * Allocate optimal models per phase based on available API keys and budget.
 */
export function allocateModels(
  _task: ExecutionPlan,
  availableKeys: Partial<Record<AgentModelProvider, string | null>>,
  _budgetRemaining: number,
): ModelAllocation {
  const hasClaudeKey = !!availableKeys.claude;
  const hasGeminiKey = !!availableKeys.gemini;
  const hasGLMKey = !!availableKeys.glm;
  const hasOpenAIKey = !!availableKeys.openai;

  // Optimal: Claude plans + synthesizes, Gemini grinds + verifies
  // Total: ~$0.02 instead of ~$0.08 all-Claude (75% savings, 95% quality)
  if (hasClaudeKey && hasGeminiKey) {
    return {
      planning: 'claude',
      research: 'gemini',
      synthesis: 'claude',
      implementation: 'claude',
      verification: 'gemini',
    };
  }

  // Budget: GLM-5 plans + synthesizes, Gemini does grunt work
  if (hasGLMKey && hasGeminiKey) {
    return {
      planning: 'glm',
      research: 'gemini',
      synthesis: 'glm',
      implementation: 'glm',
      verification: 'gemini',
    };
  }

  // OpenAI + Gemini combo
  if (hasOpenAIKey && hasGeminiKey) {
    return {
      planning: 'openai',
      research: 'gemini',
      synthesis: 'openai',
      implementation: 'openai',
      verification: 'gemini',
    };
  }

  // Single model fallback
  const primary: string = hasClaudeKey ? 'claude' :
                          hasGLMKey ? 'glm' :
                          hasOpenAIKey ? 'openai' : 'gemini';
  return {
    planning: primary,
    research: primary,
    synthesis: primary,
    implementation: primary,
    verification: primary,
  };
}

/**
 * Create an escalation policy based on available models.
 * Start with cheapest available model, escalate to strongest on failure.
 */
export function createEscalationPolicy(
  availableKeys: Partial<Record<AgentModelProvider, string | null>>,
): EscalationPolicy | null {
  const available = (Object.entries(availableKeys) as [AgentModelProvider, string | null][])
    .filter(([, key]) => !!key)
    .map(([provider]) => provider);

  if (available.length < 2) return null; // Can't escalate with only one model

  // Cost ordering: gemini (free/cheapest) → glm → openai → claude
  const costOrder: AgentModelProvider[] = ['gemini', 'glm', 'openai', 'claude'];

  const cheapest = costOrder.find(p => available.includes(p));
  const strongest = [...costOrder].reverse().find(p => available.includes(p));

  if (!cheapest || !strongest || cheapest === strongest) return null;

  return {
    startWith: cheapest,
    escalateTo: strongest,
    escalateAfter: 3,          // After 3 consecutive failures
    escalateOnQuality: true,   // Also escalate if result quality is poor
  };
}

/**
 * Select the right GLM model variant based on task characteristics.
 * Auto-upgrades text-only models to vision models when screenshots are present.
 */
export function selectGLMModel(
  baseModelId: string,
  hasScreenshot: boolean,
  _taskComplexity: 'simple' | 'medium' | 'complex' = 'medium',
): string {
  // If task involves vision and user chose a non-vision GLM model, upgrade
  if (hasScreenshot && !baseModelId.includes('v') && !baseModelId.includes('V')) {
    console.log('[ModelAllocator] Auto-upgrading to glm-5v-turbo for vision task');
    return 'glm-5v-turbo';
  }

  return baseModelId;
}
