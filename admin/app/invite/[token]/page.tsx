'use client';

// Phase 7 — Accept an invitation to collaborate on a canvas.
//
// URL: /invite/<token>
//
// Flow:
//   1. Anon read the invitations row → show "Alice invited you to canvas X"
//   2. If not signed in: inline sign-in / sign-up form
//   3. Once signed in: call accept_canvas_invitation(token) RPC, which adds
//      the user as a collaborator and marks the invitation consumed
//   4. Show success + tell them to open the canvas in the KLYPIX desktop app

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

type ViewState =
    | { status: 'loading' }
    | { status: 'invalid'; reason: string }
    | { status: 'preview'; titleHint: string | null; blobId: string }
    | { status: 'sign-in'; titleHint: string | null }
    | { status: 'accepting' }
    | { status: 'accepted'; titleHint: string | null }
    | { status: 'error'; message: string };

export default function AcceptInvitePage() {
    const params = useParams<{ token: string }>();
    const token = params?.token ?? '';
    const [view, setView] = useState<ViewState>({ status: 'loading' });

    // Step 1: resolve the invitation via anon SELECT (allowed by RLS for
    // non-revoked, non-expired rows).
    useEffect(() => {
        if (!token) {
            setView({ status: 'invalid', reason: 'No invitation token in URL' });
            return;
        }
        let cancelled = false;
        (async () => {
            // Check if already signed in — if yes, jump straight to preview
            // (then immediately to accept) instead of showing sign-in form.
            const { data: sessionData } = await supabase.auth.getSession();
            const isAuthed = !!sessionData?.session;

            const { data, error } = await supabase
                .from('canvas_invitations')
                .select('blob_id, title_hint')
                .eq('token', token)
                .maybeSingle();

            if (cancelled) return;
            if (error) {
                if (/does not exist|placeholder/i.test(error.message)) {
                    setView({ status: 'error', message: 'Viewer is missing Supabase config.' });
                } else {
                    setView({ status: 'invalid', reason: error.message });
                }
                return;
            }
            if (!data) {
                setView({ status: 'invalid', reason: 'Invitation expired, revoked, or already used.' });
                return;
            }
            if (isAuthed) {
                setView({ status: 'preview', titleHint: data.title_hint, blobId: data.blob_id });
            } else {
                setView({ status: 'sign-in', titleHint: data.title_hint });
            }
        })();
        return () => { cancelled = true; };
    }, [token]);

    // Step 3: when user transitions from preview/sign-in to authed, call the
    // accept RPC. The auth event listener handles the post-sign-in trigger.
    const accept = async () => {
        setView({ status: 'accepting' });
        try {
            const { data, error } = await supabase.rpc('accept_canvas_invitation', { p_token: token });
            if (error) throw error;
            // RPC returns a JSON object {blob_id, title_hint}. Older builds of
            // the function returned an array of rows — handle both shapes so
            // a stale client doesn't break post-migration.
            const titleHint = data && typeof data === 'object'
                ? (Array.isArray(data) ? data[0]?.title_hint : data.title_hint) ?? null
                : null;
            setView({ status: 'accepted', titleHint });
        } catch (e: any) {
            setView({ status: 'error', message: e?.message || 'Could not accept invitation' });
        }
    };

    // Listen for sign-in / sign-up events to auto-advance to acceptance.
    useEffect(() => {
        const sub = supabase.auth.onAuthStateChange((_evt, session) => {
            if (session && (view.status === 'sign-in' || view.status === 'preview')) {
                void accept();
            }
        });
        return () => { sub.data.subscription.unsubscribe(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view.status]);

    return (
        <main className="min-h-screen flex items-center justify-center px-4 py-12">
            <div className="w-full max-w-md">
                <Header />
                <div className="mt-8">
                    {view.status === 'loading' && <LoadingCard label="Looking up invitation…" />}
                    {view.status === 'invalid' && <InvalidCard reason={view.reason} />}
                    {view.status === 'preview' && (
                        <PreviewCard
                            titleHint={view.titleHint}
                            onAccept={accept}
                        />
                    )}
                    {view.status === 'sign-in' && (
                        <SignInCard titleHint={view.titleHint} />
                    )}
                    {view.status === 'accepting' && <LoadingCard label="Accepting…" />}
                    {view.status === 'accepted' && <AcceptedCard titleHint={view.titleHint} />}
                    {view.status === 'error' && <ErrorCard message={view.message} />}
                </div>
                <Footer />
            </div>
        </main>
    );
}

function Header() {
    return (
        <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 mb-3">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2 L4 7 L4 17 L12 22 L20 17 L20 7 Z" />
                    <path d="M12 22 L12 12" />
                    <path d="M4 7 L12 12 L20 7" />
                </svg>
            </div>
            <h1 className="text-xl font-semibold text-white">KLYPIX</h1>
            <p className="text-white/40 text-sm mt-1">Canvas collaboration invite</p>
        </div>
    );
}

function LoadingCard({ label }: { label: string }) {
    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-5 py-8 text-center">
            <div className="inline-block w-5 h-5 border-2 border-white/20 border-t-emerald-400 rounded-full animate-spin" />
            <div className="text-white/60 text-sm mt-3">{label}</div>
        </div>
    );
}

function InvalidCard({ reason }: { reason: string }) {
    return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] px-5 py-6">
            <div className="text-red-300 text-sm font-medium">Invitation unavailable</div>
            <div className="text-white/50 text-xs mt-2 leading-relaxed">
                The link may be expired, revoked, or already used. Ask the sender for a new one.
            </div>
            <div className="text-white/30 text-[10px] mt-3 font-mono break-all">{reason}</div>
        </div>
    );
}

