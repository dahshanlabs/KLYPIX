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

// Phase 18: invitations now carry the inviter's identity so the recipient
// sees who is asking them to collaborate. Both fields are optional — older
// servers without the get_invitation_preview RPC still work, just without
// the inviter line.
interface InviterIdentity {
    name: string | null;
    email: string | null;
}

// 2026-05-28: surface the *recipient* (you, the person accepting) on the
// invite page so a user with multiple browser profiles can't mistakenly
// accept under the wrong account. Pulled from supabase.auth.getUser()
// once the recipient is signed in.
interface AcceptorIdentity {
    name: string | null;
    email: string | null;
}

type ViewState =
    | { status: 'loading' }
    | { status: 'invalid'; reason: string }
    | { status: 'preview'; titleHint: string | null; blobId: string; inviter: InviterIdentity; acceptor: AcceptorIdentity | null }
    | { status: 'sign-in'; titleHint: string | null; inviter: InviterIdentity }
    | { status: 'accepting' }
    | { status: 'accepted'; titleHint: string | null; inviter: InviterIdentity; acceptor: AcceptorIdentity | null }
    | { status: 'error'; message: string };

function readAcceptorFromUser(user: unknown): AcceptorIdentity | null {
    if (!user || typeof user !== 'object') return null;
    const u = user as { email?: string | null; user_metadata?: { full_name?: string | null; name?: string | null } | null };
    const name = u.user_metadata?.full_name ?? u.user_metadata?.name ?? null;
    const email = u.email ?? null;
    if (!name && !email) return null;
    return { name, email };
}

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

            // Phase 18: prefer the new identity-bearing RPC. Falls back to
            // the old anon table read on stale servers so existing canvases
            // keep working through the migration window.
            let titleHint: string | null = null;
            let blobId: string | null = null;
            let inviter: InviterIdentity = { name: null, email: null };
            let fallbackError: string | null = null;
            try {
                const { data: previewRow, error: previewErr } = await supabase
                    .rpc('get_invitation_preview', { p_token: token });
                if (previewErr) throw previewErr;
                if (previewRow && typeof previewRow === 'object') {
                    const row = Array.isArray(previewRow) ? previewRow[0] : previewRow;
                    if (row) {
                        titleHint = row.title_hint ?? null;
                        blobId = row.blob_id ?? null;
                        inviter = {
                            name: row.inviter_display_name ?? null,
                            email: row.inviter_email ?? null,
                        };
                    }
                }
            } catch (e: any) {
                // Most likely: RPC missing on the server (404/PGRST). Fall back
                // to the legacy anon SELECT so older deployments still work.
                fallbackError = e?.message ?? null;
            }

            if (!blobId) {
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
                    setView({ status: 'invalid', reason: fallbackError || 'Invitation expired, revoked, or already used.' });
                    return;
                }
                titleHint = data.title_hint ?? null;
                blobId = data.blob_id ?? null;
            }
            if (cancelled) return;
            if (!blobId) {
                setView({ status: 'invalid', reason: 'Invitation expired, revoked, or already used.' });
                return;
            }
            if (isAuthed) {
                // Read the recipient's identity from the active session so we
                // can show "Signed in as <you>" on the preview card.
                const { data: userData } = await supabase.auth.getUser();
                const acceptor = readAcceptorFromUser(userData?.user);
                setView({ status: 'preview', titleHint, blobId, inviter, acceptor });
            } else {
                setView({ status: 'sign-in', titleHint, inviter });
            }
        })();
        return () => { cancelled = true; };
    }, [token]);

    // Step 3: when user transitions from preview/sign-in to authed, call the
    // accept RPC. The auth event listener handles the post-sign-in trigger.
    const accept = async () => {
        // Snapshot the inviter so we still have it after the accepted-state
        // transition — the RPC also returns it but we want a graceful path
        // when an old server omits it.
        const previewInviter: InviterIdentity = (() => {
            if (view.status === 'preview' || view.status === 'sign-in') return view.inviter;
            return { name: null, email: null };
        })();
        setView({ status: 'accepting' });
        try {
            const { data, error } = await supabase.rpc('accept_canvas_invitation', { p_token: token });
            if (error) throw error;
            // RPC returns a JSON object {blob_id, title_hint, key_b64, inviter_email, inviter_display_name}.
            // Older builds returned an array of rows or omitted the inviter fields —
            // handle all three shapes so a stale client doesn't break post-migration.
            const row = data && typeof data === 'object'
                ? (Array.isArray(data) ? data[0] : data)
                : null;
            const titleHint = row?.title_hint ?? null;
            const inviter: InviterIdentity = {
                name: row?.inviter_display_name ?? previewInviter.name,
                email: row?.inviter_email ?? previewInviter.email,
            };
            // Also fetch the acceptor's identity so the success card can
            // confirm which account just accepted (multi-profile safety).
            const { data: userData } = await supabase.auth.getUser();
            const acceptor = readAcceptorFromUser(userData?.user);
            setView({ status: 'accepted', titleHint, inviter, acceptor });
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
                            inviter={view.inviter}
                            acceptor={view.acceptor}
                            onAccept={accept}
                        />
                    )}
                    {view.status === 'sign-in' && (
                        <SignInCard titleHint={view.titleHint} inviter={view.inviter} />
                    )}
                    {view.status === 'accepting' && <LoadingCard label="Accepting…" />}
                    {view.status === 'accepted' && <AcceptedCard titleHint={view.titleHint} inviter={view.inviter} acceptor={view.acceptor} />}
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

