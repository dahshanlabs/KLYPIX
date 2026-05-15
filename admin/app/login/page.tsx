'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) { setError(authError.message); setLoading(false); return; }

        // Check if user is admin
        const { data: profile } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', data.user.id)
            .single();

        if (profile?.tier !== 'admin') {
            await supabase.auth.signOut();
            setError('Access denied. Admin privileges required.');
            setLoading(false);
            return;
        }

        router.push('/dashboard');
    };

    return (
        <div className="min-h-screen flex items-center justify-center">
            <div className="w-full max-w-sm px-6">
                <div className="text-center mb-8">
                    <h1 className="text-2xl font-semibold text-white">KLYPIX Admin</h1>
                    <p className="text-white/40 text-sm mt-1">Sign in to manage your deployment</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-4">
                    <input
                        type="email"
                        placeholder="Admin email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50"
                        required
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50"
                        required
                    />

                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg py-3 text-sm transition-all disabled:opacity-50"
                    >
                        {loading ? 'Signing in...' : 'Sign In'}
                    </button>
                </form>
            </div>
        </div>
    );
}
