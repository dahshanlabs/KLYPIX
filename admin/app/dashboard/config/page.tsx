'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface ConfigEntry {
    key: string;
    value: any;
    updated_at: string;
}

const DEFAULT_CONFIGS = [
    { key: 'default_model', label: 'Default AI Model', type: 'select', options: ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-pro'] },
    { key: 'free_query_limit', label: 'Free Tier Daily Query Limit', type: 'number' },
    { key: 'maintenance_mode', label: 'Maintenance Mode', type: 'boolean' },
    { key: 'announcement', label: 'Announcement Banner', type: 'text' },
    { key: 'feature_deep_mode', label: 'Deep Mode Enabled', type: 'boolean' },
    { key: 'feature_agent_mode', label: 'Agent Mode Enabled', type: 'boolean' },
    { key: 'feature_doc_generation', label: 'Doc Generation Enabled', type: 'boolean' },
    { key: 'feature_image_generation', label: 'Image Generation Enabled', type: 'boolean' },
];

export default function ConfigPage() {
    const [configs, setConfigs] = useState<Map<string, any>>(new Map());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);

    useEffect(() => {
        async function fetch() {
            const { data } = await supabase.from('app_config').select('*');
            const map = new Map<string, any>();
            (data || []).forEach(c => map.set(c.key, c.value));
            setConfigs(map);
            setLoading(false);
        }
        fetch();
    }, []);

    async function saveConfig(key: string, value: any) {
        setSaving(key);
        await supabase.from('app_config').upsert({
            key,
            value,
            updated_at: new Date().toISOString(),
        });
        setConfigs(prev => new Map(prev).set(key, value));
        setSaving(null);
    }

    if (loading) return <p className="text-white/40 text-sm">Loading...</p>;

    return (
        <div>
            <h1 className="text-xl font-semibold text-white mb-6">App Configuration</h1>

            <div className="space-y-3">
                {DEFAULT_CONFIGS.map(cfg => {
                    const currentValue = configs.get(cfg.key);

                    return (
                        <div key={cfg.key} className="bg-[#1a1a1a] border border-white/5 rounded-xl px-5 py-4 flex items-center justify-between">
                            <div>
                                <p className="text-white text-sm">{cfg.label}</p>
                                <p className="text-white/30 text-xs font-mono">{cfg.key}</p>
                            </div>

                            <div className="flex items-center gap-3">
                                {cfg.type === 'boolean' && (
                                    <button
                                        onClick={() => saveConfig(cfg.key, !currentValue)}
                                        className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                            currentValue
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : 'bg-white/5 text-white/40 border border-white/10'
                                        }`}
                                    >
                                        {currentValue ? 'ON' : 'OFF'}
                                    </button>
                                )}

                                {cfg.type === 'number' && (
                                    <input
                                        type="number"
                                        value={currentValue ?? ''}
                                        onChange={e => saveConfig(cfg.key, Number(e.target.value))}
                                        className="w-24 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm text-right focus:outline-none focus:border-emerald-500/50"
                                    />
                                )}

                                {cfg.type === 'text' && (
                                    <input
                                        type="text"
                                        value={currentValue ?? ''}
                                        onBlur={e => saveConfig(cfg.key, e.target.value)}
                                        onChange={e => setConfigs(prev => new Map(prev).set(cfg.key, e.target.value))}
                                        placeholder="Empty"
                                        className="w-64 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-emerald-500/50 placeholder-white/20"
                                    />
                                )}

                                {cfg.type === 'select' && (
                                    <select
                                        value={currentValue ?? cfg.options?.[0]}
                                        onChange={e => saveConfig(cfg.key, e.target.value)}
                                        className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-emerald-500/50"
                                    >
                                        {cfg.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                    </select>
                                )}

                                {saving === cfg.key && <span className="text-emerald-400 text-xs">Saving...</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
