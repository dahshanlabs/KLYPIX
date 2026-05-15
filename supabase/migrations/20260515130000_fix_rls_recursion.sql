-- Fix infinite recursion in canvas_collaborators / canvas_blobs RLS.
--
-- The original migration (20260515120000_canvas_collaborators.sql) added
-- cross-referencing policies:
--   - canvas_collaborators policies SELECT FROM canvas_blobs (to check owner)
--   - canvas_blobs policies SELECT FROM canvas_collaborators (to check membership)
-- Postgres evaluates RLS on each table when the other policy queries it,
-- triggering an infinite loop. Symptom: "infinite recursion detected in
-- policy for relation 'canvas_blobs'" on any INSERT/UPDATE to canvas_blobs.
--
-- Fix: introduce two SECURITY DEFINER helper functions that bypass RLS for
-- the inner lookup. The policies still enforce the same access rules; the
-- helper functions just break the recursion cycle.

-- =============================================================================
-- Drop the broken policies
-- =============================================================================

drop policy if exists "owner manages own canvas collaborators" on public.canvas_collaborators;
drop policy if exists "collaborator can read canvas blobs they're invited to" on public.canvas_blobs;
drop policy if exists "collaborator can update canvas blobs they're invited to" on public.canvas_blobs;
drop policy if exists "collaborator can read canvas storage objects" on storage.objects;
drop policy if exists "collaborator can replace canvas storage objects" on storage.objects;

-- =============================================================================
-- Helper functions (SECURITY DEFINER bypasses RLS on the inner table)
-- =============================================================================

create or replace function public.is_canvas_owner(p_blob_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.canvas_blobs
        where id = p_blob_id
          and owner_id = auth.uid()
    );
$$;

create or replace function public.is_canvas_collaborator(p_blob_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.canvas_collaborators
        where blob_id = p_blob_id
          and user_id = auth.uid()
    );
$$;

-- These are called from RLS policies, so anon + authenticated both need
-- execute. The functions themselves don't expose any data — they only
-- return a boolean — so granting widely is safe.
grant execute on function public.is_canvas_owner(uuid) to anon, authenticated;
grant execute on function public.is_canvas_collaborator(uuid) to anon, authenticated;

-- =============================================================================
-- Rebuild the policies using the helpers
-- =============================================================================

-- canvas_collaborators: owner manages all collaborators of canvases they own.
create policy "owner manages own canvas collaborators"
    on public.canvas_collaborators for all
    to authenticated
    using (public.is_canvas_owner(canvas_collaborators.blob_id))
    with check (public.is_canvas_owner(canvas_collaborators.blob_id));

-- canvas_blobs: collaborators can read + update blobs they're invited to.
create policy "collaborator can read canvas blobs they're invited to"
    on public.canvas_blobs for select
    to authenticated
    using (public.is_canvas_collaborator(canvas_blobs.id));

create policy "collaborator can update canvas blobs they're invited to"
    on public.canvas_blobs for update
    to authenticated
    using (public.is_canvas_collaborator(canvas_blobs.id))
    with check (public.is_canvas_collaborator(canvas_blobs.id));

-- storage.objects: same shape via canvas_collaborators membership. The
-- object name format is `<blob-id>.bin` (1:1 with canvas_blobs.id).
create policy "collaborator can read canvas storage objects"
    on storage.objects for select
    to authenticated
    using (
        bucket_id = 'canvases'
        and public.is_canvas_collaborator(
            (regexp_replace(storage.objects.name, '\.bin$', ''))::uuid
        )
    );

create policy "collaborator can replace canvas storage objects"
    on storage.objects for update
    to authenticated
    using (
        bucket_id = 'canvases'
        and public.is_canvas_collaborator(
            (regexp_replace(storage.objects.name, '\.bin$', ''))::uuid
        )
    );
