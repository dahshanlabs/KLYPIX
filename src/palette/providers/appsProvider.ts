// Phase 23 Day 4 — Apps provider (Windows Start menu).
//
// Lazy: the Apps list only loads when the user types something the apps
// provider can match against (query length >= 1). emptyState returns
// nothing — we don't want a wall of "Notepad / Calculator / Edge" in
// the empty palette; that's noise. Once the user starts typing, app
// names fuzzy-rank into the merged list naturally.
//
// IPC: window.electron.startApps.list / launch (main-process PS-backed).
// Cache: list result is held in memory after first fetch — kept across
// palette open/close (apps don't appear/disappear that often).

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Rocket } from 'lucide-react';
import React from 'react';
import { fuzzyFilter } from '../search';

interface StartApp { name: string; appId: string }

let listCache: StartApp[] | null = null;
let listLoad: Promise<StartApp[]> | null = null;

async function fetchList(): Promise<StartApp[]> {
    if (listCache) return listCache;
    if (listLoad) return listLoad;
    const bridge: any = (window as any).electron?.startApps;
    if (!bridge?.list) return [];
    const promise: Promise<StartApp[]> = bridge.list().then((r: StartApp[]) => {
        const next: StartApp[] = Array.isArray(r) ? r : [];
        listCache = next;
        listLoad = null;
        return next;
    }).catch(() => {
        listLoad = null;
        return [] as StartApp[];
    });
    listLoad = promise;
    return promise;
}

function toResult(app: StartApp): PaletteResult {
    return {
        id: `apps:${app.appId}`,
        title: app.name,
        subtitle: 'Open app',
        accent: '#3b82f6',
        icon: React.createElement(Rocket, { size: 14 }),
        primaryAction: {
            label: 'Launch',
            handler: () => {
                const bridge: any = (window as any).electron?.startApps;
                if (bridge?.launch) bridge.launch(app.appId);
            },
        },
    };
}

export const appsProvider: PaletteProvider = {
    id: 'apps',
    weight: 1.1,

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const q = input.trim();
        if (q.length === 0) return [];
        const apps = await fetchList();
        const candidates = apps.map(toResult);
        return fuzzyFilter(candidates, q, { threshold: 0.45 }).slice(0, 6);
    },
};
