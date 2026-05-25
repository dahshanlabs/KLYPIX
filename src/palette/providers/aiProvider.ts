// Phase 23 Day 5 — AI provider (`?` prefix).
//
// Typing '?<question>' surfaces a single row that, when invoked, sends
// the question to the user's agent with current canvas/chat context
// auto-injected. The row appears immediately; pressing Enter dispatches
// a CustomEvent the agent harness in App.tsx listens for to kick off
// a run.
//
// We don't stream the answer inline in v1 — the agent run UI already has
// its own surface with progress, tool calls, and cost tracking. Inline
// streaming inside a 60vh palette would be cramped and would duplicate
// the agent panel UX. v2 could add a "preview answer" inline row that
// truncates after N lines and routes to the full agent on Enter.

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Sparkles } from 'lucide-react';
import React from 'react';

export const aiProvider: PaletteProvider = {
    id: 'ai',
    prefix: '?',
    weight: 0.9,

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const q = input.trim();
        if (q.length === 0) return [];
        return [{
            id: `ai:ask:${q.slice(0, 80)}`,
            title: `Ask agent: "${q}"`,
            subtitle: 'Uses your current canvas selection / visible chat as context',
            accent: '#10b981',
            icon: React.createElement(Sparkles, { size: 14 }),
            score: 0,
            primaryAction: {
                label: 'Ask',
                handler: () => {
                    window.dispatchEvent(new CustomEvent('klypix:palette-ask-agent', {
                        detail: { question: q },
                    }));
                },
            },
        }];
    },
};
