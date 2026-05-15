'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface DailyStats {
    date: string;
    count: number;
}

interface FeatureUsage {
    feature: string;
    count: number;
}

export default function AnalyticsPage() {
    const [dailyQueries, setDailyQueries] = useState<DailyStats[]>([]);
    const [featureUsage, setFeatureUsage] = useState<FeatureUsage[]>([]);
    const [totalEvents, setTotalEvents] = useState(0);
    const [loading, setLoading] = useState(true);
    const [days, setDays] = useState(7);

    useEffect(() => {
        fetchAnalytics();
    }, [days]);

    async function fetchAnalytics() {
        setLoading(true);
        const since = new Date();
        since.setDate(since.getDate() - days);

        // Fetch events
        const { data: events } = await supabase
            .from('usage_events')
            .select('event_type, feature, created_at')
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: true });

        if (!events) { setLoading(false); return; }

        setTotalEvents(events.length);

        // Group by day
        const byDay = new Map<string, number>();
        for (const e of events) {
            const day = e.created_at.split('T')[0];
            byDay.set(day, (byDay.get(day) || 0) + 1);
        }
        setDailyQueries(Array.from(byDay.entries()).map(([date, count]) => ({ date, count })));

        // Group by feature
        const byFeature = new Map<string, number>();
        for (const e of events) {
            const key = e.feature || e.event_type || 'unknown';
            byFeature.set(key, (byFeature.get(key) || 0) + 1);
        }
        const featureArr = Array.from(byFeature.entries())
            .map(([feature, count]) => ({ feature, count }))
            .sort((a, b) => b.count - a.count);
        setFeatureUsage(featureArr);

        setLoading(false);
    }

    const maxDaily = Math.max(...dailyQueries.map(d => d.count), 1);

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-semibold text-white">Analytics</h1>
                <div className="flex gap-2">
                    {[7, 14, 30].map(d => (
                        <button
                            key={d}
                            onClick={() => setDays(d)}
                            className={`px-3 py-1.5 rounded-lg text-xs transition-all ${days === d ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-white/5 text-white/40 hover:text-white/70'}`}
                        >
                            {d}d
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <p className="text-white/40 text-sm">Loading...</p>
            ) : (
                <div className="space-y-6">
                    {/* Summary */}
                    <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-5">
                        <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Total Events (last {days} days)</p>
                        <p className="text-3xl font-semibold text-white">{totalEvents.toLocaleString()}</p>
                    </div>

                    {/* Daily chart (simple bar chart) */}
                    <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-5">
                        <p className="text-white/40 text-xs uppercase tracking-wider mb-4">Queries per Day</p>
                        <div className="flex items-end gap-1 h-32">
                            {dailyQueries.map(d => (
                                <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                                    <span className="text-white/30 text-[10px]">{d.count}</span>
                                    <div
                                        className="w-full bg-emerald-500/60 rounded-t transition-all hover:bg-emerald-500/80"
                                        style={{ height: `${(d.count / maxDaily) * 100}%`, minHeight: d.count > 0 ? '4px' : '0' }}
                                    />
                                    <span className="text-white/20 text-[9px]">{d.date.slice(5)}</span>
                                </div>
                            ))}
                            {dailyQueries.length === 0 && (
                                <p className="text-white/30 text-sm w-full text-center">No data</p>
                            )}
                        </div>
                    </div>

                    {/* Feature breakdown */}
                    <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-5">
                        <p className="text-white/40 text-xs uppercase tracking-wider mb-4">Feature Usage</p>
                        <div className="space-y-2">
                            {featureUsage.slice(0, 15).map(f => {
                                const pct = totalEvents > 0 ? (f.count / totalEvents) * 100 : 0;
                                return (
                                    <div key={f.feature} className="flex items-center gap-3">
                                        <span className="text-white/60 text-xs w-32 truncate">{f.feature}</span>
                                        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                                            <div className="h-full bg-emerald-500/60 rounded-full" style={{ width: `${pct}%` }} />
                                        </div>
                                        <span className="text-white/40 text-xs w-16 text-right">{f.count}</span>
                                    </div>
                                );
                            })}
                            {featureUsage.length === 0 && (
                                <p className="text-white/30 text-sm">No usage data</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
