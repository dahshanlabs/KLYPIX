// IPC handlers for cloud canvas sync (Supabase-backed).
//
// Talks to Supabase on behalf of the renderer using the auth session that
// authService set up at sign-in. Never decrypts — the renderer encrypts
// before passing bytes here, and decrypts after receiving them. This file
// just moves opaque envelopes between the renderer and Supabase.
//
// Channels (renderer ↔ main, all return JSON-safe shapes):
//   canvas-cloud:upload              (envelope: Uint8Array, titleHint: string|null) → BlobMeta
//   canvas-cloud:replace             (id, envelope, titleHint)                       → BlobMeta
//   canvas-cloud:download            (id)                                            → Uint8Array
//   canvas-cloud:list                ()                                              → BlobMeta[]
//   canvas-cloud:delete              (id)                                            → void
//   canvas-cloud:create-share-token  (blobId)                                        → string  (the token)
//   canvas-cloud:create-invitation   (blobId, email?, titleHint?)                    → { token, inviteUrl, expiresAt }
//   canvas-cloud:list-invitations    (blobId)                                        → Invitation[]
//   canvas-cloud:revoke-invitation   (token)                                         → void
//   canvas-cloud:list-collaborators  (blobId)                                        → Collaborator[]
//   canvas-cloud:remove-collaborator (blobId, userId)                                → void
//   canvas-cloud:push-ops            (blobId, deviceId, ops[])                       → { seqs: number[] }
//   canvas-cloud:pull-ops            (blobId, sinceSeq)                              → OpRow[]
//   canvas-cloud:list-shared         ()                                              → SharedCanvas[]
//   canvas-cloud:leave-shared        (blobId)                                        → void
//
// All handlers throw on auth failure with a stable error code prefix so the
// renderer can show "please sign in" instead of generic "upload failed".

import { randomBytes } from 'node:crypto';
import type { IpcMain } from 'electron';
import { getSupabase } from './auth/supabaseClient';

const TABLE = 'canvas_blobs';
const TOKENS_TABLE = 'canvas_share_tokens';
const INVITATIONS_TABLE = 'canvas_invitations';
const COLLABORATORS_TABLE = 'canvas_collaborators';
const OPS_TABLE = 'canvas_ops';
const MESSAGES_TABLE = 'canvas_messages';
const BUCKET = 'canvases';
const INVITE_URL_HOST = 'https://klypix.com';
const INVITE_URL_PATH = '/invite/';

/**
 * Generate a URL-safe share token: 32 random bytes = 256 bits of entropy,
 * base64url-encoded → 43 chars. Same security property as a signed-URL
 * HMAC: knowing the token IS the permission.
 */
function generateShareToken(): string {
    return randomBytes(32).toString('base64url');
}

interface BlobMeta {
    id: string;
    title_hint: string | null;
    byte_size: number;
    created_at: string;
    updated_at: string;
}

class CloudAuthError extends Error {
    code = 'CLOUD_AUTH_REQUIRED' as const;
}

async function requireUserId(): Promise<string> {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
        throw new CloudAuthError('Cloud sync requires sign-in');
    }
    return data.user.id;
}

// Storage object name convention: <id>.bin. Keeps a 1:1 mapping with the
// metadata row's id so we never need a separate path column.
function objectName(id: string): string {
    return `${id}.bin`;
}

/**
 * Wire all canvas-cloud:* handlers onto the supplied ipcMain. Idempotent —
 * a second call replaces the previous handlers (electron's ipcMain.handle
 * throws on duplicate registration, so callers must not call this twice
 * without also calling removeHandlers first).
 */
