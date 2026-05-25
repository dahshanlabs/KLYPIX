// Phase 23 Day 4 — Snippet management via the palette.
//
// Type 'snippet:' to enter snippet management. Inputs of the form
// 'snippet:add <trigger>=<body>' create or update a snippet. Plain
// 'snippet:' lists existing snippets so users can delete or copy
// triggers.
//
// Why dual-purpose: snippets are power-user features that don't need
// their own settings tab if the palette already has the mental model
// of typing colon-prefixed commands. Matches how Raycast does dictionary
// and unit-conversion commands.

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Sparkles, Plus, Trash2 } from 'lucide-react';
import React from 'react';
import { listSnippets, upsertSnippet, deleteSnippet } from '../snippets';

const ADD_RE = /^add\s+(\S+)\s*=\s*([\s\S]+)$/i;

export const snippetProvider: PaletteProvider = {
    id: 'snippet',
    prefix: 'snippet:',
    weight: 0.8,

    emptyState(): PaletteResult[] {
        return listSnippets().slice(0, 12).map(toListRow);
    },

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const trimmed = input.trim();

        // 'add <trigger>=<body>' → upsert + show preview
        const m = trimmed.match(ADD_RE);
        if (m) {
            const trigger = m[1];
            const body = m[2];
            return [{
                id: `snippet:preview:${trigger}`,
                title: `Save snippet "${trigger}" → ${body.slice(0, 60)}${body.length > 60 ? '…' : ''}`,
                subtitle: 'Press Enter to save. Then type the trigger anywhere to expand.',
                accent: '#10b981',
                icon: React.createElement(Plus, { size: 14 }),
                primaryAction: {
                    label: 'Save snippet',
                    handler: () => {
                        upsertSnippet({ trigger, name: trigger, body });
                    },
                },
            }];
        }

        // Otherwise: list + filter snippets by query
        const all = listSnippets();
        if (trimmed.length === 0) return all.slice(0, 20).map(toListRow);
        const lc = trimmed.toLowerCase();
        return all
            .filter(s => s.trigger.toLowerCase().includes(lc) || s.body.toLowerCase().includes(lc))
            .slice(0, 20)
            .map(toListRow);
    },
};

function toListRow(s: { id: string; trigger: string; body: string }): PaletteResult {
    return {
        id: `snippet:${s.id}`,
        title: s.trigger,
        subtitle: s.body.slice(0, 120),
        accent: '#a855f7',
        icon: React.createElement(Sparkles, { size: 14 }),
        primaryAction: {
            label: 'Copy body',
            handler: async () => {
                try { await navigator.clipboard.writeText(s.body); } catch { /* swallow */ }
            },
        },
        secondaryActions: [
            {
                label: 'Delete',
                chord: 'Shift+Enter',
                handler: () => { deleteSnippet(s.id); },
            },
        ],
    };
}
