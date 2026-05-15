// Memory extractor — runs at session end, uses Flash to pull facts out of conversation.
// Output goes to the pending_memories table; user approves via MemoryPanel (or auto-saves
// if askBeforeSaving is OFF).

import type { Memory, MemorySettings, MemoryType, PendingMemory } from './types';

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system for a personal AI assistant.
Analyze the conversation below and extract DISTINCT, FACTUAL memories about the user.

Output a JSON array. Each item MUST have:
  "content": string — the factual memory in third person (e.g., "User prefers dark mode")
  "type": "semantic" | "episodic" | "procedural"
  "category": "personal" | "work" | "preferences" | "technical" | "project" | "general"
  "confidence": number between 0.0 and 1.0

CATEGORIES:
- semantic = facts (name, role, company, location, tools used, projects)
- procedural = preferences (how the user likes things done, format/tone/language preferences)
- episodic = what happened (key task outcomes, decisions, problems solved) — use SPARINGLY

NEVER EXTRACT:
- Passwords, API keys, tokens, any secret
- Credit card numbers, bank details, financial info
- Social security numbers, national IDs
- Medical info unless the user explicitly discusses it
- Anything the user said to forget or not remember

RULES:
- Only extract facts you are confident about (>= 0.7 for semantic, >= 0.8 for episodic)
- Don't invent or assume — only what's explicitly stated or clearly implied
- Keep each memory to ONE fact (no compound sentences)
- Don't duplicate existing memories (check the EXISTING list)
- If the conversation is small talk with no learnable facts, return []

Output ONLY the JSON array. No prose, no markdown fences.`;

// Jaccard similarity on word sets — cheap dedup heuristic
function stringSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function parseExtractorOutput(raw: string): PendingMemory[] {
  // Strip markdown fences if Flash ignored the "no fences" instruction
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    const out: PendingMemory[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.content !== 'string' || !item.content.trim()) continue;
      const type = item.type as MemoryType;
      if (type !== 'semantic' && type !== 'episodic' && type !== 'procedural') continue;
      const confidence = typeof item.confidence === 'number' ? item.confidence : 0;
      if (confidence < 0.6) continue;
      out.push({
        content: String(item.content).trim(),
        type,
        category: typeof item.category === 'string' ? item.category : 'general',
        confidence: Math.max(0, Math.min(1, confidence)),
        approved: null,
      });
    }
    return out;
  } catch { return []; }
}

export interface ExtractionInput {
  conversation: Array<{ role: 'user' | 'assistant' | string; content: string }>;
  existingMemories: Memory[];
  settings: MemorySettings;
}

/**
 * Extract new pending memories from a conversation.
 * Returns [] when:
 *   - memory disabled
 *   - autoExtract disabled
 *   - conversation too short (< 3 messages — not enough to learn from)
 *   - user said "don't remember this" mid-conversation
 *   - extraction call fails or yields nothing useful
 *
 * Uses the existing callGeminiFlash helper from src/api/gemini.ts.
 */
export async function extractMemoriesFromConversation(
  input: ExtractionInput,
): Promise<PendingMemory[]> {
  const { conversation, existingMemories, settings } = input;

  if (!settings.enabled) return [];
  if (!settings.autoExtract) return [];

  // "Enough to learn from" = either 3+ messages, OR at least one message >= 40 chars of substance.
  // Agent mode hits this branch (single user prompt + one long response) and should still extract.
  const totalChars = conversation.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const hasSubstance = conversation.length >= 3 || totalChars >= 60;
  if (!hasSubstance) return [];

  // Skip if user said "don't remember" during conversation
  const dontRememberPattern = /\b(don'?t|do not|please (?:don'?t|do not))\s+(?:remember|save|store|keep)\b/i;
  if (conversation.some(m => m.role === 'user' && dontRememberPattern.test(m.content))) {
    return [];
  }

  // Build extraction input
  const conversationText = conversation
    .slice(-30) // cap to last 30 messages — extractor doesn't need a novel
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(m.content).substring(0, 1200)}`)
    .join('\n');

  const existingFacts = existingMemories.length > 0
    ? existingMemories.map(m => `- ${m.content}`).join('\n')
    : '(none)';

  const userContent = `EXISTING MEMORIES (do not re-extract these):\n${existingFacts}\n\nCONVERSATION TO ANALYZE:\n${conversationText}`;

  // Call Flash via the existing helper. Dynamic import to keep this module independent.
  let rawResponse: string;
  try {
    const { callGeminiFlash } = await import('../../api/gemini');
    rawResponse = await callGeminiFlash(EXTRACTION_SYSTEM_PROMPT, userContent, {
      maxOutputTokens: 1200,
      temperature: 0.1,
    });
  } catch (err) {
    console.warn('[MemoryExtractor] Flash call failed:', err);
    return [];
  }

  let extracted = parseExtractorOutput(rawResponse);
  if (extracted.length === 0) return [];

  // Filter out sensitive categories
  extracted = extracted.filter(p => {
    const lc = p.content.toLowerCase();
    return !settings.neverRemember.some(s => lc.includes(s.toLowerCase()));
  });

  // Dedup against existing memories (Jaccard > 0.8)
  extracted = extracted.filter(p => {
    return !existingMemories.some(existing => stringSimilarity(existing.content, p.content) > 0.8);
  });

  // Dedup within the extracted batch itself
  const seen: PendingMemory[] = [];
  for (const p of extracted) {
    if (!seen.some(s => stringSimilarity(s.content, p.content) > 0.8)) {
      seen.push(p);
    }
  }

  return seen;
}
