/**
 * Model Adapter Interface — abstracts AI provider API calls.
 * The agent loop uses this interface, not provider SDKs directly.
 * Each provider implements: stream messages → get text + tool_use blocks.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete';
  text?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
}

export interface MessageComplete {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  >;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  /**
   * Hidden chain-of-thought from reasoning models (DeepSeek V4-Pro `reasoning_content`,
   * similar to OpenAI o3 reasoning items). The API REQUIRES this to be passed back on
   * subsequent turns or it 400s — the agent must persist this on the assistant message
   * in history and the adapter must echo it on the outgoing message next call.
   */
  reasoningContent?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Cached prompt tokens read on this call (DeepSeek prompt_cache_hit_tokens, Anthropic cache_read_input_tokens). Optional — only providers that report it. */
    cacheHitTokens?: number;
    /** Prompt tokens that missed the cache (DeepSeek prompt_cache_miss_tokens, Anthropic cache_creation_input_tokens). */
    cacheMissTokens?: number;
  };
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: any;
}

export interface ModelAdapter {
  /** Provider name for display */
  readonly provider: string;
  /** Model ID for display */
  readonly modelId: string;

  /**
   * Stream a conversation turn.
   * Returns an object with:
   * - onText callback registration
   * - finalMessage() promise that resolves with the complete response
   */
  stream(opts: {
    system: string;
    messages: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    /** Hint to force tool calling (Gemini: functionCallingConfig ANY, GLM/OpenAI: tool_choice required) */
    forceToolUse?: boolean;
    /** Only include these tools by name (orchestrator filters per step) */
    toolSubset?: string[];
  }): {
    onText: (cb: (delta: string) => void) => void;
    finalMessage: () => Promise<MessageComplete>;
  };
}

// ── Provider registry ──────────────────────────────────────────────────

export type AgentModelProvider = 'claude' | 'gemini' | 'openai' | 'glm' | 'deepseek';

export interface AgentModelConfig {
  provider: AgentModelProvider;
  modelId: string;
  displayName: string;
  apiKey: string;
}

export const AGENT_MODELS: Record<AgentModelProvider, { displayName: string; modelId: string; keyPrefix: string }> = {
  claude: { displayName: 'Claude Sonnet 4', modelId: 'claude-sonnet-4-20250514', keyPrefix: 'sk-ant-' },
  gemini: { displayName: 'Gemini 2.5 Flash', modelId: 'gemini-2.5-flash', keyPrefix: 'AIza' },
  openai: { displayName: 'GPT-4o', modelId: 'gpt-4o', keyPrefix: 'sk-' },
  glm: { displayName: 'GLM-5V-Turbo', modelId: 'glm-5v-turbo', keyPrefix: '' },
  deepseek: { displayName: 'DeepSeek V4-Pro', modelId: 'deepseek-v4-pro', keyPrefix: 'sk-' },
};

// DeepSeek V4 model options for settings UI.
// NOTE: deepseek-chat / deepseek-reasoner are the V3-era IDs and silently route
// to v4-flash on DeepSeek's API — use the explicit v4 IDs to actually target V4-Pro.
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-pro',   name: 'V4-Pro',   desc: 'Reasoning, hard agent steps' },
  { id: 'deepseek-v4-flash', name: 'V4-Flash', desc: 'Fast, cheap, light agent steps' },
];

// GLM model options for settings UI
export const GLM_MODELS = [
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', desc: 'Vision + agent (recommended)' },
  { id: 'glm-5', name: 'GLM-5', desc: 'Most advanced text model' },
  { id: 'glm-4.6', name: 'GLM-4.6', desc: 'Latest generation' },
  { id: 'glm-4.5', name: 'GLM-4.5', desc: 'Newer, smarter' },
  { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash', desc: 'Fast, lightweight' },
  { id: 'glm-4-plus', name: 'GLM-4-Plus', desc: 'Reliable, high concurrency' },
];
