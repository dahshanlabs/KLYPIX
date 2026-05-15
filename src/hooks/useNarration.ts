import { useState, useEffect } from 'react';
import { narrationStore } from '../core/agent/narrationStore';

/**
 * Subscribe to the current narration line. Returns the latest text or null.
 *
 * The store is a module-level singleton fed by the narrator (fire-and-forget
 * Gemini Flash calls between agent turns). This hook just mirrors it into
 * React state so any component can render it.
 */
export function useNarration(): string | null {
  const [text, setText] = useState<string | null>(narrationStore.get());
  useEffect(() => narrationStore.subscribe(setText), []);
  return text;
}
