import type { ModelAdapter, AgentModelProvider } from '../modelAdapter';
import { createClaudeAdapter } from './claudeAdapter';
import { createGeminiAdapter } from './geminiAdapter';
import { createOpenAIAdapter } from './openaiAdapter';
import { createGLMAdapter } from './glmAdapter';
import { createDeepseekAdapter } from './deepseekAdapter';

export function createAdapter(provider: AgentModelProvider, apiKey: string, modelId?: string): ModelAdapter {
  switch (provider) {
    case 'claude':
      return createClaudeAdapter(apiKey, modelId || 'claude-sonnet-4-20250514');
    case 'gemini':
      return createGeminiAdapter(apiKey, modelId || 'gemini-2.5-flash');
    case 'openai':
      return createOpenAIAdapter(apiKey, modelId || 'gpt-4o');
    case 'glm':
      return createGLMAdapter(apiKey, modelId || 'glm-5v-turbo');
    case 'deepseek':
      return createDeepseekAdapter(apiKey, modelId || 'deepseek-v4-pro');
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export { createClaudeAdapter } from './claudeAdapter';
export { createGeminiAdapter } from './geminiAdapter';
export { createOpenAIAdapter } from './openaiAdapter';
export { createGLMAdapter } from './glmAdapter';
export { createDeepseekAdapter } from './deepseekAdapter';
