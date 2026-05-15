import { callGeminiFlash } from '../../api/gemini';
import type { RouterConfig, RouterMessage } from './types';

// ── Token estimation (rough: 1 token ≈ 4 chars) ─────────────────────────────

function estimateTokens(messages: RouterMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

// ── Context management for Flash ─────────────────────────────────────────────
// Flash performs WORSE with more context. Keep it tight and relevant.

export async function manageContext(
  conversationHistory: RouterMessage[],
  config: RouterConfig,
): Promise<RouterMessage[]> {
  const tokenCount = estimateTokens(conversationHistory);

  // If under 70% of limit, return as-is
  if (tokenCount < config.maxFlashContextTokens * 0.7) {
    return conversationHistory;
  }

  const verbatimCount = config.summarizeAfterTurns * 2; // user+assistant pairs
  const recentTurns = conversationHistory.slice(-verbatimCount);
  const oldTurns = conversationHistory.slice(0, -verbatimCount);

  if (oldTurns.length === 0) return conversationHistory;

  // Summarize old context with a cheap Flash call
  try {
    const summary = await callGeminiFlash(
      'Summarize the following conversation history in 2-3 sentences, preserving key facts, decisions, and user preferences. Be concise.',
      oldTurns.map(m => `${m.role}: ${m.content.substring(0, 500)}`).join('\n'),
      { maxOutputTokens: 300, temperature: 0.1 },
    );

    return [
      { role: 'system', content: `Previous conversation summary: ${summary}` },
      ...recentTurns,
    ];
  } catch (err) {
    console.warn('[HybridRouter] Context summarization failed, truncating instead:', err);
    // Fallback: just use recent turns
    return recentTurns;
  }
}

// ── Tool output compression (rule-based, no LLM call) ───────────────────────

export function compressToolOutput(output: string, maxChars: number = 2000): string {
  if (output.length <= maxChars) return output;

  let compressed = output;

  // Remove excessive whitespace
  compressed = compressed.replace(/\n{3,}/g, '\n\n');
  compressed = compressed.replace(/\s{2,}/g, ' ');

  // Remove HTML tags if present
  compressed = compressed.replace(/<[^>]+>/g, '');

  // Remove common boilerplate
  compressed = compressed.replace(/cookie\s*(policy|notice|consent)[^.]*\./gi, '');
  compressed = compressed.replace(/subscribe\s*to\s*(our|the)\s*newsletter[^.]*\./gi, '');
  compressed = compressed.replace(/copyright\s*©[^.]*\./gi, '');
  compressed = compressed.replace(/all rights reserved[^.]*\./gi, '');

  // Truncate at sentence boundary if still too long
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
