import { callGeminiFlash } from '../../api/gemini';
import type { FlashEngineConfig } from './types';
import type { RouterMessage } from '../router/types';

// ── Context preparation for Flash ────────────────────────────────────────────
// Flash has a large context window (1M) but performs WORSE with more context.
// Strategy: sliding window with summary + deduplication.

function estimateTokens(messages: RouterMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

// ── Strategy 1: Sliding window with summary ─────────────────────────────────

export async function prepareContext(
  fullHistory: RouterMessage[],
  config: FlashEngineConfig,
): Promise<RouterMessage[]> {
  const verbatimCount = config.keepLastNTurnsVerbatim * 2; // user+assistant pairs

  if (fullHistory.length <= verbatimCount) {
    return fullHistory;
  }

  const oldMessages = fullHistory.slice(0, -verbatimCount);
  const recentMessages = fullHistory.slice(-verbatimCount);

  // Summarize old messages with a cheap Flash call
  try {
    const summaryPrompt = `Summarize this conversation history in 3-5 bullet points.
Focus on: key facts, decisions made, user preferences, and task progress.
Do NOT include greetings or filler.

Conversation:
${oldMessages.map(m => `${m.role}: ${m.content.substring(0, 500)}`).join('\n')}`;

    const summary = await callGeminiFlash(
      'You are a conversation summarizer. Be extremely concise.',
      summaryPrompt,
      { maxOutputTokens: 300, temperature: 0.1 },
    );

    return [
      { role: 'system', content: `CONVERSATION CONTEXT (summarized):\n${summary}` },
      ...recentMessages,
    ];
  } catch {
    // Fallback: just use recent turns
    return recentMessages;
  }
}

// ── Strategy 2: Tool output compression ─────────────────────────────────────

export function compressToolOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;

  let compressed = output;

  compressed = compressed.replace(/\n{3,}/g, '\n\n');
  compressed = compressed.replace(/\s{2,}/g, ' ');
  compressed = compressed.replace(/<[^>]+>/g, '');
  compressed = compressed.replace(/cookie\s*(policy|notice|consent)[^.]*\./gi, '');
  compressed = compressed.replace(/subscribe\s*to\s*(our|the)\s*newsletter[^.]*\./gi, '');
  compressed = compressed.replace(/copyright\s*©[^.]*\./gi, '');
  compressed = compressed.replace(/all rights reserved[^.]*\./gi, '');
  compressed = compressed.replace(/terms\s*(of\s*service|and\s*conditions)[^.]*\./gi, '');
  compressed = compressed.replace(/privacy\s*policy[^.]*\./gi, '');

  if (compressed.length > maxChars) {
    const truncated = compressed.substring(0, maxChars);
    const lastSentence = truncated.lastIndexOf('.');
    if (lastSentence > maxChars * 0.5) {
      compressed = truncated.substring(0, lastSentence + 1) + '\n\n[... content truncated for brevity]';
    } else {
      compressed = truncated + '\n\n[... content truncated]';
    }
  }

  return compressed;
}

// ── Strategy 3: Deduplicate repeated context ─────────────────────────────────

export function deduplicateContext(messages: RouterMessage[]): RouterMessage[] {
  const seen = new Set<string>();
  const deduped: RouterMessage[] = [];

  for (const msg of messages) {
    const fingerprint = `${msg.role}:${msg.content.substring(0, 200)}`;
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      deduped.push(msg);
    }
  }

  return deduped;
}