function ErrorCard({ message }: { message: string }) {
    return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] px-5 py-6">
            <div className="text-red-300 text-sm font-medium">Something went wrong</div>
            <div className="text-white/50 text-xs mt-2 leading-relaxed">{message}</div>
        </div>
    );
}

function PreviewCard({ titleHint, onAccept }: { titleHint: string | null; onAccept: () => void }) {
    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5">
                <div className="text-white/40 text-[10px] uppercase tracking-wider mb-1">You're invited to collaborate on</div>
                <div className="text-white text-base font-medium truncate">{titleHint || 'Untitled canvas'}</div>
            </div>
            <div className="px-5 py-5">
                <button
                    onClick={onAccept}
                    className="w-full rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 transition-colors border border-emerald-500/40 text-emerald-300 text-sm font-medium py-3"
                >
                    Accept invitation
                </button>
                <div className="text-white/40 text-xs mt-3 leading-relaxed">
                    Accepting adds this canvas to your KLYPIX library with editor access.
                </div>
            </div>
        </div>
    );
}

function AcceptedCard({ titleHint }: { titleHint: string | null }) {
    return (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-5 py-6">
            <div className="flex items-center gap-2 mb-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                    <path d="M20 6 L9 17 L4 12" />
                </svg>
                <div className="text-emerald-300 text-sm font-medium">Invitation accepted</div>
            </div>
            <div className="text-white/60 text-xs leading-relaxed">
                You're now a collaborator on <span className="text-white font-medium">{titleHint || 'this canvas'}</span>. Open the KLYPIX desktop app — the canvas will appear in your library shortly.
            </div>
            <div className="text-white/40 text-[10px] mt-4 leading-relaxed">
                Don't have KLYPIX yet? <a href="https://klypix.com" className="text-emerald-400/80 hover:text-emerald-400">Get it at klypix.com →</a>
            </div>
        </div>
    );
}

