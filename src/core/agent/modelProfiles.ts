/**
 * Per-model capability profiles and prompt tuning.
 * This is the KEY to making the orchestration layer model-aware.
 * Each model gets a profile with capability flags, context limits,
 * and custom system prompts that control orchestrator behavior.
 *
 * CORRECTED profiles from Plan Part 12.3:
 * - GLM-5 supportsForceToolUse: true (supports tool_choice: 'required')
 * - GLM-5 reliableToolCalling: true, planningCapability: 'strong' → uses legacy loop
 * - GLM-5V-Turbo same as GLM-5 but with vision + 200K context
 * - GLM-4.x models need orchestration (like Gemini Flash)
 */

export interface ModelProfile {
  provider: string;
  modelId: string;

  // ── Capability flags ──
  /** Can we set tool_choice: 'any'/'required'? */
  supportsForceToolUse: boolean;
  /** Does the API natively support tool result messages (not text approximation)? */
  supportsNativeToolResults: boolean;
  /** Can it process images? */
  supportsVision: boolean;
  /** Does it consistently call tools when asked? */
  reliableToolCalling: boolean;

  // ── Context limits ──
  /** Total context window in tokens */
  maxContextTokens: number;
  /** When to start compressing context (tokens) */
  contextCompressionThreshold: number;

  // ── Orchestration tuning ──
  /** Max tokens per step response (lower = more focused) */
  maxTokensPerStep: number;
  /** How well can this model decompose tasks? */
  planningCapability: 'strong' | 'moderate' | 'weak';
  /** Flash needs "Call read_web_content NOW" */
  needsExplicitStepInstructions: boolean;
  /** "You have completed 3/7 steps" */
  needsProgressReminders: boolean;
  /** How likely is the model to stop early? */
  earlyTerminationRisk: 'low' | 'medium' | 'high';

  // ── System prompt variants ──
  /** System prompt injected during step execution */
  stepSystemPrompt: string;
  /** System prompt injected during planning phase */
  planSystemPrompt: string;
  /** Appended to micro-prompts when tool use is required */
  forceToolSuffix: string;
}

// ── Strong model prompt (Claude, GPT-4o, GLM-5) ──────────────────────

const STRONG_STEP_PROMPT = 'You are KLYPIX agent. Execute the current step. Be concise.';
const STRONG_PLAN_PROMPT = 'Analyze the task and create a step-by-step plan as JSON.';

// ── Weak model prompts (Gemini Flash, GLM-4.x) ──────────────────────

const WEAK_STEP_PROMPT = [
  'You are an AI agent executing ONE specific step of a larger task.',
  'You MUST use the provided tools to complete this step.',
  'Do NOT write a final summary. Do NOT say you are done.',
  'Do NOT skip the tool call. Your ONLY job is to call the right tool.',
  'After the tool call, report the result in 1-2 sentences MAX.',
  '',
  'SANDBOX RULES (if sandbox tools are available):',
  '- For Python/data tasks, prefer sandbox_write_file + sandbox_run_python over run_shell.',
  '- NEVER embed large data inside Python script strings. Write data to a .csv file first, then write a short script that reads from it.',
  '- Keep Python scripts under 50 lines.',
].join('\n');

const WEAK_PLAN_PROMPT = [
  'Create a step-by-step plan as a JSON object.',
  'Each step must specify which tools to use.',
  'Return ONLY the JSON, no explanation.',
].join('\n');

const FORCE_TOOL_SUFFIX = '\n\nIMPORTANT: You MUST call a tool in this response. Do not respond with text only.';

