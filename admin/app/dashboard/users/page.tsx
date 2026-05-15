'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Profile {
    id: string;
    email: string;
    display_name: string;
    tier: string;
    license_key: string | null;
    queries_today: number;
    queries_total: number;
    last_active_at: string | null;
    app_version: string | null;
    created_at: string;
}

const TIERS = ['free', 'pro', 'team', 'enterprise', 'admin'];
const TIER_COLORS: Record<string, string> = {
    free: 'bg-white/10 text-white/60',
    pro: 'bg-emerald-500/20 text-emerald-400',
    team: 'bg-blue-500/20 text-blue-400',
    enterprise: 'bg-purple-500/20 text-purple-400',
    admin: 'bg-amber-500/20 text-amber-400',
};

export default function UsersPage() {
    const [users, setUsers] = useState<Profile[]>([]);
    const [search, setSearch] = useState('');
    const [filterTier, setFilterTier] = useState('all');
    const [loading, setLoading] = useState(true);
    const [editingUser, setEditingUser] = useState<string | null>(null);

    useEffect(() => {
        fetchUsers();
    }, []);

    async function fetchUsers() {
        setLoading(true);
        const { data } = await supabase
            .from('profiles')
            .select('*')
            .order('created_at', { ascending: false });
        setUsers(data || []);
        setLoading(false);
    }

    async function updateTier(userId: string, newTier: string) {
        await supabase.from('profiles').update({ tier: newTier }).eq('id', userId);
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, tier: newTier } : u));
        setEditingUser(null);
    }

    const filtered = users.filter(u => {
        if (filterTier !== 'all' && u.tier !== filterTier) return false;
        if (search && !u.email?.toLowerCase().includes(search.toLowerCase()) && !u.display_name?.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : '—';
    const formatTime = (d: string | null) => d ? new Date(d).toLocaleString() : 'Never';

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-semibold text-white">Users ({users.length})</h1>
            </div>

            {/* Filters */}
            <div className="flex gap-3 mb-4">
                <input
                    type="text"
                    placeholder="Search by email or name..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50"
                />
                <select
                    value={filterTier}
                    onChange={e => setFilterTier(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500/50"
                >
                    <option value="all">All tiers</option>
                    {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
            </div>

            {/* Table */}
            {loading ? (
                <p className="text-white/40 text-sm">Loading...</p>
            ) : (
                <div className="bg-[#1a1a1a] border border-white/5 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/5 text-white/40 text-xs uppercase tracking-wider">
                                <th className="text-left px-4 py-3">User</th>
                                <th className="text-left px-4 py-3">Tier</th>
                                <th className="text-left px-4 py-3">Queries</th>
                                <th className="text-left px-4 py-3">Last Active</th>
                                <th className="text-left px-4 py-3">Joined</th>
                                <th className="text-left px-4 py-3">Version</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(user => (
                                <tr key={user.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                                    <td className="px-4 py-3">
                                        <div>
                                            <p className="text-white text-sm">{user.display_name || '—'}</p>
                                            <p className="text-white/40 text-xs">{user.email}</p>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        {editingUser === user.id ? (
                                            <select
                                                value={user.tier}
                                                onChange={e => updateTier(user.id, e.target.value)}
                                                onBlur={() => setEditingUser(null)}
                                                autoFocus
                                                className="bg-white/10 border border-white/20 rounded px-2 py-1 text-white text-xs focus:outline-none"
                                            >
                                                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                                            </select>
                                        ) : (
                                            <button
                                                onClick={() => setEditingUser(user.id)}
                                                className={`px-2.5 py-1 rounded-full text-xs font-medium ${TIER_COLORS[user.tier] || TIER_COLORS.free}`}
                                            >
                                                {user.tier}
                                            </button>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-white/60 text-xs">
                                        {user.queries_today} today / {user.queries_total} total
                                    </td>
                                    <td className="px-4 py-3 text-white/40 text-xs">{formatTime(user.last_active_at)}</td>
                                    <td className="px-4 py-3 text-white/40 text-xs">{formatDate(user.created_at)}</td>
                                    <td className="px-4 py-3 text-white/40 text-xs">{user.app_version || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {filtered.length === 0 && (
                        <p className="text-white/30 text-sm text-center py-8">No users found</p>
                    )}
                </div>
            )}
        </div>
    );
}