function SignInCard({ titleHint }: { titleHint: string | null }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);

    // OAuth: Supabase handles the handshake server-side. After auth completes
    // the provider redirects back to the same URL (we tell it via redirectTo).
    // The onAuthStateChange listener in the parent then auto-fires the accept
    // RPC. Provider must be enabled in Supabase dashboard → Auth → Providers.
    const handleOAuth = async (provider: 'google' | 'azure') => {
        setErr(null);
        setBusy(true);
        try {
            const { error } = await supabase.auth.signInWithOAuth({
                provider,
                options: { redirectTo: window.location.href },
            });
            if (error) throw error;
            // The browser is about to navigate away to the provider's auth
            // page — keep busy=true so the buttons stay disabled visually.
        } catch (e: any) {
            setErr(e?.message || `${provider} sign-in failed`);
            setBusy(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErr(null);
        setInfo(null);
        setBusy(true);
        try {
            if (mode === 'signin') {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
                // onAuthStateChange in parent will auto-accept.
            } else {
                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: { data: { full_name: displayName } },
                });
                if (error) throw error;
                if (!data.session) {
                    setInfo('Account created. Check your email to confirm, then come back to accept.');
                }
                // If session arrived (no email confirmation required), onAuthStateChange auto-accepts.
            }
        } catch (e: any) {
            setErr(e?.message || 'Auth failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5">
                <div className="text-white/40 text-[10px] uppercase tracking-wider mb-1">You're invited to collaborate on</div>
                <div className="text-white text-base font-medium truncate">{titleHint || 'Untitled canvas'}</div>
                <div className="text-white/50 text-xs mt-2">Sign in or create an account to accept.</div>
            </div>
            <div className="px-5 pt-5 flex flex-col gap-2">
                <button
                    type="button"
                    onClick={() => handleOAuth('google')}
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg py-2.5 text-white/85 text-sm font-medium transition-all disabled:opacity-50 cursor-pointer"
                >
                    <svg width="14" height="14" viewBox="0 0 48 48" fill="none">
                        <path d="M44 24c0-1.4-.13-2.74-.38-4H24v8h11.32c-.5 2.66-2 4.92-4.27 6.43v5.34h6.9C42 36.06 44 30.5 44 24z" fill="#4285F4"/>
                        <path d="M24 44c5.76 0 10.6-1.9 14.13-5.15l-6.9-5.34c-1.9 1.27-4.34 2.03-7.23 2.03-5.56 0-10.27-3.75-11.95-8.78H4.95v5.5C8.46 39.4 15.66 44 24 44z" fill="#34A853"/>
                        <path d="M12.05 26.76A12.04 12.04 0 0 1 11.4 24c0-.96.17-1.9.46-2.76v-5.5H4.95A19.96 19.96 0 0 0 3 24c0 3.22.77 6.27 2.13 8.97l6.92-5.5z" fill="#FBBC05"/>
                        <path d="M24 11.46c3.13 0 5.94 1.08 8.15 3.18l6.12-6.12C34.6 5.04 29.76 3 24 3 15.66 3 8.46 7.6 4.95 14.5l6.92 5.5C13.73 15.2 18.44 11.46 24 11.46z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                </button>
                <button
                    type="button"
                    onClick={() => handleOAuth('azure')}
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg py-2.5 text-white/85 text-sm font-medium transition-all disabled:opacity-50 cursor-pointer"
                >
                    <svg width="14" height="14" viewBox="0 0 21 21" fill="none">
                        <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                        <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                        <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                        <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                    </svg>
                    Continue with Microsoft
                </button>
                <div className="flex items-center gap-3 text-white/30 text-[10px] my-1">
                    <div className="flex-1 h-px bg-white/10" />
                    <span>or</span>
                    <div className="flex-1 h-px bg-white/10" />
                </div>
            </div>
            <form onSubmit={handleSubmit} className="px-5 pb-5 flex flex-col gap-2">
                {mode === 'signup' && (
                    <input
                        type="text"
                        placeholder="Your name"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        disabled={busy}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50"
                    />
                )}
                <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    disabled={busy}
                    required
                    autoComplete="email"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50"
                />
                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    disabled={busy}
                    required
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50"
                />
                {err && <div className="text-red-300 text-xs">{err}</div>}
                {info && <div className="text-emerald-300 text-xs">{info}</div>}
                <button
                    type="submit"
                    disabled={busy}
                    className="w-full rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 transition-colors border border-emerald-500/40 text-emerald-300 text-sm font-medium py-2.5 mt-1 disabled:opacity-50"
                >
                    {busy ? 'Working…' : mode === 'signin' ? 'Sign in & accept' : 'Create account & accept'}
                </button>
                <button
                    type="button"
                    onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setErr(null); setInfo(null); }}
                    className="text-white/40 hover:text-white/60 text-xs text-center mt-2"
                >
                    {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
                </button>
            </form>
        </div>
    );
}

function Footer() {
    return (
        <div className="text-center mt-8">
            <a href="https://klypix.com" className="inline-block text-emerald-400/70 hover:text-emerald-400 text-xs">
                klypix.com →
            </a>
        </div>
    );
}
