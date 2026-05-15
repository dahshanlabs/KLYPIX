-- Phase 7 backend: invite-based team collab.
--
-- Two new tables alongside the existing canvas_blobs + canvas_share_tokens:
--
--   canvas_collaborators — who can edit a canvas (rows: canvas_id, user_id, role)
--   canvas_invitations  — pending invites (token-keyed, accepted on click)
--
-- Permissioning chain:
--   owner          → full CRUD via canvas_blobs.owner_id (already in place)
--   collaborator   → SELECT + UPDATE on canvas_blobs (added here)
--   share-by-URL   → anon SELECT-only via canvas_share_tokens (already in place)
--   no access      → blocked by RLS default deny
--
-- Threat model:
--   Owners decide who's a collaborator. Invitations expire (default 7 days)
--   and are single-use. Acceptance requires an authenticated session, so
--   anonymous URL-poking can't escalate to write access. Tokens are 32
--   random bytes (base64url, 256 bits of entropy).

-- =============================================================================
-- canvas_collaborators
-- =============================================================================

create table public.canvas_collaborators (
    blob_id uuid not null references public.canvas_blobs(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    -- 'editor' covers everything except deleting the canvas and managing
    -- collaborators. Roles list is intentionally short for v1; 'viewer'
    -- can come later if we need it (today, share-by-URL covers viewer).
    role text not null default 'editor' check (role in ('editor')),
    invited_by uuid references auth.users(id) on delete set null,
    accepted_at timestamptz not null default now(),
    primary key (blob_id, user_id)
);

create index canvas_collaborators_user_id_idx on public.canvas_collaborators(user_id);
create index canvas_collaborators_blob_id_idx on public.canvas_collaborators(blob_id);

-- =============================================================================
-- canvas_invitations
-- =============================================================================

create table public.canvas_invitations (
    token text primary key,
    blob_id uuid not null references public.canvas_blobs(id) on delete cascade,
    -- The user who created the invitation. RLS uses this for "owner can see
    -- and revoke their own invites."
    invited_by uuid not null references auth.users(id) on delete cascade,
    -- Optional hint shown on the accept page ("Alice invited you to..."), and
    -- on the owner's own invitation list. Email-shaped string by convention;
    -- we don't validate format because invites can also be by-link-only with
    -- no recipient hint at all (NULL).
    invitee_email text,
    -- Plain-text title hint shown on the accept page so recipients see what
    -- they're joining before authenticating. Matches canvas_blobs.title_hint.
    title_hint text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '7 days'),
    -- Once an invite is accepted, mark it consumed (single-use). We keep the
    -- row for audit instead of deleting — handy for "who joined when" history.
    accepted_at timestamptz,
    accepted_by uuid references auth.users(id) on delete set null
);

create index canvas_invitations_blob_id_idx on public.canvas_invitations(blob_id);
create index canvas_invitations_invited_by_idx on public.canvas_invitations(invited_by);

-- =============================================================================
-- RLS on canvas_collaborators
-- =============================================================================

alter table public.canvas_collaborators enable row level security;

-- Owners can see + manage all collaborators of their canvases.
create policy "owner manages own canvas collaborators"
    on public.canvas_collaborators for all
    to authenticated
    using (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_collaborators.blob_id
              and b.owner_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_collaborators.blob_id
              and b.owner_id = auth.uid()
        )
    );

-- Collaborators can see their own membership rows (so a client can answer
-- "what canvases am I a member of?"). They can't see other collaborators.
create policy "collaborator reads own membership rows"
    on public.canvas_collaborators for select
    to authenticated
    using (user_id = auth.uid());

-- =============================================================================
-- RLS on canvas_invitations
-- =============================================================================

alter table public.canvas_invitations enable row level security;

-- Inviter can do anything with their own invitations.
create policy "inviter manages own invitations"
    on public.canvas_invitations for all
    to authenticated
    using (invited_by = auth.uid())
    with check (invited_by = auth.uid());

-- Anyone (anon + authenticated) can read a SINGLE invitation row when they
-- present the token. We don't allow listing — the invitation token IS the
-- bearer credential. Same security property as canvas_share_tokens.
create policy "anyone with the token can resolve an invitation"
    on public.canvas_invitations for select
    to anon, authenticated
    using (
        accepted_at is null
        and expires_at > now()
    );

-- =============================================================================
-- EXTEND canvas_blobs RLS so collaborators can read + update the canvas
-- =============================================================================

create policy "collaborator can read canvas blobs they're invited to"
    on public.canvas_blobs for select
    to authenticated
    using (
        exists (
            select 1 from public.canvas_collaborators c
            where c.blob_id = canvas_blobs.id
              and c.user_id = auth.uid()
        )
    );

create policy "collaborator can update canvas blobs they're invited to"
    on public.canvas_blobs for update
    to authenticated
    using (
        exists (
            select 1 from public.canvas_collaborators c
            where c.blob_id = canvas_blobs.id
              and c.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.canvas_collaborators c
            where c.blob_id = canvas_blobs.id
              and c.user_id = auth.uid()
        )
    );

-- =============================================================================
-- EXTEND storage policies so collaborators can read + write the bytes
-- =============================================================================

create policy "collaborator can read canvas storage objects"
    on storage.objects for select
    to authenticated
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_collaborators c
            join public.canvas_blobs b on b.id = c.blob_id
            where b.id::text || '.bin' = storage.objects.name
              and c.user_id = auth.uid()
        )
    );

create policy "collaborator can replace canvas storage objects"
    on storage.objects for update
    to authenticated
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_collaborators c
            join public.canvas_blobs b on b.id = c.blob_id
            where b.id::text || '.bin' = storage.objects.name
              and c.user_id = auth.uid()
        )
    );

-- =============================================================================
-- Helper: accept an invitation atomically (resolve token + insert collaborator
-- + mark accepted, all in one transaction). Avoids race-condition where two
-- clients accept the same single-use invite simultaneously.
-- =============================================================================

create or replace function public.accept_canvas_invitation(p_token text)
returns table (blob_id uuid, title_hint text)
language plpgsql
security definer
set search_path = public
as $$
declare
    invitation record;
    current_user_id uuid := auth.uid();
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;

    -- Lock the invitation row to serialize concurrent accepts.
    select * into invitation
    from public.canvas_invitations
    where token = p_token
      and accepted_at is null
      and expires_at > now()
    for update;

    if invitation is null then
        raise exception 'Invitation not found, expired, or already used' using errcode = 'P0002';
    end if;

    -- Inserter is the current authenticated user. Idempotent if the user was
    -- already a collaborator (on conflict do nothing).
    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at)
    values (invitation.blob_id, current_user_id, 'editor', invitation.invited_by, now())
    on conflict (blob_id, user_id) do nothing;

    update public.canvas_invitations
    set accepted_at = now(),
        accepted_by = current_user_id
    where token = p_token;

    return query select invitation.blob_id, invitation.title_hint;
end;
$$;

grant execute on function public.accept_canvas_invitation(text) to authenticated;
