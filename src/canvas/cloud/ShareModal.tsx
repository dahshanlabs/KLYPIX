import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Copy, Check, AlertCircle, X, Loader2, Cloud, Users, Mail } from 'lucide-react';
import { shareCurrentCanvas, type ShareResult } from './shareCurrentCanvas';
import { getCloudShare } from './cloudShareStore';
import { useAuth } from '../../components/AuthProvider';
import { t } from '../../i18n/strings';

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
                    fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
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
                            <div style={{ fontSize: 15, fontWeight: 600 }}>{t('share.title')}</div>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>
                                {t('share.e2e')}
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
                        title={t('canvas.close_esc')}
                        aria-label={t('share.close_dialog')}
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

function ShareReadyBody({ share, copied, onCopy, onUpdate, isNew }: { share: { shareUrl: string; lastPushedAt: number; blobId: string; keyB64: string }; copied: boolean; onCopy: (url: string) => void; onUpdate: () => void; isNew: boolean; }) {
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
            <PeopleWithAccessSection blobId={share.blobId} />
        </>
    );
}

// ── Unified "People with access" panel (2026-05-30) ───────────────────────
// Merges the former separate "collaborators" + "pending invitations" sections
// into one list, OneDrive/Figma-style:
//   • Accepted collaborators (green) — owner can Remove.
//   • Pending invites (amber, "Pending · expires in Nd") — owner can copy the
//     link or Revoke. Hidden if that email already appears as a collaborator
//     (they accepted — no point showing both).
//   • Declined invites — folded into a collapsed "Declined (N)" disclosure so
//     they don't clutter but stay auditable.
// Owner-only (listCollaborators throws under RLS for non-owners → render
// nothing). Polls every 8s so "they just accepted/declined" ripples in.
interface AccessCollab { user_id: string; role: string; accepted_at: string; email?: string | null; display_name?: string | null; }
interface AccessInvite { token: string; invitee_email: string | null; invitee_user_id?: string | null; created_at: string; expires_at: string; accepted_at: string | null; declined_at?: string | null; inviteUrl: string; }

