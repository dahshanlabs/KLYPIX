import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Copy, Check, AlertCircle, X, Loader2, Cloud, Users } from 'lucide-react';
import { shareCurrentCanvas, type ShareResult } from './shareCurrentCanvas';
import { getCloudShare } from './cloudShareStore';
import { useAuth } from '../../components/AuthProvider';

interface Props {
    /** Path of the canvas file to share. Null = canvas not saved yet. */
    canvasFilePath: string | null;
    /** Display title for the canvas (used as the optional title_hint sent to server). */
    canvasTitle: string;
    /** Called when the user dismisses the modal. */
    onClose: () => void;
}

/**
 * Share-this-canvas modal. Three lifecycle states:
 *   1. Unsaved → friendly nudge to save first.
 *   2. Saving in progress → spinner.
 *   3. Resolved → either show the share URL with copy button, OR show an
 *      error with the route-to-fix (sign in / retry).
 *
 * The first share auto-fires on mount when the canvas has no existing
 * cloud blob — assumption being that the user clicked Share BECAUSE
 * they want to share. If a previous share exists, we show the existing
 * URL immediately and offer "Update cloud copy" as a separate action.
 */
export const ShareModal: React.FC<Props> = ({ canvasFilePath, canvasTitle, onClose }) => {
    const existing = canvasFilePath ? getCloudShare(canvasFilePath) : null;
    // Initial state: unsaved canvases jump straight to the "save first" error
    // so the modal body is never empty. Existing share → done. Else → idle
    // and the auto-fire effect below kicks off the upload.
    const initialState: 'idle' | 'sharing' | 'done' | 'error' = existing
        ? 'done'
        : !canvasFilePath ? 'error' : 'idle';
    const [state, setState] = useState<'idle' | 'sharing' | 'done' | 'error'>(initialState);
    const [result, setResult] = useState<ShareResult | null>(
        existing
            ? { ok: true, share: existing, isNew: false }
            : !canvasFilePath ? { ok: false, reason: 'unsaved' } : null
    );
    const [copied, setCopied] = useState(false);

    // Auto-fire share on mount only if no existing share — saves the user a
    // click for the common "first time sharing this canvas" path.
    useEffect(() => {
        if (state === 'idle' && canvasFilePath && !existing) {
            void runShare();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ESC key closes — guaranteed escape hatch even if click events get
    // swallowed by drawing tools that pointer-capture on the canvas surface.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        // Capture phase so we beat any canvas keyboard handlers.
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    async function runShare() {
        if (!canvasFilePath) {
            setState('error');
            setResult({ ok: false, reason: 'unsaved' });
            return;
        }
        setState('sharing');
        const res = await shareCurrentCanvas({ filePath: canvasFilePath, title: canvasTitle });
        setResult(res);
        setState(res.ok ? 'done' : 'error');
    }

    async function copyToClipboard(url: string) {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            // Fallback for environments without clipboard API.
            const el = document.createElement('textarea');
            el.value = url;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        }
    }

    // Render via portal to document.body so we escape any pointer-events
    // pickle inside the canvas surface (drawing tools call setPointerCapture
    // which can swallow clicks on overlays rendered as canvas descendants).
    if (typeof document === 'undefined') return null;
    return createPortal((
        <div
            className="fixed inset-0 flex items-center justify-center"
            style={{
                background: 'rgba(0, 0, 0, 0.5)',
                pointerEvents: 'auto',
                zIndex: 9999,
            }}
            // onPointerDown fires BEFORE drawing tools' pointer capture kicks in.
            onPointerDown={(e) => {
                // Close on dimmer click (target === currentTarget means the
                // pointer is on the backdrop, not the inner modal box).
                if (e.target === e.currentTarget) {
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: 'min(480px, 92vw)',
                    background: 'rgba(15, 15, 24, 0.97)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: 14,
                    padding: '20px 22px 18px',
                    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
                    fontFamily: 'Outfit, system-ui, sans-serif',
                    color: '#e8e8ed',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <div style={{
                            width: 28, height: 28, borderRadius: 8,
                            background: 'rgba(16, 185, 129, 0.15)',
                            color: '#10b981',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                            <Cloud size={15} />
                        </div>
                        <div>
                            <div style={{ fontSize: 15, fontWeight: 600 }}>Share canvas</div>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>
                                End-to-end encrypted — server cannot read your canvas
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        // onPointerDown fires BEFORE drawing tools call setPointerCapture
                        // on the canvas surface — without this, the pen tool can swallow
                        // the click that should have closed the modal.
                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
                        title="Close (Esc)"
                        aria-label="Close share dialog"
                        style={{
                            padding: 8,
                            borderRadius: 8,
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            color: 'rgba(255,255,255,0.7)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            lineHeight: 0,
                        }}
                    >
                        <X size={16} />
                    </button>
                </div>

                {state === 'sharing' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: 'rgba(255,255,255,0.7)' }}>
                        <Loader2 size={16} className="animate-spin" />
                        <span style={{ fontSize: 13 }}>
                            {existing ? 'Uploading updated copy to cloud…' : 'Encrypting and uploading…'}
                        </span>
                    </div>
                )}

                {state === 'done' && result?.ok && (
                    <ShareReadyBody share={result.share} copied={copied} onCopy={copyToClipboard} onUpdate={runShare} isNew={result.isNew} />
                )}

                {state === 'error' && result && !result.ok && (
                    <ShareErrorBody reason={result.reason} error={result.error} onRetry={runShare} canvasFilePath={canvasFilePath} />
                )}
            </div>
        </div>
    ), document.body);
};

function ShareReadyBody({ share, copied, onCopy, onUpdate, isNew }: { share: { shareUrl: string; lastPushedAt: number; blobId: string }; copied: boolean; onCopy: (url: string) => void; onUpdate: () => void; isNew: boolean; }) {
    const minsAgo = Math.max(0, Math.floor((Date.now() - share.lastPushedAt) / 60000));
    return (
        <>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Link2 size={11} />
                Share URL
            </div>
            <div style={{
                display: 'flex', gap: 8, alignItems: 'stretch',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: 4,
                marginBottom: 12,
            }}>
                <div style={{
                    flex: 1, minWidth: 0,
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.85)',
                    padding: '8px 10px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }} title={share.shareUrl}>
                    {share.shareUrl}
                </div>
                <button
                    onClick={() => onCopy(share.shareUrl)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '8px 14px',
                        borderRadius: 6,
                        background: copied ? 'rgba(16, 185, 129, 0.18)' : 'rgba(16, 185, 129, 0.12)',
                        color: '#10b981',
                        border: 'none', cursor: 'pointer',
                        fontSize: 11, fontWeight: 500,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                </button>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5, marginBottom: 14 }}>
                {isNew ? (
                    <>The encryption key lives in the URL fragment (<code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3 }}>#...</code>) — browsers never send it to the server. Anyone with this URL can decrypt; without it, no one can.</>
                ) : (
                    <>Cloud copy was uploaded {minsAgo === 0 ? 'just now' : `${minsAgo}m ago`}. The share URL hasn't changed.</>
                )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                    onClick={onUpdate}
                    style={{
                        padding: '7px 12px',
                        borderRadius: 7,
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: '#e8e8ed',
                        fontSize: 11,
                        cursor: 'pointer',
                    }}
                    title="Re-upload the current local version so the cloud copy reflects your latest edits"
                >
                    Update cloud copy
                </button>
            </div>
            <InviteCollaboratorsSection share={share} />
        </>
    );
}

// ── Invite collaborators (Phase 7) ────────────────────────────────────────
// Sender mints a single-use invite link; recipient opens it in a browser,
// signs in, and gets added as an editor on the canvas. The link is separate
// from the share URL because share URLs grant read-only via the canvas_share_tokens
// table; invitations grant read-write via canvas_collaborators.

interface InviteResult {
    token: string;
    inviteUrl: string;
    expiresAt: string;
}

function InviteCollaboratorsSection({ share }: { share: { blobId: string } }) {
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [latest, setLatest] = useState<InviteResult | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const handleCreate = async () => {
        setErr(null);
        setBusy(true);
        try {
            const bridge: any = (window as any).electron?.cloud;
            if (!bridge?.createInvitation) throw new Error('Invite IPC unavailable');
            const res: InviteResult = await bridge.createInvitation({
                blobId: share.blobId,
                email: email.trim() || undefined,
            });
            setLatest(res);
        } catch (e: any) {
            setErr(e?.message || 'Failed to create invite');
        } finally {
            setBusy(false);
        }
    };

    const copyInvite = async () => {
        if (!latest) return;
        const text = latest.inviteUrl;
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            // Fallback for environments where clipboard API is blocked
            // (some Electron contexts, unfocused windows, file:// origin).
            try {
                const el = document.createElement('textarea');
                el.value = text;
                el.style.position = 'fixed';
                el.style.opacity = '0';
                document.body.appendChild(el);
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
                ok = true;
            } catch { /* give up silently */ }
        }
        if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2200);
        }
    };

    const expiresDays = latest
        ? Math.max(1, Math.round((new Date(latest.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : 7;

    return (
        <div style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Users size={11} />
                Invite collaborators (Editor access)
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 10, lineHeight: 1.5 }}>
                Share-by-URL above is read-only. Invitations grant edit access — recipients sign in, accept the invite, and the canvas appears in their library.
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input
                    type="email"
                    placeholder="Email (optional, for your records)"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                    style={{
                        flex: 1,
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 7,
                        padding: '8px 10px',
                        color: '#fff',
                        fontSize: 11,
                        outline: 'none',
                        fontFamily: 'Outfit, system-ui, sans-serif',
                    }}
                />
                <button
                    type="button"
                    onClick={handleCreate}
                    disabled={busy}
                    style={{
                        padding: '8px 12px',
                        borderRadius: 7,
                        background: 'rgba(16, 185, 129, 0.15)',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                        color: '#10b981',
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        opacity: busy ? 0.5 : 1,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {busy ? 'Creating…' : 'Get invite link'}
                </button>
            </div>
            {err && (
                <div style={{ color: '#fca5a5', fontSize: 11, marginTop: 4 }}>{err}</div>
            )}
            {latest && (
                <>
                    <div style={{
                        display: 'flex', gap: 6, alignItems: 'stretch',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 7,
                        padding: 3,
                    }}>
                        <div
                            style={{
                                flex: 1, minWidth: 0,
                                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                                fontSize: 10,
                                color: 'rgba(255,255,255,0.85)',
                                padding: '7px 9px',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                            title={latest.inviteUrl}
                        >
                            {latest.inviteUrl}
                        </div>
                        <button
                            type="button"
                            onClick={copyInvite}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                padding: '8px 12px',
                                borderRadius: 6,
                                background: copied ? 'rgba(16, 185, 129, 0.3)' : 'rgba(16, 185, 129, 0.12)',
                                color: copied ? '#ffffff' : '#10b981',
                                border: copied ? '1px solid rgba(16, 185, 129, 0.6)' : '1px solid transparent',
                                cursor: 'pointer',
                                fontSize: 11,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                transition: 'all 0.15s',
                            }}
                        >
                            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                        </button>
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 6 }}>
                        Expires in {expiresDays} day{expiresDays === 1 ? '' : 's'} · single-use
                    </div>
                </>
            )}
        </div>
    );
}

function ShareErrorBody({ reason, error, onRetry, canvasFilePath }: { reason: string; error?: string; onRetry: () => void; canvasFilePath: string | null }) {
    const title = {
        'unsaved': 'Save the canvas first',
        'auth-required': 'Sign in to share canvases',
        'read-failed': 'Could not read the canvas file',
        'upload-failed': 'Upload failed',
    }[reason] || 'Something went wrong';

    const body = {
        'unsaved': 'Sharing creates a cloud copy of your .klypix file. Save it once with Ctrl+S, then try sharing again.',
        'auth-required': 'Cloud sharing requires a KLYPIX account. Sign in below — the canvas will upload automatically when you do.',
        'read-failed': `The file at this path could not be read. It may have been moved or deleted: ${error || ''}`,
        'upload-failed': `The cloud upload didn't complete. ${error || 'Check your network and try again.'}`,
    }[reason] || error || 'Unknown error';

    return (
        <>
            <div style={{
                display: 'flex', gap: 12, alignItems: 'flex-start',
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 14,
            }}>
                <div style={{ color: '#f87171', flexShrink: 0, marginTop: 2 }}>
                    <AlertCircle size={15} />
                </div>
                <div>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{title}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>{body}</div>
                </div>
            </div>
            {reason === 'auth-required' && <InlineSignInForm onSignedIn={onRetry} />}
            {reason !== 'unsaved' && reason !== 'auth-required' && canvasFilePath && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        onClick={onRetry}
                        style={{
                            padding: '7px 14px',
                            borderRadius: 7,
                            background: 'rgba(16, 185, 129, 0.15)',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            color: '#10b981',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontWeight: 500,
                        }}
                    >
                        Retry
                    </button>
                </div>
            )}
        </>
    );
}

// Inline sign-in form rendered inside the Share modal when the upload
// failed with auth-required. Avoids routing the user to a full-screen
// LoginScreen — they sign in in-place, and on success the modal auto-retries
// the share. Email/password + Google OAuth covers 95% of cases; for more
// (sign up, license activation, password reset) the user can use the
// full settings flow after first sign-in.
function InlineSignInForm({ onSignedIn }: { onSignedIn: () => void }) {
    const auth = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [displayName, setDisplayName] = useState('');
    const [busy, setBusy] = useState(false);
    const [localErr, setLocalErr] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setLocalErr(null);
        setInfo(null);
        if (!email || !password || (mode === 'signup' && !displayName)) {
            setLocalErr('All fields required');
            return;
        }
        setBusy(true);
        try {
            const result = mode === 'signin'
                ? await auth.signIn(email, password)
                : await auth.signUp(email, password, displayName);
            if (result.success) {
                if ('needsEmailConfirmation' in result && result.needsEmailConfirmation) {
                    setInfo('Account created. Check your email to confirm, then sign in.');
                    setMode('signin');
                } else {
                    onSignedIn();
                }
            } else {
                setLocalErr(result.error || 'Sign in failed');
            }
        } catch (err: any) {
            setLocalErr(err?.message || 'Sign in failed');
        } finally {
            setBusy(false);
        }
    };

    const handleGoogle = async () => {
        setLocalErr(null);
        setInfo(null);
        setBusy(true);
        try {
            const result = await auth.signInWithGoogle();
            if (result.success) {
                onSignedIn();
            } else if (result.error) {
                setLocalErr(result.error);
            } else {
                setInfo('Continue sign-in in the browser window that just opened.');
            }
        } catch (err: any) {
            setLocalErr(err?.message || 'Google sign-in failed');
        } finally {
            setBusy(false);
        }
    };

    const inputStyle: React.CSSProperties = {
        width: '100%',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 7,
        padding: '8px 10px',
        color: '#fff',
        fontSize: 12,
        outline: 'none',
        fontFamily: 'Outfit, system-ui, sans-serif',
    };

    return (
        <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
                type="button"
                onClick={handleGoogle}
                disabled={busy}
                style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: 7,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: '#fff',
                    fontSize: 12,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.5 : 1,
                    fontWeight: 500,
                }}
            >
                Continue with Google
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(255,255,255,0.25)', fontSize: 10, margin: '2px 0' }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
                <span>or</span>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
            </div>
            {mode === 'signup' && (
                <input
                    type="text"
                    placeholder="Your name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={busy}
                    style={inputStyle}
                />
            )}
            <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                autoComplete="email"
                style={inputStyle}
            />
            <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                style={inputStyle}
            />
            {(localErr || auth.error) && (
                <div style={{ color: '#fca5a5', fontSize: 11, marginTop: 2 }}>{localErr || auth.error}</div>
            )}
            {info && (
                <div style={{ color: '#86efac', fontSize: 11, marginTop: 2 }}>{info}</div>
            )}
            <button
                type="submit"
                disabled={busy}
                style={{
                    padding: '9px 14px',
                    borderRadius: 7,
                    background: 'rgba(16, 185, 129, 0.85)',
                    border: '1px solid rgba(16, 185, 129, 1)',
                    color: '#fff',
                    fontSize: 12,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    opacity: busy ? 0.6 : 1,
                    marginTop: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                }}
            >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {mode === 'signin' ? 'Sign in & share' : 'Create account & share'}
            </button>
            <div style={{ textAlign: 'center', marginTop: 2 }}>
                <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMode(mode === 'signin' ? 'signup' : 'signin'); setLocalErr(null); setInfo(null); }}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'rgba(255,255,255,0.4)',
                        fontSize: 11,
                        cursor: 'pointer',
                        padding: 4,
                    }}
                >
                    {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
                </button>
            </div>
        </form>
    );
}
