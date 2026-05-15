'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface License {
    key: string;
    tier: string;
    max_activations: number;
    current_activations: number;
    created_at: string;
    expires_at: string | null;
    revoked: boolean;
    notes: string | null;
}

function generateKey(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${part()}-${part()}-${part()}-${part()}`;
}

export default function LicensesPage() {
    const [licenses, setLicenses] = useState<License[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [newTier, setNewTier] = useState('pro');
    const [newMaxAct, setNewMaxAct] = useState(1);
    const [newNotes, setNewNotes] = useState('');
    const [batchCount, setBatchCount] = useState(1);
    const [creating, setCreating] = useState(false);

    useEffect(() => { fetchLicenses(); }, []);

    async function fetchLicenses() {
        setLoading(true);
        const { data } = await supabase.from('licenses').select('*').order('created_at', { ascending: false });
        setLicenses(data || []);
        setLoading(false);
    }

    async function createLicenses() {
        setCreating(true);
        const keys = Array.from({ length: batchCount }, () => ({
            key: generateKey(),
            tier: newTier,
            max_activations: newMaxAct,
            notes: newNotes || null,
        }));
        await supabase.from('licenses').insert(keys);
        setShowCreate(false);
        setNewNotes('');
        setBatchCount(1);
        await fetchLicenses();
        setCreating(false);
    }

    async function revokeLicense(key: string) {
        if (!confirm(`Revoke license ${key}?`)) return;
        await supabase.from('licenses').update({ revoked: true }).eq('key', key);
        setLicenses(prev => prev.map(l => l.key === key ? { ...l, revoked: true } : l));
    }

    async function unrevokeLicense(key: string) {
        await supabase.from('licenses').update({ revoked: false }).eq('key', key);
        setLicenses(prev => prev.map(l => l.key === key ? { ...l, revoked: false } : l));
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-semibold text-white">Licenses ({licenses.length})</h1>
                <button
                    onClick={() => setShowCreate(!showCreate)}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-all"
                >
                    Generate Keys
                </button>
            </div>

            {/* Create form */}
            {showCreate && (
                <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-5 mb-6 space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Tier</label>
                            <select value={newTier} onChange={e => setNewTier(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                                <option value="pro">Pro</option>
                                <option value="team">Team</option>
                                <option value="enterprise">Enterprise</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Max Activations</label>
                            <input type="number" min={1} value={newMaxAct} onChange={e => setNewMaxAct(Number(e.target.value))} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
                        </div>
                        <div>
                            <label className="text-white/40 text-xs block mb-1">Batch Count</label>
                            <input type="number" min={1} max={50} value={batchCount} onChange={e => setBatchCount(Number(e.target.value))} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
                        </div>
                    </div>
                    <div>
                        <label className="text-white/40 text-xs block mb-1">Notes (optional)</label>
                        <input type="text" value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="e.g., Client name, purchase ID" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30" />
                    </div>
                    <button onClick={createLicenses} disabled={creating} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-all disabled:opacity-50">
                        {creating ? 'Creating...' : `Generate ${batchCount} Key${batchCount > 1 ? 's' : ''}`}
                    </button>
                </div>
            )}

            {/* Table */}
            {loading ? (
                <p className="text-white/40 text-sm">Loading...</p>
            ) : (
                <div className="bg-[#1a1a1a] border border-white/5 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/5 text-white/40 text-xs uppercase tracking-wider">
                                <th className="text-left px-4 py-3">Key</th>
                                <th className="text-left px-4 py-3">Tier</th>
                                <th className="text-left px-4 py-3">Activations</th>
                                <th className="text-left px-4 py-3">Status</th>
                                <th className="text-left px-4 py-3">Notes</th>
                                <th className="text-left px-4 py-3">Created</th>
                                <th className="text-left px-4 py-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {licenses.map(lic => (
                                <tr key={lic.key} className="border-b border-white/5 hover:bg-white/[0.02]">
                                    <td className="px-4 py-3 font-mono text-xs text-white/80">{lic.key}</td>
                                    <td className="px-4 py-3">
                                        <span className="px-2 py-0.5 rounded-full text-xs bg-emerald-500/20 text-emerald-400">{lic.tier}</span>
                                    </td>
                                    <td className="px-4 py-3 text-white/60 text-xs">{lic.current_activations}/{lic.max_activations}</td>
                                    <td className="px-4 py-3">
                                        {lic.revoked ? (
                                            <span className="text-red-400 text-xs">Revoked</span>
                                        ) : lic.current_activations >= lic.max_activations ? (
                                            <span className="text-amber-400 text-xs">Full</span>
                                        ) : (
                                            <span className="text-emerald-400 text-xs">Active</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-white/40 text-xs max-w-[200px] truncate">{lic.notes || '—'}</td>
                                    <td className="px-4 py-3 text-white/40 text-xs">{new Date(lic.created_at).toLocaleDateString()}</td>
                                    <td className="px-4 py-3">
                                        {lic.revoked ? (
                                            <button onClick={() => unrevokeLicense(lic.key)} className="text-emerald-400 hover:text-emerald-300 text-xs">Restore</button>
                                        ) : (
                                            <button onClick={() => revokeLicense(lic.key)} className="text-red-400 hover:text-red-300 text-xs">Revoke</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {licenses.length === 0 && (
                        <p className="text-white/30 text-sm text-center py-8">No licenses generated yet</p>
                    )}
                </div>
            )}
        </div>
    );
}