function PeopleWithAccessSection({ blobId }: { blobId: string }) {
    const [collabs, setCollabs] = useState<AccessCollab[]>([]);
    const [invites, setInvites] = useState<AccessInvite[]>([]);
    const [denied, setDenied] = useState(false);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [revoking, setRevoking] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [showDeclined, setShowDeclined] = useState(false);
    const [tick, setTick] = useState(0);
    const bump = () => setTick(n => n + 1);

    useEffect(() => {
        if (!blobId) return;
        let cancelled = false;
        const cloud: any = (window as any).electron?.cloud;
        if (!cloud?.listCollaborators) return;
        const fetchAll = async () => {
            if (cancelled) return;
            try {
                const [c, inv] = await Promise.all([
                    cloud.listCollaborators(blobId),
                    cloud.listInvitations ? cloud.listInvitations(blobId) : Promise.resolve([]),
                ]);
                if (cancelled) return;
                setCollabs(Array.isArray(c) ? c : []);
                setInvites(Array.isArray(inv) ? inv : []);
                setDenied(false);
            } catch (e: any) {
                const msg = e?.message || String(e);
                if (/not the canvas owner|Not authenticated|CLOUD_AUTH_REQUIRED/i.test(msg)) {
                    setDenied(true); cancelled = true; // never allowed → stop
                }
            }
        };
        void fetchAll();
        const id = window.setInterval(fetchAll, 8_000);
        return () => { cancelled = true; window.clearInterval(id); };
    }, [blobId, tick]);

    const remove = async (userId: string, name: string) => {
        if (!window.confirm(t('canvas.collab_peer.remove_confirm').replace('{name}', name))) return;
        const cloud: any = (window as any).electron?.cloud;
        if (!cloud?.removeCollaborator) return;
        setRemovingId(userId);
        try {
            await cloud.removeCollaborator({ blobId, userId });
            setCollabs(prev => prev.filter(r => r.user_id !== userId));
        } catch (e: any) {
            window.alert(`${t('canvas.collab_peer.remove_failed')} — ${e?.message || String(e)}`);
        } finally { setRemovingId(null); bump(); }
    };

    const revoke = async (token: string) => {
        const cloud: any = (window as any).electron?.cloud;
        if (!cloud?.revokeInvitation) return;
        setRevoking(token);
        try {
            await cloud.revokeInvitation(token);
            setInvites(prev => prev.filter(r => r.token !== token));
        } catch (e: any) {
            window.alert(`${t('share.pending_revoke')} — ${e?.message || String(e)}`);
        } finally { setRevoking(null); bump(); }
    };

    const copyLink = async (url: string) => {
        try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(c => c === url ? null : c), 2000); } catch { /* swallow */ }
    };

    if (denied) return null;

    const now = Date.now();
    const collabEmails = new Set(collabs.map(c => (c.email || '').toLowerCase()).filter(Boolean));
    const pending = invites.filter(i =>
        !i.accepted_at && !i.declined_at && new Date(i.expires_at).getTime() > now
        && !(i.invitee_email && collabEmails.has(i.invitee_email.toLowerCase()))
    );
    const declined = invites.filter(i => !!i.declined_at);

    const total = collabs.length + pending.length;
    if (total === 0 && declined.length === 0) return null;

    return (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Users size={11} />
                {t('share.people_with_access').replace('{n}', String(total))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Accepted collaborators */}
                {collabs.map((r) => {
                    const name = r.display_name || r.email || r.user_id.slice(0, 12);
                    const subtitle = r.display_name && r.email ? r.email : null;
                    return (
                        <div key={`c-${r.user_id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                            <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#10b98155', color: '#10b981', fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <bdi>{(name || '?').slice(0, 1).toUpperCase()}</bdi>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><bdi>{name}</bdi></div>
                                {subtitle && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><bdi>{subtitle}</bdi></div>}
                            </div>
                            <span style={{ fontSize: 9, color: '#10b981', textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0 }}>{t('share.access_editor')}</span>
                            <button type="button" onClick={() => remove(r.user_id, name)} disabled={removingId === r.user_id} title={t('canvas.collab_peer.remove')}
                                style={{ padding: '4px 8px', borderRadius: 5, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', cursor: removingId === r.user_id ? 'not-allowed' : 'pointer', opacity: removingId === r.user_id ? 0.5 : 1, fontSize: 10, display: 'flex', alignItems: 'center' }}>
                                <X size={11} />
                            </button>
                        </div>
                    );
                })}
                {/* Pending invites */}
                {pending.map((r) => {
                    const expiresDays = Math.max(0, Math.round((new Date(r.expires_at).getTime() - now) / 86_400_000));
                    return (
                        <div key={`p-${r.token}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                            <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(245,158,11,0.18)', color: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <Mail size={11} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    <bdi>{r.invitee_email || t('share.pending_no_recipient')}</bdi>
                                </div>
                                <div style={{ fontSize: 10, color: '#f59e0b' }}>
                                    {t('share.access_pending')} · {t('share.pending_expires_in').replace('{n}', String(expiresDays))}
                                </div>
                            </div>
                            <button type="button" onClick={() => copyLink(r.inviteUrl)} title={t('share.pending_copy_link')}
                                style={{ padding: '4px 8px', borderRadius: 5, background: copied === r.inviteUrl ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: copied === r.inviteUrl ? '#fff' : 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 10 }}>
                                {copied === r.inviteUrl ? <Check size={11} /> : <Copy size={11} />}
                            </button>
                            <button type="button" onClick={() => revoke(r.token)} disabled={revoking === r.token} title={t('share.pending_revoke')}
                                style={{ padding: '4px 8px', borderRadius: 5, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', cursor: revoking === r.token ? 'not-allowed' : 'pointer', opacity: revoking === r.token ? 0.5 : 1, fontSize: 10 }}>
                                <X size={11} />
                            </button>
                        </div>
                    );
                })}
            </div>
            {/* Declined — collapsed disclosure */}
            {declined.length > 0 && (
                <div style={{ marginTop: 8 }}>
                    <button type="button" onClick={() => setShowDeclined(s => !s)}
                        style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: 10, cursor: 'pointer', padding: '2px 0' }}>
                        {showDeclined ? '▾' : '▸'} {t('share.declined_disclosure').replace('{n}', String(declined.length))}
                    </button>
                    {showDeclined && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                            {declined.map((r) => (
                                <div key={`d-${r.token}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6, opacity: 0.6 }}>
                                    <X size={10} style={{ color: 'rgba(255,255,255,0.35)', flexShrink: 0 }} />
                                    <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        <bdi>{r.invitee_email || t('share.pending_no_recipient')}</bdi>
                                    </div>
                                    <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>{t('share.access_declined')}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}


// ── Invite collaborators (Phase 7) ────────────────────────────────────────
// Sender mints a single-use invite link; recipient opens it in a browser,
// signs in, and gets added as an editor on the canvas. The link is separate
// from the share URL because share URLs grant read-only via the canvas_share_tokens
// table; invitations grant read-write via canvas_collaborators.

// Raw IPC return shape — any field may be null (e.g. already-member returns
// all-null + alreadyMember:true).
interface InviteResult {
    token: string | null;
    inviteUrl: string | null;
    expiresAt: string | null;
    /** 2026-05-30: set when the typed email already belongs to a collaborator
     *  on this canvas. The owner sees a neutral "already has access" note
     *  instead of a (pointless) new link. */
    alreadyMember?: boolean;
}

// Per-email outcome after a batch invite. The IPC returns a uniform shape
// (no registered-vs-not signal, by anti-enumeration design) so we can only
// distinguish: link created, already a member, or failed.
interface InviteOutcome {
    email: string;
    status: 'invited' | 'already' | 'failed';
    inviteUrl?: string;
    error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Invite collaborators — multi-email pill input (2026-05-30) ─────────────
// OneDrive/Figma-style: type or paste emails, comma/space/Enter tokenizes each
// into a pill (invalid ones flagged red), then one "Invite N" button fires all
// of them in parallel. Registered Klypix users get the invite in their in-app
// inbox; for everyone a copy/mailto link is surfaced per result (we have no
// server mailer, and can't tell registered from not without leaking an
// enumeration oracle). Owner can add more emails any time the modal is open.
function InviteCollaboratorsSection({ share }: { share: { blobId: string; keyB64: string } }) {
    // Pills = committed email tokens; draft = what's currently being typed.
    const [emails, setEmails] = useState<string[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [outcomes, setOutcomes] = useState<InviteOutcome[]>([]);
    const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

    // Commit the draft (and anything pasted with separators) into pills.
    // Dedupes case-insensitively against existing pills. Keeps an invalid
    // fragment in the draft so the user can fix it rather than losing it.
    const commitDraft = (raw: string, { keepTail }: { keepTail: boolean }) => {
        const parts = raw.split(/[\s,;]+/);
        const tail = keepTail ? (parts.pop() ?? '') : '';
        const additions: string[] = [];
        for (const p of parts) {
            const e = p.trim().toLowerCase();
            if (!e) continue;
            if (emails.includes(e) || additions.includes(e)) continue;
            additions.push(e);
        }
        if (additions.length) setEmails(prev => [...prev, ...additions]);
        setDraft(tail);
    };

    const onDraftChange = (v: string) => {
        // If the user typed/pasted a separator, tokenize everything before it.
        if (/[\s,;]/.test(v)) commitDraft(v, { keepTail: true });
        else setDraft(v);
    };

    const onDraftKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' || e.key === ',' || e.key === ' ' || e.key === ';') {
            e.preventDefault();
            commitDraft(draft + (e.key === 'Enter' ? '' : e.key), { keepTail: false });
        } else if (e.key === 'Backspace' && draft === '' && emails.length > 0) {
            // Backspace on empty draft pops the last pill (standard token UX).
            setEmails(prev => prev.slice(0, -1));
        }
    };

    const removePill = (idx: number) => setEmails(prev => prev.filter((_, i) => i !== idx));

    // Fold any leftover valid draft into the pill set, then return the full
    // list of valid emails to invite.
    const collectValidEmails = (): string[] => {
        const all = [...emails];
        const d = draft.trim().toLowerCase();
        if (d && !all.includes(d)) all.push(d);
        return all.filter(e => EMAIL_RE.test(e));
    };

    const anyInvalid = [...emails, ...(draft.trim() ? [draft.trim().toLowerCase()] : [])]
        .some(e => !EMAIL_RE.test(e));
    const validCount = collectValidEmails().length;

    const handleInviteAll = async () => {
        const targets = collectValidEmails();
        if (targets.length === 0) return;
        setBusy(true);
        setOutcomes([]);
        const bridge: any = (window as any).electron?.cloud;
        // Fire all invites in parallel; one failure never blocks the rest.
        const settled = await Promise.allSettled(targets.map(async (em): Promise<InviteOutcome> => {
            if (!bridge?.createInvitation) return { email: em, status: 'failed', error: 'Invite IPC unavailable' };
            try {
                const res: InviteResult = await bridge.createInvitation({
                    blobId: share.blobId,
                    email: em,
                    keyB64: share.keyB64,
                });
                if (res?.alreadyMember || (!res?.inviteUrl && !res?.token)) {
                    return { email: em, status: 'already' };
                }
                return { email: em, status: 'invited', inviteUrl: res.inviteUrl ?? undefined };
            } catch (e: any) {
                return { email: em, status: 'failed', error: e?.message || 'Failed' };
            }
        }));
        const results = settled.map(s => s.status === 'fulfilled'
            ? s.value
            : { email: '?', status: 'failed' as const, error: 'Unexpected error' });
        setOutcomes(results);
        // Clear the pills that succeeded or were already members; keep failed
        // ones so the user can retry without re-typing.
        const failedEmails = new Set(results.filter(r => r.status === 'failed').map(r => r.email));
        setEmails(prev => prev.filter(e => failedEmails.has(e)));
        setDraft(d => (failedEmails.has(d.trim().toLowerCase()) ? d : ''));
        setBusy(false);
    };

    const copyOne = async (url: string) => {
        try { await navigator.clipboard.writeText(url); setCopiedUrl(url); setTimeout(() => setCopiedUrl(c => c === url ? null : c), 2000); }
        catch { /* swallow */ }
    };

    const mailtoOne = (em: string, url: string) => {
        const subject = t('share.email_subject');
        const body = t('share.email_body').replace('{url}', url);
        const murl = `mailto:${encodeURIComponent(em)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        const electron: any = (window as any).electron;
        if (electron?.openExternal) { try { electron.openExternal(murl); return; } catch { /* fall through */ } }
        try { window.open(murl, '_blank'); } catch { /* swallow */ }
    };

    return (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Users size={11} />
                {t('share.invite_section')}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 10, lineHeight: 1.5 }}>
                {t('share.invite_desc')}
            </div>

            {/* Pill input: pills + inline draft field share one bordered box. */}
            <div
                onClick={(e) => { (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus(); }}
                style={{
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 7, padding: '6px 7px', marginBottom: 8, cursor: 'text',
                }}
            >
                {emails.map((em, i) => {
                    const valid = EMAIL_RE.test(em);
                    return (
                        <span key={`${em}-${i}`} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            fontSize: 11, padding: '3px 6px 3px 8px', borderRadius: 999,
                            background: valid ? 'rgba(16,185,129,0.14)' : 'rgba(239,68,68,0.14)',
                            border: '1px solid ' + (valid ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.35)'),
                            color: valid ? '#10b981' : '#fca5a5',
                        }} title={valid ? em : `${em} — not a valid email`}>
                            <bdi style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{em}</bdi>
                            <button type="button" onClick={(ev) => { ev.stopPropagation(); removePill(i); }}
                                style={{ display: 'flex', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, opacity: 0.7 }}>
                                <X size={11} />
                            </button>
                        </span>
                    );
                })}
                <input
                    type="text"
                    inputMode="email"
                    placeholder={emails.length === 0 ? t('share.email_placeholder') : ''}
                    value={draft}
                    onChange={(e) => onDraftChange(e.target.value)}
                    onKeyDown={onDraftKeyDown}
                    onBlur={() => { if (draft.trim()) commitDraft(draft, { keepTail: false }); }}
                    disabled={busy}
                    style={{
                        flex: 1, minWidth: 120,
                        background: 'transparent', border: 'none', outline: 'none',
                        color: '#fff', fontSize: 11,
                        fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                        padding: '3px 2px',
                    }}
                />
            </div>

            <button
                type="button"
                onClick={handleInviteAll}
                disabled={busy || validCount === 0}
                style={{
                    width: '100%', padding: '9px 12px', borderRadius: 7,
                    background: validCount > 0 ? 'rgba(16, 185, 129, 0.18)' : 'rgba(255,255,255,0.04)',
                    border: '1px solid ' + (validCount > 0 ? 'rgba(16, 185, 129, 0.35)' : 'rgba(255,255,255,0.08)'),
                    color: validCount > 0 ? '#10b981' : 'rgba(255,255,255,0.4)',
                    fontSize: 12, fontWeight: 600,
                    cursor: (busy || validCount === 0) ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
            >
                {busy
                    ? <><Loader2 size={13} className="animate-spin" /> {t('share.creating')}</>
                    : validCount > 1
                        ? t('share.invite_n_people').replace('{n}', String(validCount))
                        : t('share.invite_one_person')}
            </button>
            {anyInvalid && (
                <div style={{ color: '#fca5a5', fontSize: 10, marginTop: 6 }}>
                    {t('share.invite_invalid_email')}
                </div>
            )}

            {/* Per-email results after a batch send. */}
            {outcomes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 }}>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
                        {t('share.invite_inapp_note')}
                    </div>
                    {outcomes.map((o, i) => (
                        <div key={`${o.email}-${i}`} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 8px', borderRadius: 6,
                            background: 'rgba(255,255,255,0.03)',
                        }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    <bdi>{o.email}</bdi>
                                </div>
                                <div style={{
                                    fontSize: 10,
                                    color: o.status === 'failed' ? '#fca5a5' : o.status === 'already' ? 'rgba(255,255,255,0.45)' : '#10b981',
                                }}>
                                    {o.status === 'invited' && t('share.invite_status_sent')}
                                    {o.status === 'already' && t('share.already_has_access')}
                                    {o.status === 'failed' && (o.error || 'Failed')}
                                </div>
                            </div>
                            {o.status === 'invited' && o.inviteUrl && (
                                <>
                                    <button type="button" onClick={() => copyOne(o.inviteUrl!)} title={t('share.pending_copy_link')}
                                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', borderRadius: 5, background: copiedUrl === o.inviteUrl ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: copiedUrl === o.inviteUrl ? '#fff' : 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 10 }}>
                                        {copiedUrl === o.inviteUrl ? <Check size={11} /> : <Copy size={11} />}
                                    </button>
                                    <button type="button" onClick={() => mailtoOne(o.email, o.inviteUrl!)} title={t('share.email_send_hint')}
                                        style={{ display: 'flex', alignItems: 'center', padding: '5px 8px', borderRadius: 5, background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', cursor: 'pointer', fontSize: 10 }}>
                                        <Mail size={11} />
                                    </button>
                                </>
                            )}
                        </div>
                    ))}
                </div>
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

    const handleOAuth = async (provider: 'google' | 'microsoft') => {
        setLocalErr(null);
        setInfo(null);
        setBusy(true);
        try {
            const result = provider === 'google'
                ? await auth.signInWithGoogle()
                : await auth.signInWithMicrosoft();
            if (result.success) {
                onSignedIn();
            } else if (result.error) {
                setLocalErr(result.error);
            } else {
                setInfo('Continue sign-in in the browser window that just opened.');
            }
        } catch (err: any) {
            setLocalErr(err?.message || `${provider} sign-in failed`);
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
        fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
    };

    return (
        <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
                type="button"
                onClick={() => handleOAuth('google')}
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
            <button
                type="button"
                onClick={() => handleOAuth('microsoft')}
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
                Continue with Microsoft
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
