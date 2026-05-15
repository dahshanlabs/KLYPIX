'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Stats {
    totalUsers: number;
    activeToday: number;
    totalQueries: number;
    queriesToday: number;
    proUsers: number;
    freeUsers: number;
}

export default function DashboardPage() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchStats() {
            const [profilesRes, eventsRes] = await Promise.all([
                supabase.from('profiles').select('tier, queries_today, queries_total, last_active_at'),
                supabase.from('usage_events').select('id', { count: 'exact', head: true }),
            ]);

            const profiles = profilesRes.data || [];
            const today = new Date().toISOString().split('T')[0];

            setStats({
                totalUsers: profiles.length,
                activeToday: profiles.filter(p => p.last_active_at?.startsWith(today)).length,
                totalQueries: profiles.reduce((sum, p) => sum + (p.queries_total || 0), 0),
                queriesToday: profiles.reduce((sum, p) => sum + (p.queries_today || 0), 0),
                proUsers: profiles.filter(p => p.tier !== 'free').length,
                freeUsers: profiles.filter(p => p.tier === 'free').length,
            });
            setLoading(false);
        }
        fetchStats();
    }, []);

    const StatCard = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-5">
            <p className="text-white/40 text-xs uppercase tracking-wider mb-1">{label}</p>
            <p className="text-2xl font-semibold text-white">{value}</p>
            {sub && <p className="text-white/30 text-xs mt-1">{sub}</p>}
        </div>
    );

    if (loading) return <div className="text-white/40">Loading...</div>;

    return (
        <div>
            <h1 className="text-xl font-semibold text-white mb-6">Dashboard</h1>

            <div className="grid grid-cols-3 gap-4 mb-8">
                <StatCard label="Total Users" value={stats?.totalUsers || 0} sub={`${stats?.proUsers || 0} paid, ${stats?.freeUsers || 0} free`} />
                <StatCard label="Active Today" value={stats?.activeToday || 0} />
                <StatCard label="Queries Today" value={stats?.queriesToday || 0} sub={`${stats?.totalQueries || 0} all time`} />
            </div>
        </div>
    );
}
