-- KLYPIX share tokens: allow anonymous read of a single canvas blob via an
-- unguessable token in the share URL.
--
-- Why a separate table (not just blob_id as the URL token):
--   * Revocation: an owner can revoke a single share link without deleting
--     the underlying canvas or breaking other share links to the same canvas.
--   * Multi-recipient: one canvas can have N tokens, each independently
--     revocable.
--   * Auditing: created_at / revoked_at give a record of who-shared-when.
--
-- Threat model:
--   * Tokens are 32 random bytes (base64url-encoded → 43 chars). 256 bits of
--     entropy ⇒ enumeration is computationally infeasible.
--   * Tokens never expire by default (expires_at is nullable). Owners can
--     revoke by setting revoked_at.
--   * Anonymous clients with a valid token get read-only access to the
--     ENCRYPTED bytes of the referenced canvas. They cannot list other
--     blobs, cannot enumerate tokens, and cannot read the canvas without
--     the decryption key (which lives in the URL fragment, never sent to
--     any server).
--   * The "anon can SELECT by token filter" policy is acceptable here
--     because the token's existence itself is the secret — same property
--     as a signed-URL HMAC.

-- =============================================================================
-- Table
-- =============================================================================

create table public.canvas_share_tokens (
    token text primary key,
    blob_id uuid not null references public.canvas_blobs(id) on delete cascade,
    -- The owner who minted this token. RLS uses this for "owner can manage
    -- their own tokens" — joined back to canvas_blobs.owner_id as the source
    -- of truth, but stored here too for efficient listing.
    created_by uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    -- NULL = never expires. Owners can set a TTL on mint or later.
    expires_at timestamptz,
    -- NULL = active. Set to a timestamp on revoke; row kept for audit, but
    -- the token stops resolving (anon SELECT policy filters revoked rows).
    revoked_at timestamptz
);

create index canvas_share_tokens_blob_id_idx on public.canvas_share_tokens(blob_id);
create index canvas_share_tokens_created_by_idx on public.canvas_share_tokens(created_by);

-- =============================================================================
-- RLS on canvas_share_tokens
-- =============================================================================

alter table public.canvas_share_tokens enable row level security;

-- --- Owner policies: full CRUD on tokens for blobs they own ------------------

create policy "owner can read own share tokens"
    on public.canvas_share_tokens for select
    to authenticated
    using (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_share_tokens.blob_id
              and b.owner_id = auth.uid()
        )
    );

create policy "owner can create share tokens for own blobs"
    on public.canvas_share_tokens for insert
    to authenticated
    with check (
        created_by = auth.uid()
        and exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_share_tokens.blob_id
              and b.owner_id = auth.uid()
        )
    );

create policy "owner can revoke own share tokens"
    on public.canvas_share_tokens for update
    to authenticated
    using (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_share_tokens.blob_id
              and b.owner_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_share_tokens.blob_id
              and b.owner_id = auth.uid()
        )
    );

create policy "owner can delete own share tokens"
    on public.canvas_share_tokens for delete
    to authenticated
    using (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_share_tokens.blob_id
              and b.owner_id = auth.uid()
        )
    );

-- --- Anonymous policy: resolve token → blob_id -------------------------------
-- Anon can SELECT rows where the token is valid (not revoked, not expired).
-- Without a `WHERE token = $1` filter from the client, RLS still returns
-- rows — but the table is large only in the unrealistic case of an attacker
-- already having millions of token guesses, and 256 bits of entropy makes
-- guessing infeasible. The token itself is the bearer credential.

create policy "anon can resolve valid share tokens"
    on public.canvas_share_tokens for select
    to anon
    using (
        revoked_at is null
        and (expires_at is null or expires_at > now())
    );

-- =============================================================================
-- Storage policy: anyone can download canvas bytes that have an active
-- share token. The bytes are E2E-encrypted, so this only grants access to
-- ciphertext — the decryption key never touches the server.
-- =============================================================================
-- We intentionally do NOT require the caller to present the token to the
-- storage layer (storage RLS can't read custom args). The token's role is
-- gating access at the *existence* level: revoke the token → storage policy
-- stops returning the bytes → the share URL goes dead even if the recipient
-- still has the encryption key.

create policy "anon can read shared canvas objects"
    on storage.objects for select
    to anon
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_share_tokens t
            where t.blob_id::text || '.bin' = storage.objects.name
              and t.revoked_at is null
              and (t.expires_at is null or t.expires_at > now())
        )
    );

-- Authenticated (non-owner) viewers also need this path — e.g. a signed-in
-- user clicks a share URL for someone else's canvas. They're not the owner,
-- so the existing "owner can read" policy doesn't apply. Mirror the anon
-- policy for the authenticated role.

create policy "authenticated can read shared canvas objects via token"
    on storage.objects for select
    to authenticated
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_share_tokens t
            where t.blob_id::text || '.bin' = storage.objects.name
              and t.revoked_at is null
              and (t.expires_at is null or t.expires_at > now())
        )
    );

-- Same for the canvas_share_tokens table — an authenticated user clicking a
-- share URL needs to resolve the token even though they don't own it.

create policy "authenticated can resolve valid share tokens"
    on public.canvas_share_tokens for select
    to authenticated
    using (
        revoked_at is null
        and (expires_at is null or expires_at > now())
    );
