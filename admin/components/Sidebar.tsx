'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

const NAV_ITEMS = [
    { href: '/dashboard', label: 'Overview', icon: '◻' },
    { href: '/dashboard/users', label: 'Users', icon: '👤' },
    { href: '/dashboard/licenses', label: 'Licenses', icon: '🔑' },
    { href: '/dashboard/analytics', label: 'Analytics', icon: '📊' },
    { href: '/dashboard/config', label: 'Config', icon: '⚙' },
    { href: '/dashboard/updates', label: 'Updates', icon: '🔄' },
];

export function Sidebar() {
    const pathname = usePathname();
    const router = useRouter();

    const handleLogout = async () => {
        await supabase.auth.signOut();
        router.push('/login');
    };

    return (
        <aside className="w-56 h-screen bg-[#111] border-r border-white/5 flex flex-col fixed left-0 top-0">
            {/* Logo */}
            <div className="px-5 py-5 border-b border-white/5">
                <h1 className="text-base font-semibold text-white">KLYPIX</h1>
                <p className="text-white/30 text-xs mt-0.5">Admin Panel</p>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-3 py-4 space-y-1">
                {NAV_ITEMS.map(item => {
                    const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                                isActive
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-xs">{item.icon}</span>
                            {item.label}
                        </Link>
                    );
                })}
            </nav>

            {/* Logout */}
            <div className="px-3 py-4 border-t border-white/5">
                <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                    <span className="text-xs">↩</span>
                    Sign Out
                </button>
            </div>
        </aside>
    );
}
