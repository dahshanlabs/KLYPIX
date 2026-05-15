import { callGeminiFlash } from '../../api/gemini';

export type RouteDecision = 'gemini_chat' | 'intent_action' | 'claude_agent';

export interface RouteResult {
  route: RouteDecision;
  reason: string;
  confidence: number;
  intent?: any;
}

/**
 * Routes user prompt to optimal handler.
 * 1. Intent engine first — if confidence >= 0.80, use intent_action
 * 2. If no Claude key, fall back to Gemini chat
 * 3. Use Gemini Flash to classify CHAT vs AGENT (~0.3s, free)
 */
export async function routePrompt(
  prompt: string,
  _windowContext: any,
  hasClaudeKey: boolean,
): Promise<RouteResult> {
  try {
    // Note: Intent engine classification already happens in App.tsx's submit function.
    // By the time routePrompt is called, we know the intent engine either didn't match
    // or the prompt was detected as multi-step. So we skip intent_action here and
    // only decide between gemini_chat and claude_agent.

    // Step 1: No Claude key → Gemini chat
    if (!hasClaudeKey) {
      return { route: 'gemini_chat', reason: 'No Claude API key; using Gemini chat', confidence: 1.0 };
    }

    // Step 2: Local keyword check — fast, no API call
    // If prompt contains strong action signals, route to agent immediately
    const lower = prompt.toLowerCase();
    const agentKeywords = /\b(create folder|make folder|move file|delete file|rename file|copy file|list files|list all|scan desktop|scan folder|organize|clean up|sort files|install|npm |pip |git |python |node |run command|run script|powershell|check version|find all|count how many|move them|put them|place them|into folder|on my desktop|in my documents|on desktop)\b/i;
    if (agentKeywords.test(lower)) {
      console.log('[smartRouter] Local keyword match → AGENT');
      return { route: 'claude_agent', reason: 'Action keywords detected (local match)', confidence: 0.90 };
    }

    // Step 3: Gemini Flash classification (~0.3s, free) — for ambiguous prompts
    const classification = await classifyWithGeminiFlash(prompt);
    console.log('[smartRouter] Gemini classified as:', classification, '| Prompt:', prompt.substring(0, 60));
    if (classification === 'AGENT') {
      return { route: 'claude_agent', reason: 'Multi-step task detected (Gemini classification)', confidence: 0.85 };
    }

    return { route: 'gemini_chat', reason: 'Chat question', confidence: 0.75 };
  } catch (error) {
    console.error('[smartRouter] Error:', error);
    return { route: 'gemini_chat', reason: 'Router error; defaulting to chat', confidence: 0.5 };
  }
}

/**
 * Classify a follow-up turn when Agent mode is on but prior conversation exists.
 *
 * Used to stop referential questions like "what is the llm used?" or "explain that"
 * from spawning a fresh agent loop with no context — those should go through chat,
 * which already has conversation history + on-screen context. Agent mode stays on;
 * we just pick the cheaper handler for this particular turn.
 *
 * Returns `gemini_chat` only when the prompt is clearly a question with no
 * action verbs. Anything imperative or ambiguous falls back to {@link routePrompt}
 * (which itself has a Flash classifier for the truly ambiguous cases).
 */
export async function classifyFollowUp(prompt: string): Promise<RouteResult> {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/);

  // Strong agent signals — let routePrompt handle them (keeps action keywords centralized)
  const startsWithAction = /^(open|save|rename|move|delete|close|create|copy|navigate|launch|start|kill|exit|quit|run|make|build|install|download|scan|organize|sort|clean|fix|update|edit|append|put|place|generate)\b/i.test(lower);
  if (startsWithAction) {
    return routePrompt(prompt, null, true);
  }

  // Clear-question fast path — looks like a question, short enough to be referential
  const endsWithQuestion = lower.endsWith('?');
  const startsWithQuestion = /^(what|why|how|who|where|which|when|is|are|can|could|should|would|do|does|did|explain|tell|describe|define|summarize|compare|recall|remember)\b/i.test(lower);
  const isShortish = words.length <= 15;

  if ((endsWithQuestion || startsWithQuestion) && isShortish) {
    return { route: 'gemini_chat', reason: 'Follow-up question (local heuristic)', confidence: 0.85 };
  }

  // Ambiguous — defer to the Flash classifier
  return routePrompt(prompt, null, true);
}

async function classifyWithGeminiFlash(prompt: string): Promise<string> {
  const systemPrompt = `You are a classifier. Given a user prompt, decide if it requires:
- AGENT: Tasks that need the AI to DO something on the computer — create/move/delete/rename files or folders, run commands, read files and act on them, browse websites and interact, install software, organize files, scan for files, automate any sequence of steps. Even a single file/folder operation counts as AGENT.
- CHAT: Pure knowledge questions, explanations, translations, math, analysis of text, conversation, opinions, summaries of concepts.

Strong AGENT signals: any verb that implies changing the filesystem or running a program — "create", "move", "delete", "rename", "copy", "scan", "find and move", "organize", "put", "place", "make a folder", "run", "install", "open", "download", "fix", "set up", "clean up", "sort", "build", "deploy", "check versions".

If in doubt between CHAT and AGENT, choose AGENT — it's better to offer to act than to refuse.

Respond with only: AGENT or CHAT`;

  try {
    const response = await callGeminiFlash(systemPrompt, prompt, {
      maxOutputTokens: 10,
      temperature: 0.1,
    });
    const text = response.trim().toUpperCase();
    return text === 'AGENT' ? 'AGENT' : 'CHAT';
  } catch (error) {
    console.warn('[classifyWithGeminiFlash] Failed:', error);
    return 'CHAT';
  }
}
