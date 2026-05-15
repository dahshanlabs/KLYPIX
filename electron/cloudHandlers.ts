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
        const userId = await requireUserId();
        const supabase = getSupabase();
        const token = generateShareToken();
        const { data, error } = await supabase
            .from(INVITATIONS_TABLE)
            .insert({
                token,
                blob_id: args.blobId,
                invited_by: userId,
                invitee_email: args.email || null,
                title_hint: args.titleHint || null,
                key_b64: args.keyB64 || null,
            })
            .select('expires_at')
            .single();
        if (error || !data) {
            if (/relation .* does not exist/i.test(error?.message || '')) {
                throw new Error(
                    `Invitations table missing. Apply migration 20260515120000_canvas_collaborators.sql. ` +
                    `See docs/supabase-cloud-sync-setup.md.`
                );
            }
            throw new Error(`Create invitation failed: ${error?.message ?? 'unknown'}`);
        }
        return {
            token,
            inviteUrl: `${INVITE_URL_HOST}${INVITE_URL_PATH}${token}`,
            expiresAt: data.expires_at,
        };
    });

    // List pending invitations for a canvas. RLS limits to invitations the
    // current user created (i.e. the owner's own outgoing invites).
    ipcMain.handle('canvas-cloud:list-invitations', async (_e, blobId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(INVITATIONS_TABLE)
            .select('token, invitee_email, created_at, expires_at, accepted_at, accepted_by')
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
    ipcMain.handle('canvas-cloud:list-collaborators', async (_e, blobId: string) => {
        await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(COLLABORATORS_TABLE)
            .select('user_id, role, accepted_at, invited_by')
            .eq('blob_id', blobId)
            .order('accepted_at', { ascending: false });
        if (error) throw new Error(`List collaborators failed: ${error.message}`);
        return data ?? [];
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
    // Includes key_b64 (the canvas encryption key, copied from the invitation
    // on accept) so the desktop can decrypt the cloud blob without a separate
    // RPC round-trip.
    ipcMain.handle('canvas-cloud:list-shared', async () => {
        const userId = await requireUserId();
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from(COLLABORATORS_TABLE)
            .select('blob_id, role, accepted_at, key_b64, canvas_blobs(title_hint, byte_size, updated_at)')
            .eq('user_id', userId)
            .order('accepted_at', { ascending: false });
        if (error) throw new Error(`List shared canvases failed: ${error.message}`);
        return data ?? [];
    });
}