// ── Model Profiles ───────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  // ── Claude ──
  'claude-sonnet-4-20250514': {
    provider: 'claude',
    modelId: 'claude-sonnet-4-20250514',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 200000,
    contextCompressionThreshold: 100000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  'claude-opus-4-1': {
    provider: 'claude',
    modelId: 'claude-opus-4-1',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 200000,
    contextCompressionThreshold: 100000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  'claude-haiku-3-5': {
    provider: 'claude',
    modelId: 'claude-haiku-3-5',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 200000,
    contextCompressionThreshold: 80000,
    maxTokensPerStep: 4096,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  // ── Gemini ──
  'gemini-2.5-flash': {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    supportsForceToolUse: true,       // functionCallingConfig: { mode: 'ANY' }
    supportsNativeToolResults: false,  // Tool results become text (adapter converts to functionResponse now)
    supportsVision: true,
    reliableToolCalling: false,        // Often skips tool calls
    maxContextTokens: 1000000,         // 1M context window
    contextCompressionThreshold: 200000, // Gemini can handle much more — don't compress too early
    maxTokensPerStep: 2048,            // Keep responses short and action-focused
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'high',
    stepSystemPrompt: WEAK_STEP_PROMPT,
    planSystemPrompt: WEAK_PLAN_PROMPT,
    forceToolSuffix: FORCE_TOOL_SUFFIX,
  },

  'gemini-2.5-pro': {
    provider: 'gemini',
    modelId: 'gemini-2.5-pro',
    supportsForceToolUse: true,
    supportsNativeToolResults: false,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 1000000,
    contextCompressionThreshold: 300000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  // ── OpenAI ──
  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    supportsForceToolUse: true,        // tool_choice: 'required'
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 128000,
    contextCompressionThreshold: 60000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  'gpt-4o-mini': {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 128000,
    contextCompressionThreshold: 40000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'medium',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  // ── GLM (Z.ai) — Strong models: use legacy loop ──
  'glm-5': {
    provider: 'glm',
    modelId: 'glm-5',
    supportsForceToolUse: true,          // CORRECTED: GLM-5 supports tool_choice: 'required'
    supportsNativeToolResults: true,
    supportsVision: false,                // GLM-5 base is text-only
    reliableToolCalling: true,            // CORRECTED: GLM-5 744B MoE, built for agentic tasks
    maxContextTokens: 128000,
    contextCompressionThreshold: 60000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',         // CORRECTED: strong reasoning
    needsExplicitStepInstructions: false, // CORRECTED: can self-plan
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',          // CORRECTED: designed for long-horizon tasks
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  'glm-5v-turbo': {
    provider: 'glm',
    modelId: 'glm-5v-turbo',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: true,                 // Native multimodal — images, video, files
    reliableToolCalling: true,
    maxContextTokens: 200000,             // 200K context window
    contextCompressionThreshold: 100000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  // ── GLM (Z.ai) — Weaker models: need orchestration ──
  'glm-4.6': {
    provider: 'glm',
    modelId: 'glm-4.6',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: false,
    reliableToolCalling: false,
    maxContextTokens: 128000,
    contextCompressionThreshold: 80000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'medium',
    stepSystemPrompt: WEAK_STEP_PROMPT,
    planSystemPrompt: WEAK_PLAN_PROMPT,
    forceToolSuffix: FORCE_TOOL_SUFFIX,
  },

  'glm-4.5': {
    provider: 'glm',
    modelId: 'glm-4.5',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: false,
    reliableToolCalling: false,
    maxContextTokens: 128000,
    contextCompressionThreshold: 80000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'high',
    stepSystemPrompt: WEAK_STEP_PROMPT,
    planSystemPrompt: WEAK_PLAN_PROMPT,
    forceToolSuffix: FORCE_TOOL_SUFFIX,
  },

  'glm-4.5-flash': {
    provider: 'glm',
    modelId: 'glm-4.5-flash',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: false,
    reliableToolCalling: false,            // Flash models less reliable
    maxContextTokens: 128000,
    contextCompressionThreshold: 80000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'high',
    stepSystemPrompt: WEAK_STEP_PROMPT,
    planSystemPrompt: WEAK_PLAN_PROMPT,
    forceToolSuffix: FORCE_TOOL_SUFFIX,
  },

  'glm-4-plus': {
    provider: 'glm',
    modelId: 'glm-4-plus',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: false,
    reliableToolCalling: false,
    maxContextTokens: 128000,
    contextCompressionThreshold: 80000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'medium',
    stepSystemPrompt: WEAK_STEP_PROMPT,
    planSystemPrompt: WEAK_PLAN_PROMPT,
    forceToolSuffix: FORCE_TOOL_SUFFIX,
  },

  // ── DeepSeek V4 — Pro is the reasoner (Claude-class), Flash is the cheap fast tier ──
  'deepseek-v4-pro': {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    supportsForceToolUse: false,          // Reasoner ignores tool_choice='required'; let it decide.
    supportsNativeToolResults: true,
    supportsVision: false,
    reliableToolCalling: true,            // V4-Pro: strong agentic reasoning, beats Claude on Terminal-Bench.
    maxContextTokens: 128000,
    contextCompressionThreshold: 64000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },

  'deepseek-v4-flash': {
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: false,
    reliableToolCalling: true,            // V4-Flash: fast/cheap, decent tool calling but code-first bias.
    maxContextTokens: 128000,
    contextCompressionThreshold: 64000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: STRONG_STEP_PROMPT,
    planSystemPrompt: STRONG_PLAN_PROMPT,
    forceToolSuffix: '',
  },
};

/**
 * Get a model's capability profile.
 * Falls back to Gemini Flash profile (needs full orchestration) for unknown models.
 * This is the safe default — better to over-orchestrate than under-orchestrate.
 */
export function getModelProfile(modelId: string): ModelProfile {
  if (MODEL_PROFILES[modelId]) {
    return MODEL_PROFILES[modelId];
  }

  // Try prefix matching for model variants (e.g., claude-sonnet-4-xxx → claude-sonnet-4)
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    if (modelId.startsWith(key) || key.startsWith(modelId)) {
      return profile;
    }
  }

  // Safe default: treat unknown models as needing full orchestration
  return {
    ...MODEL_PROFILES['gemini-2.5-flash'],
    modelId,
    provider: 'unknown',
  };
}