function InviterLine({ inviter }: { inviter: InviterIdentity }) {
    if (!inviter.name && !inviter.email) return null;
    const display = inviter.name || inviter.email || '';
    return (
        <div className="flex items-center gap-2 mt-3">
            <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 text-[11px] font-medium">
                {display.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
                <div className="text-white/85 text-xs font-medium truncate">{display}</div>
                {inviter.name && inviter.email && (
                    <div className="text-white/40 text-[10px] truncate">{inviter.email}</div>
                )}
            </div>
        </div>
    );
}

// Recipient pill shown on the preview / accepted cards. Lets the user
// confirm which account they're acting under before / after accepting —
// critical when they're juggling multiple browser profiles or accounts.
// onSwitch is offered only when the user CAN still bail out (preview),
// not after the invitation has already been consumed.
function AcceptorLine({ acceptor, onSwitch }: { acceptor: AcceptorIdentity | null; onSwitch?: () => void }) {
    if (!acceptor) return null;
    const display = acceptor.name || acceptor.email || '';
    if (!display) return null;
    return (
        <div className="flex items-center gap-2 mt-3 rounded-lg bg-white/[0.03] border border-white/5 px-2.5 py-2">
            <div className="w-6 h-6 rounded-full bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-300 text-[11px] font-medium">
                {display.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-white/45 text-[9px] uppercase tracking-wider">Signed in as</div>
                <div className="text-white/85 text-xs font-medium truncate">{display}</div>
                {acceptor.name && acceptor.email && (
                    <div className="text-white/40 text-[10px] truncate">{acceptor.email}</div>
                )}
            </div>
            {onSwitch && (
                <button
                    type="button"
                    onClick={onSwitch}
                    className="text-white/45 hover:text-white/75 text-[10px] underline-offset-2 hover:underline whitespace-nowrap"
                >
                    Switch account
                </button>
            )}
        </div>
    );
}

function PreviewCard({ titleHint, inviter, acceptor, onAccept }: { titleHint: string | null; inviter: InviterIdentity; acceptor: AcceptorIdentity | null; onAccept: () => void }) {
    const hasInviter = !!(inviter.name || inviter.email);
    // "Switch account" signs out, reloads the page → the loader sees no
    // session → renders SignInCard so the user can pick a different one.
    const handleSwitch = async () => {
        try { await supabase.auth.signOut(); } catch { /* swallow */ }
        if (typeof window !== 'undefined') window.location.reload();
    };
    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5">
                <div className="text-white/40 text-[10px] uppercase tracking-wider mb-1">
                    {hasInviter ? 'You\'re invited by' : 'You\'re invited to collaborate on'}
                </div>
                {hasInviter && <InviterLine inviter={inviter} />}
                <div className={`text-white text-base font-medium truncate ${hasInviter ? 'mt-3' : ''}`}>
                    {hasInviter && <span className="text-white/40 text-xs font-normal mr-1">on</span>}
                    {titleHint || 'Untitled canvas'}
                </div>
                <AcceptorLine acceptor={acceptor} onSwitch={handleSwitch} />
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

function AcceptedCard({ titleHint, inviter, acceptor }: { titleHint: string | null; inviter: InviterIdentity; acceptor: AcceptorIdentity | null }) {
    const hasInviter = !!(inviter.name || inviter.email);
    return (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-5 py-6">
            <div className="flex items-center gap-2 mb-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                    <path d="M20 6 L9 17 L4 12" />
                </svg>
                <div className="text-emerald-300 text-sm font-medium">Invitation accepted</div>
            </div>
            <div className="text-white/60 text-xs leading-relaxed">
                You're now a collaborator on <span className="text-white font-medium">{titleHint || 'this canvas'}</span>
                {hasInviter && <> — shared by <span className="text-white font-medium">{inviter.name || inviter.email}</span></>}.
                Open the KLYPIX desktop app — the canvas will appear in your library shortly.
            </div>
            {/* Post-accept confirmation of the recipient identity. No switch-
                account link here — the invitation has already been consumed
                under this account; switching would leave them stranded. */}
            <AcceptorLine acceptor={acceptor} />
            <div className="text-white/40 text-[10px] mt-4 leading-relaxed">
                Don't have KLYPIX yet? <a href="https://klypix.com" className="text-emerald-400/80 hover:text-emerald-400">Get it at klypix.com →</a>
            </div>
        </div>
    );
}

function SignInCard({ titleHint, inviter }: { titleHint: string | null; inviter: InviterIdentity }) {
    const hasInviter = !!(inviter.name || inviter.email);
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
                <div className="text-white/40 text-[10px] uppercase tracking-wider mb-1">
                    {hasInviter ? 'You\'re invited by' : 'You\'re invited to collaborate on'}
                </div>
                {hasInviter && <InviterLine inviter={inviter} />}
                <div className={`text-white text-base font-medium truncate ${hasInviter ? 'mt-3' : ''}`}>
                    {hasInviter && <span className="text-white/40 text-xs font-normal mr-1">on</span>}
                    {titleHint || 'Untitled canvas'}
                </div>
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