export function registerCloudHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('canvas-cloud:upload', async (_e, envelope: Uint8Array, titleHint: string | null) => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const { data: row, error: insErr } = await supabase
            .from(TABLE)
            .insert({ owner_id: userId, title_hint: titleHint, byte_size: envelope.byteLength })
            .select('id, title_hint, byte_size, created_at, updated_at')
            .single();
        if (insErr || !row) throw new Error(`Cloud upload failed (metadata): ${insErr?.message ?? 'unknown'}`);
        const { error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(objectName(row.id), envelope, {
                contentType: 'application/octet-stream',
                upsert: false,
            });
        if (upErr) {
            // Roll back the metadata row so we don't leave an orphan.
            await supabase.from(TABLE).delete().eq('id', row.id);
            throw new Error(`Cloud upload failed (bytes): ${upErr.message}`);
        }
        return row as BlobMeta;
    });

    ipcMain.handle('canvas-cloud:replace', async (_e, id: string, envelope: Uint8Array, titleHint: string | null) => {
        await requireUserId(); // RLS does the real owner check
        const supabase = getSupabase();
        const { error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(objectName(id), envelope, {
                contentType: 'application/octet-stream',
                upsert: true,
            });
        if (upErr) throw new Error(`Cloud replace failed (bytes): ${upErr.message}`);
        const { data: row, error: rowErr } = await supabase
            .from(TABLE)
            .update({ title_hint: titleHint, byte_size: envelope.byteLength })
            .eq('id', id)
            .select('id, title_hint, byte_size, created_at, updated_at')
            .single();
        if (rowErr || !row) throw new Error(`Cloud replace failed (metadata): ${rowErr?.message ?? 'unknown'}`);
        return row as BlobMeta;
    });

    ipcMain.handle('canvas-cloud:download', async (_e, id: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase.storage.from(BUCKET).download(objectName(id));
        if (error || !data) throw new Error(`Cloud download failed: ${error?.message ?? 'no data'}`);
        // Blob → Uint8Array. arrayBuffer() is available on the storage Blob.
        const buf = await data.arrayBuffer();
        return new Uint8Array(buf);
    });

    ipcMain.handle('canvas-cloud:list', async () => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(TABLE)
            .select('id, title_hint, byte_size, created_at, updated_at')
            .eq('owner_id', userId)
            .order('updated_at', { ascending: false });
        if (error) throw new Error(`Cloud list failed: ${error.message}`);
        return (data ?? []) as BlobMeta[];
    });

    ipcMain.handle('canvas-cloud:delete', async (_e, id: string) => {
        await requireUserId();
        const supabase = getSupabase();
        // Delete the bytes first; if that succeeds but the metadata delete
        // fails, the row is harmless (storage object is gone, list will
        // still show it but download will return 404). Doing it in this
        // order is safer than the reverse — an orphan storage object that
        // RLS can't be queried for is much worse than an orphan metadata
        // row.
        const { error: rmErr } = await supabase.storage.from(BUCKET).remove([objectName(id)]);
        if (rmErr) throw new Error(`Cloud delete failed (bytes): ${rmErr.message}`);
        const { error: rowErr } = await supabase.from(TABLE).delete().eq('id', id);
        if (rowErr) throw new Error(`Cloud delete failed (metadata): ${rowErr.message}`);
    });

    // Mint a share token for a blob the caller owns. RLS does the real
    // ownership check (insert policy joins through canvas_blobs.owner_id).
    // Returns just the token string — the client builds the share URL.
    ipcMain.handle('canvas-cloud:create-share-token', async (_e, blobId: string) => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const token = generateShareToken();
        const { error } = await supabase
            .from(TOKENS_TABLE)
            .insert({ token, blob_id: blobId, created_by: userId });
        if (error) {
            // The most useful failure surface for callers: a clear "your
            // backend isn't set up" signal vs. a generic insert error.
            if (/relation .* does not exist/i.test(error.message)) {
                throw new Error(
                    `Share-tokens table missing. Apply migration 20260514120000_canvas_share_tokens.sql. ` +
                    `See docs/supabase-cloud-sync-setup.md.`
                );
            }
            throw new Error(`Create share token failed: ${error.message}`);
        }
        return token;
    });

    // ── Collaboration: invitations + collaborators ─────────────────────────

    // Create an invitation for a blob the caller owns. Returns the token,
    // a ready-to-share https URL, and the expiry. The recipient opens the
    // URL in a browser, signs in (or signs up), and is added as an editor.
    //
    // The keyB64 is the canvas encryption key — stored on the invitation
    // and copied to canvas_collaborators on accept so collaborators can
    // decrypt the cloud blob. See migration 20260515170000 for the E2E
    // trade-off this represents.
    ipcMain.handle('canvas-cloud:create-invitation', async (_e, args: { blobId: string; email?: string; titleHint?: string; keyB64?: string }) => {
        await requireUserId();
        const supabase = getSupabase();
        // Token is generated in Node and passed to the RPC (no pgcrypto dep).
        const token = generateShareToken();
        // 2026-05-30: route through create_canvas_invitation RPC, which
        // resolves the email → registered user (directed invite, surfaces in
        // their in-app inbox) or leaves it a link invite, atomically coalesces
        // duplicate invites, and enforces an audited rate limit. The RPC
        // returns a UNIFORM shape regardless of registered/unregistered so the
        // owner can't use it as an email-enumeration oracle.
        const { data, error } = await supabase.rpc('create_canvas_invitation', {
            p_blob_id: args.blobId,
            p_token: token,
            p_email: args.email || null,
            p_key_b64: args.keyB64 || null,
            p_title_hint: args.titleHint || null,
        });
        if (error) {
            const m = error.message || '';
            // CAPABILITY GATE, not silent fallback: if the RPC is missing the
            // server hasn't applied the hardening migration. We must NOT fall
            // back to the legacy direct INSERT — that would write key_b64 under
            // the un-hardened (leaky) RLS. Surface a clear "update the server".
            if (/function .*create_canvas_invitation.* does not exist|could not find the function|404|PGRST202/i.test(m)) {
                throw new Error('Collaboration features need a server update — apply migration 20260530120000_direct_email_invite.sql to Supabase.');
            }
            if (/P0003/.test(m)) throw new Error('Only the canvas owner can invite collaborators.');
            if (/P0005/.test(m)) throw new Error('You already own this canvas.');
            if (/P0008/.test(m)) throw new Error('Invite data too large.');
            if (/P0004/.test(m)) throw new Error('Invitation rate limit reached. Try again later.');
            if (/P0002/.test(m)) throw new Error('Canvas not found.');
            throw new Error(`Create invitation failed: ${m}`);
        }
        // RPC returns { ok, token, invite_url, expires_at } OR for an existing
        // collaborator { ok:true, already_member:true, token:null }.
        const row: any = data;
        if (row?.already_member) {
            return { alreadyMember: true, token: null, inviteUrl: null, expiresAt: null };
        }
        const outToken = row?.token ?? token;
        return {
            token: outToken,
            inviteUrl: row?.invite_url ?? `${INVITE_URL_HOST}${INVITE_URL_PATH}${outToken}`,
            expiresAt: row?.expires_at ?? null,
        };
    });

    // 2026-05-30: in-app inbox — list PENDING invitations addressed to the
    // current user (directed by user_id, OR link invites matching their
    // confirmed email so register-after-invite still surfaces). SECURITY
    // DEFINER RPC omits token + key_b64. Returns [] gracefully when signed
    // out / migration not applied so the dashboard never crashes.
    ipcMain.handle('canvas-cloud:list-pending-invitations', async () => {
        try {
            await requireUserId();
        } catch {
            return []; // not signed in → no inbox
        }
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('list_pending_invitations');
        if (error) {
            const m = error.message || '';
            // Auth expiry between getUser and rpc, or missing migration → [].
            if (/not authenticated|P0001|JWT|sign[-\s]?in|does not exist|404|PGRST202/i.test(m)) {
                return [];
            }
            throw new Error(`List pending invitations failed: ${m}`);
        }
        return Array.isArray(data) ? data : [];
    });

    // 2026-05-30: accept a DIRECTED invitation by its surrogate id (token-free).
    // The RPC binds acceptance to invitee_user_id === auth.uid(), so a leaked
    // id can't be redeemed by the wrong account.
    ipcMain.handle('canvas-cloud:accept-directed-invitation', async (_e, invitationId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('accept_directed_invitation', { p_invitation_id: invitationId });
        if (error) {
            const m = error.message || '';
            if (/P0007/.test(m)) throw new Error('This invitation was sent to a different account.');
            if (/P0002/.test(m)) throw new Error('This invitation is no longer valid (expired, declined, or already used).');
            if (/does not exist|404|PGRST202/i.test(m)) throw new Error('Server update required (migration 20260530120000).');
            throw new Error(`Accept invitation failed: ${m}`);
        }
        return { ok: true, data };
    });

    // 2026-05-30: decline a DIRECTED invitation. Link invites cannot be
    // declined (P0009) to avoid multi-recipient griefing.
    ipcMain.handle('canvas-cloud:decline-invitation', async (_e, invitationId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('decline_canvas_invitation', { p_invitation_id: invitationId });
        if (error) {
            const m = error.message || '';
            if (/P0006/.test(m)) throw new Error('This invitation was already accepted.');
            if (/P0009/.test(m)) throw new Error('Link invitations cannot be declined.');
            if (/P0007/.test(m)) throw new Error('Not your invitation.');
            if (/does not exist|404|PGRST202/i.test(m)) throw new Error('Server update required (migration 20260530120000).');
            throw new Error(`Decline invitation failed: ${m}`);
        }
        return { ok: true, data };
    });

    // List pending invitations for a canvas. RLS limits to invitations the
    // current user created (i.e. the owner's own outgoing invites).
    ipcMain.handle('canvas-cloud:list-invitations', async (_e, blobId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(INVITATIONS_TABLE)
            .select('token, invitee_email, invitee_user_id, created_at, expires_at, accepted_at, accepted_by, declined_at, declined_by')
            .eq('blob_id', blobId)
            .order('created_at', { ascending: false });
        if (error) throw new Error(`List invitations failed: ${error.message}`);
        return (data ?? []).map(row => ({
            ...row,
            inviteUrl: `${INVITE_URL_HOST}${INVITE_URL_PATH}${row.token}`,
        }));
    });

    // Revoke an invitation. Owners can revoke any invite they created;
    // RLS denies for non-owners.
    ipcMain.handle('canvas-cloud:revoke-invitation', async (_e, token: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { error } = await supabase
            .from(INVITATIONS_TABLE)
            .delete()
            .eq('token', token);
        if (error) throw new Error(`Revoke invitation failed: ${error.message}`);
    });

    // List current collaborators on a canvas. Owner-only view (RLS).
    //
    // Phase 17: prefers list_canvas_collaborators(p_blob_id) RPC which joins
    // auth.users to surface each collaborator's display name + email. Falls
    // back to the legacy direct SELECT for servers without the RPC.
    ipcMain.handle('canvas-cloud:list-collaborators', async (_e, blobId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        try {
            const { data, error } = await supabase.rpc('list_canvas_collaborators', { p_blob_id: blobId });
            if (error) {
                if (!/function .* does not exist|404/i.test(error.message)) throw error;
                // RPC missing → fall through
            } else {
                return Array.isArray(data) ? data : (data ?? []);
            }
        } catch (e: any) {
            if (!/function .* does not exist|404/i.test(e?.message ?? '')) {
                throw new Error(`List collaborators (rpc) failed: ${e.message}`);
            }
        }
        const { data: legacyData, error: legacyError } = await supabase
            .from(COLLABORATORS_TABLE)
            .select('user_id, role, accepted_at, invited_by')
            .eq('blob_id', blobId)
            .order('accepted_at', { ascending: false });
        if (legacyError) throw new Error(`List collaborators failed: ${legacyError.message}`);
        return legacyData ?? [];
    });

    // Remove a collaborator. Owner-only via RLS (the policy joins through
    // canvas_blobs.owner_id).
    ipcMain.handle('canvas-cloud:remove-collaborator', async (_e, args: { blobId: string; userId: string }) => {
        await requireUserId();
        const supabase = getSupabase();
        const { error } = await supabase
            .from(COLLABORATORS_TABLE)
            .delete()
            .eq('blob_id', args.blobId)
            .eq('user_id', args.userId);
        if (error) throw new Error(`Remove collaborator failed: ${error.message}`);
    });

    // Desktop-first invite handoff. The web invite page (klypix.com/invite/
    // <token>) can fire klypix://invite/<token>; main forwards the token
    // here via IPC. We call accept_canvas_invitation under the desktop's
    // currently signed-in session — guaranteeing the user accepts as the
    // SAME identity they're already operating under in the desktop.
    // Eliminates the browser-vs-desktop mismatch class of bug.
    ipcMain.handle('canvas-cloud:accept-invitation', async (_e, args: { token: string }) => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const token = (args?.token ?? '').trim();
        if (!token) throw new Error('Invitation token is required');
        const { data, error } = await supabase.rpc('accept_canvas_invitation', { p_token: token });
        if (error) {
            // Surface a friendlier error when the token's already been used —
            // common case when the user revisits a consumed link.
            if (/expired|revoked|already used|not found|no rows/i.test(error.message)) {
                throw new Error('This invitation is no longer valid (expired, revoked, or already used). Ask the sender for a new one.');
            }
            throw new Error(error.message);
        }
        // RPC returns the accepted canvas's blob_id + title + (newer servers)
        // inviter identity. Renderer uses this to toast "Joined <title>"
        // and refresh the library so the canvas appears immediately.
        return { ok: true, acceptedBy: userId, data };
    });

    // Transfer ownership of a canvas to one of the existing collaborators.
    // Owner-only — the RPC enforces ownership internally via auth.uid().
    // The old owner becomes a collaborator on the same canvas so they
    // don't lose access mid-transfer.
    ipcMain.handle('canvas-cloud:transfer-ownership', async (_e, args: { blobId: string; newOwnerId: string }) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('transfer_canvas_ownership', {
            p_blob_id: args.blobId,
            p_new_owner_id: args.newOwnerId,
        });
        if (error) {
            if (/function .* does not exist|404/i.test(error.message)) {
                throw new Error(
                    `transfer_canvas_ownership RPC missing. ` +
                    `Apply supabase/migrations/20260525170000_ownership_transfer.sql to your Supabase project.`
                );
            }
            throw new Error(error.message);
        }
        return data;
    });

    // ── Canvas DM persistence ────────────────────────────────────────────
    // Phase 21+ — message history that survives reload. RLS gates by
    // canvas membership; client only sees what it can already access via
    // canvas_collaborators / canvas_blobs.owner_id.

    ipcMain.handle('canvas-cloud:append-message', async (_e, args: { blobId: string; text: string }) => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const text = (args.text ?? '').trim();
        if (text.length === 0) return null;
        // Hard cap server-side too — protects against pathological clients.
        const capped = text.slice(0, 8000);
        const { data, error } = await supabase
            .from(MESSAGES_TABLE)
            .insert({ blob_id: args.blobId, author_id: userId, text: capped })
            .select('id, created_at')
            .single();
        if (error) {
            if (/relation .* does not exist|table .* does not exist/i.test(error.message)) {
                throw new Error(
                    `canvas_messages table missing. Apply ` +
                    `supabase/migrations/20260525180000_canvas_messages.sql to your Supabase project.`
                );
            }
            throw new Error(error.message);
        }
        return data;
    });

    // ── Clipboard sync ──────────────────────────────────────────────────
    // Phase 23 follow-up. Owner-only via RLS. Opt-in from the renderer
    // (Settings toggle); pinned items only.

    ipcMain.handle('clipboard-sync:push', async (_e, args: {
        kind: 'text' | 'image' | 'files' | 'html';
        text?: string;
        imageDataUrl?: string;
        filePaths?: string[];
        sourceApp?: string;
    }) => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from('clipboard_sync')
            .insert({
                user_id: userId,
                kind: args.kind,
                text: args.text ?? null,
                image_data_url: args.imageDataUrl ?? null,
                file_paths: args.filePaths ?? null,
                source_app: args.sourceApp ?? null,
            })
            .select('id')
            .single();
        if (error) {
            if (/relation .* does not exist/i.test(error.message)) {
                throw new Error(
                    `clipboard_sync table missing. Apply ` +
                    `supabase/migrations/20260525190000_clipboard_sync.sql.`
                );
            }
            throw new Error(error.message);
        }
        return data;
    });

    ipcMain.handle('clipboard-sync:pull', async () => {
        await requireUserId();
        const supabase = getSupabase();
        try {
            const { data, error } = await supabase
                .from('clipboard_sync')
                .select('id, kind, text, image_data_url, file_paths, source_app, captured_at')
                .gt('expires_at', new Date().toISOString())
                .order('captured_at', { ascending: false })
                .limit(100);
            if (error) {
                if (/relation .* does not exist/i.test(error.message)) return [];
                throw new Error(error.message);
            }
            return data ?? [];
        } catch (e: any) {
            if (/relation .* does not exist/i.test(e?.message ?? '')) return [];
            throw e;
        }
    });

    ipcMain.handle('clipboard-sync:remove', async (_e, id: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { error } = await supabase.from('clipboard_sync').delete().eq('id', id);
        if (error && !/relation .* does not exist/i.test(error.message)) {
            throw new Error(error.message);
        }
    });

    ipcMain.handle('canvas-cloud:list-messages', async (_e, args: { blobId: string; limit?: number }) => {
        await requireUserId();
        const supabase = getSupabase();
        try {
            const { data, error } = await supabase.rpc('list_canvas_messages', {
                p_blob_id: args.blobId,
                p_limit: args.limit ?? 200,
            });
            if (error) {
                if (/function .* does not exist|404/i.test(error.message)) return [];
                throw new Error(error.message);
            }
            return Array.isArray(data) ? data : (data ?? []);
        } catch (e: any) {
            if (/function .* does not exist|404/i.test(e?.message ?? '')) return [];
            throw e;
        }
    });

    // ── Sync: ops push/pull + "shared with me" listing ───────────────────

    // Push a batch of ops generated locally. Server assigns the seq numbers
    // (via the bigserial column) and returns them so the client can update
    // its high-water mark. RLS checks membership before allowing insert.
    ipcMain.handle('canvas-cloud:push-ops', async (_e, args: { blobId: string; deviceId: string; ops: any[] }) => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        if (!Array.isArray(args.ops) || args.ops.length === 0) return { seqs: [] };
        const rows = args.ops.map(op => ({
            blob_id: args.blobId,
            author_id: userId,
            device_id: args.deviceId,
            op,
        }));
        const { data, error } = await supabase
            .from(OPS_TABLE)
            .insert(rows)
            .select('seq');
        if (error) {
            if (/relation .* does not exist/i.test(error.message)) {
                throw new Error(`Ops table missing. Apply migration 20260515150000_canvas_ops.sql.`);
            }
            throw new Error(`Push ops failed: ${error.message}`);
        }
        return { seqs: (data ?? []).map(r => r.seq as number) };
    });

    // Fast-forward helper: returns the current max(seq) for a blob without
    // pulling the rows. Used by useOpSync on initial mount to advance the
    // local sinceSeq past everything the blob's snapshot already
    // includes — prevents the historical-replay race that wiped live
    // typing on a fresh install (when localStorage sinceSeq starts at 0
    // and pullOps would otherwise re-apply every op ever recorded).
    ipcMain.handle('canvas-cloud:get-op-head', async (_e, args: { blobId: string }) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(OPS_TABLE)
            .select('seq')
            .eq('blob_id', args.blobId)
            .order('seq', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            // Missing table / RLS denial → treat as "no ops yet"; the
            // client can proceed without fast-forward and the existing
            // pull-ops path still works.
            if (/relation .* does not exist|0 rows|not found/i.test(error.message)) {
                return { headSeq: 0 };
            }
            throw new Error(`Get op head failed: ${error.message}`);
        }
        return { headSeq: data?.seq ?? 0 };
    });

    // Pull ops since a seq high-water mark. Limited to 500 ops per call
    // so the client can paginate on very-stale canvases without OOM.
    ipcMain.handle('canvas-cloud:pull-ops', async (_e, args: { blobId: string; sinceSeq: number }) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(OPS_TABLE)
            .select('seq, blob_id, author_id, device_id, op, created_at')
            .eq('blob_id', args.blobId)
            .gt('seq', args.sinceSeq ?? 0)
            .order('seq', { ascending: true })
            .limit(500);
        if (error) throw new Error(`Pull ops failed: ${error.message}`);
        return data ?? [];
    });

    // List canvases the current user is a collaborator on (the "Shared with
    // me" desktop UI calls this). Owner-side canvases come from a different
    // query (canvas_blobs filtered by owner_id) — this RPC is just for
    // collaborator-side membership.
    //
    // Phase 18: prefers list_shared_canvases() RPC which joins auth.users to
    // surface the inviter's display name + email. Falls back to the legacy
    // direct SELECT when the RPC isn't deployed yet (older servers / first
    // run after upgrade).
    ipcMain.handle('canvas-cloud:list-shared', async () => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        try {
            const { data, error } = await supabase.rpc('list_shared_canvases');
            if (error) {
                if (!/function .* does not exist|404/i.test(error.message)) throw error;
                // RPC missing → fall through to legacy path
            } else {
                return Array.isArray(data) ? data : (data ?? []);
            }
        } catch (e: any) {
            if (!/function .* does not exist|404/i.test(e?.message ?? '')) {
                throw new Error(`List shared canvases (rpc) failed: ${e.message}`);
            }
        }
        const { data: legacyData, error: legacyError } = await supabase
            .from(COLLABORATORS_TABLE)
            .select('blob_id, role, accepted_at, key_b64, canvas_blobs(title_hint, byte_size, updated_at)')
            .eq('user_id', userId)
            .order('accepted_at', { ascending: false });
        if (legacyError) throw new Error(`List shared canvases failed: ${legacyError.message}`);
        return legacyData ?? [];
    });

    // Remove the caller from a canvas that was shared with them ("leave"
    // from the recipient side). Calls the leave_canvas RPC which deletes
    // the caller's canvas_collaborators row under SECURITY DEFINER — the
    // recipient has no direct DELETE policy on that table by design.
    //
    // The locally-downloaded copy under userData/shared-canvases/ is left
    // on disk intentionally — same model as Drive/Notion. If the user wants
    // the file gone too they can delete it themselves; this RPC only unlinks
    // the server-side membership.
    ipcMain.handle('canvas-cloud:leave-shared', async (_e, blobId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { error } = await supabase.rpc('leave_canvas', { p_blob_id: blobId });
        if (error) {
            if (/function .* does not exist/i.test(error.message)) {
                throw new Error(
                    `leave_canvas RPC missing. Apply migration 20260515180000_leave_canvas.sql. ` +
                    `See docs/supabase-cloud-sync-setup.md.`
                );
            }
            throw new Error(`Leave shared canvas failed: ${error.message}`);
        }
    });

    // ── Phase 13: server-side spend tracking ────────────────────────────
    // Tracks daily agent USD spend in agent_usage so the localStorage-
    // edit bypass of the daily budget cap is closed. Both RPCs return
    // null when the user is signed out (RPC requires authenticated role).

    ipcMain.handle('agent-usage:record', async (_e, args: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheHitTokens?: number;
        costUsd: number;
    }) => {
        try {
            await requireUserId();
        } catch {
            return { ok: false, dailyTotal: null, error: 'not signed in' };
        }
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('record_agent_usage', {
            p_model: args.model,
            p_input_tokens: args.inputTokens | 0,
            p_output_tokens: args.outputTokens | 0,
            p_cache_hit_tokens: (args.cacheHitTokens ?? 0) | 0,
            p_cost_usd: args.costUsd,
        });
        if (error) {
            // RPC not yet deployed → fall back to local-only (renderer
            // already has localStorage tracking). Don't throw — agent
            // run should not fail because of telemetry plumbing.
            if (/function .* does not exist/i.test(error.message)) {
                return { ok: false, dailyTotal: null, error: 'rpc not deployed' };
            }
            return { ok: false, dailyTotal: null, error: error.message };
        }
        return { ok: true, dailyTotal: Number(data ?? 0) };
    });

    ipcMain.handle('agent-usage:get-daily-spend', async () => {
        try {
            await requireUserId();
        } catch {
            return { dailyTotal: null };
        }
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('get_daily_spend');
        if (error) return { dailyTotal: null };
        return { dailyTotal: Number(data ?? 0) };
    });
}
