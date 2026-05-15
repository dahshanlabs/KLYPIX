/**
 * Tiny pub/sub for the current narration line shown to the user.
 *
 * Set by the narrator (see narrator.ts) when a Gemini Flash narration arrives
 * within the 500ms budget AND its turn tag is still current. Cleared on session
 * start. UI components subscribe via the useNarration hook.
 *
 * Keeping this as a module-level singleton (not React state or context) means
 * the narrator can write from a fire-and-forget Promise outside the React tree
 * with zero coupling to the agent loop or hook lifecycle.
 */

type Listener = (text: string | null) => void;

let current: string | null = null;
const listeners = new Set<Listener>();

export const narrationStore = {
  get(): string | null {
    return current;
  },
  set(text: string | null): void {
    current = text;
    listeners.forEach(l => {
      try { l(text); } catch { /* never let a bad subscriber break the broadcast */ }
    });
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  clear(): void {
    this.set(null);
  },
};
