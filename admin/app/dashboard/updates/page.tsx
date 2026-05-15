'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Release {
    version: string;
    download_url: string | null;
    release_notes: string | null;
    rollout_percentage: number;
    is_mandatory: boolean;
    min_supported_version: string | null;
    published_at: string;
}

export default function UpdatesPage() {
    const [releases, setReleases] = useState<Release[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [form, setForm] = useState({ version: '', downloadUrl: '', releaseNotes: '', rollout: 5, mandatory: false, minVersion: '' });
    const [creating, setCreating] = useState(false);

    useEffect(() => { fetchReleases(); }, []);

    async function fetchReleases() {
        setLoading(true);
        const { data } = await supabase.from('releases').select('*').order('published_at', { ascending: false });
        setReleases(data || []);
        setLoading(false);
    }

    async function createRelease() {
        if (!form.version) return;
        setCreating(true);
        await supabase.from('releases').insert({
            version: form.version,
            download_url: form.downloadUrl || null,
            release_notes: form.releaseNotes || null,
            rollout_percentage: form.rollout,
            is_mandatory: form.mandatory,
            min_supported_version: form.minVersion || null,
        });
        setShowCreate(false);
        setForm({ version: '', downloadUrl: '', releaseNotes: '', rollout: 5, mandatory: false, minVersion: '' });
        await fetchReleases();
        setCreating(false);
    }

    async function updateRollout(version: string, percentage: number) {
        await supabase.from('releases').update({ rollout_percentage: percentage }).eq('version', version);
        setReleases(prev => prev.map(r => r.version === version ? { ...r, rollout_percentage: percentage } : r));
    }

    async function toggleMandatory(version: string, mandatory: boolean) {
        await supabase.from('releases').update({ is_mandatory: mandatory }).eq('version', version);
        setReleases(prev => prev.map(r => r.version === version ? { ...r, is_mandatory: mandatory } : r));
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-semibold text-white">Update Releases</h1>
                <button onClick={() => setShowCreate(!showCreate)} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-all">
                    New Release
                </button>
            </div>

            {/* Create form */}
            {showCreate && (
                <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-5 mb-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Version</label>
                            <input type="text" value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))} placeholder="1.2.0" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50" />
                        </div>
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Download URL</label>
                            <input type="text" value={form.downloadUrl} onChange={e => setForm(f => ({ ...f, downloadUrl: e.target.value }))} placeholder="GitHub release URL" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50" />
                        </div>
                    </div>
                    <div>
                        <label className="text-white/40 text-xs block mb-1">Release Notes</label>
                        <textarea value={form.releaseNotes} onChange={e => setForm(f => ({ ...f, releaseNotes: e.target.value }))} rows={3} placeholder="What's new in this version..." className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50 resize-none" />
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Initial Rollout %</label>
                            <input type="number" min={0} max={100} value={form.rollout} onChange={e => setForm(f => ({ ...f, rollout: Number(e.target.value) }))} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
                        </div>
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Min Supported Version</label>
                            <input type="text" value={form.minVersion} onChange={e => setForm(f => ({ ...f, minVersion: e.target.value }))} placeholder="1.0.0" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50" />
                        </div>
                        <div className="flex items-end">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={form.mandatory} onChange={e => setForm(f => ({ ...f, mandatory: e.target.checked }))} className="accent-emerald-500" />
                                <span className="text-white/60 text-sm">Mandatory</span>
                            </label>
                        </div>
                    </div>
                    <button onClick={createRelease} disabled={creating || !form.version} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-all disabled:opacity-50">
                        {creating ? 'Publishing...' : 'Publish Release'}
                    </button>
                </div>
            )}

            {/* Releases list */}
            {loading ? (
                <p className="text-white/40 text-sm">Loading...</p>
            ) : (
                <div className="space-y-3">
                    {releases.map(rel => (
                        <div key={rel.version} className="bg-[#1a1a1a] border border-white/5 rounded-xl p-5">
                            <div className="flex items-start justify-between mb-3">
                                <div>
                                    <div className="flex items-center gap-3">
                                        <h3 className="text-white font-semibold">v{rel.version}</h3>
                                        {rel.is_mandatory && <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/20 text-amber-400 font-medium">MANDATORY</span>}
                                    </div>
                                    <p className="text-white/30 text-xs mt-0.5">{new Date(rel.published_at).toLocaleString()}</p>
                                </div>
                                <button
                                    onClick={() => toggleMandatory(rel.version, !rel.is_mandatory)}
                                    className={`px-3 py-1 rounded-lg text-xs transition-all ${rel.is_mandatory ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-white/40 hover:text-white/70'}`}
                                >
                                    {rel.is_mandatory ? 'Remove Mandatory' : 'Make Mandatory'}
                                </button>
                            </div>

                            {rel.release_notes && (
                                <p className="text-white/50 text-sm mb-3">{rel.release_notes}</p>
                            )}

                            {/* Rollout slider */}
                            <div className="flex items-center gap-4">
                                <span className="text-white/40 text-xs w-16">Rollout:</span>
                                <input
                                    type="range"
                                    min={0} max={100} step={5}
                                    value={rel.rollout_percentage}
                                    onChange={e => updateRollout(rel.version, Number(e.target.value))}
                                    className="flex-1 accent-emerald-500 h-1"
                                />
                                <span className={`text-sm font-medium w-12 text-right ${rel.rollout_percentage === 100 ? 'text-emerald-400' : rel.rollout_percentage === 0 ? 'text-red-400' : 'text-white/60'}`}>
                                    {rel.rollout_percentage}%
                                </span>
                            </div>

                            {rel.rollout_percentage === 0 && (
                                <p className="text-red-400/60 text-xs mt-2">Rollout paused — no users will receive this update</p>
                            )}
                        </div>
                    ))}

                    {releases.length === 0 && (
                        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-8 text-center">
                            <p className="text-white/30 text-sm">No releases published yet</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
