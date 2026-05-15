// Landing page at klypix.com/.
//
// Previously this redirected to /login (the admin dashboard) — confusing for
// anyone clicking through from a share URL preview. Now it's a minimal
// marketing-ish page that explains what KLYPIX is and links into the parts
// that matter (download, sign in for admin).

import Link from 'next/link';

export default function Home() {
    return (
        <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
            <div className="w-full max-w-xl text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-400 mb-6">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2 L4 7 L4 17 L12 22 L20 17 L20 7 Z" />
                        <path d="M12 22 L12 12" />
                        <path d="M4 7 L12 12 L20 7" />
                    </svg>
                </div>

                <h1 className="text-4xl font-semibold text-white mb-3 tracking-tight">KLYPIX</h1>
                <p className="text-white/60 text-lg leading-relaxed">
                    The personal AI workspace that lives in <span className="text-emerald-400">one file you own</span>.
                </p>

                <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
                    <Feature
                        title="Spatial canvas"
                        body="Drop in files, images, notes — they live on an infinite canvas you can pan and zoom forever."
                    />
                    <Feature
                        title="Local-first"
                        body=".klypix is a single file on your disk. Email it, archive it, put it on a USB drive. No vendor lock-in."
                    />
                    <Feature
                        title="E2E encrypted sharing"
                        body="Share by URL — the decryption key never leaves your browser. Even we can't read your canvas."
                    />
                </div>

                <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
                    <Link
                        href="/login"
                        className="text-white/50 hover:text-white text-sm transition-colors"
                    >
                        Admin sign in →
                    </Link>
                </div>

                <div className="mt-16 text-white/30 text-xs">
                    Windows desktop app · web viewer at klypix.com
                </div>
            </div>
        </main>
    );
}

function Feature({ title, body }: { title: string; body: string }) {
    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
            <div className="text-emerald-400 text-xs font-medium uppercase tracking-wider mb-1.5">{title}</div>
            <div className="text-white/70 text-xs leading-relaxed">{body}</div>
        </div>
    );
}
