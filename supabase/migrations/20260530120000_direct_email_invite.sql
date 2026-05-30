-- ============================================================================
-- Migration: 20260530120000_direct_email_invite.sql
-- Direct email invite (identity-bound) + in-app inbox + decline + RLS hardening.
-- Consolidates the direct-invite feature AND the P1 invitation-RLS security fix.
-- Token is generated in Node (electron/cloudHandlers.ts) and passed in as
-- p_token, so NO pgcrypto/gen_random_bytes dependency is introduced here.
-- ============================================================================

-- 1. SCHEMA: surrogate id (for token-free directed accept), directed binding,
--    decline columns. token stays the PK for back-compat with the link path.
alter table public.canvas_invitations
    add column if not exists id uuid not null default gen_random_uuid(),
    add column if not exists invitee_user_id uuid references auth.users(id) on delete set null,
    add column if not exists declined_at timestamptz,
    add column if not exists declined_by uuid references auth.users(id) on delete set null;

create unique index if not exists canvas_invitations_id_uniq
    on public.canvas_invitations(id);

-- Inbox query index.
create index if not exists canvas_invitations_invitee_user_id_idx
    on public.canvas_invitations(invitee_user_id)
    where accepted_at is null and declined_at is null;

-- RACE FIX (reviewer): atomic double-invite coalesce. FOR UPDATE locks nothing
-- when no row matches, so the SELECT-then-INSERT approach duplicates under
-- concurrency. This partial unique index makes ON CONFLICT the serialization point.
create unique index if not exists canvas_invitations_pending_directed_uniq
    on public.canvas_invitations(blob_id, invitee_user_id)
    where invitee_user_id is not null and accepted_at is null and declined_at is null;

-- Anti-enumeration audit table: counts ALL resolution attempts (incl. coalesce,
-- already_member, self) so re-probing the same email isn't unmetered.
create table if not exists public.canvas_invite_attempts (
    id bigserial primary key,
    inviter_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now()
);
create index if not exists canvas_invite_attempts_inviter_idx
    on public.canvas_invite_attempts(inviter_id, created_at);

-- ============================================================================
-- 2. RLS HARDENING (P0/P1): drop the filter-less anon SELECT that leaks key_b64
-- + invitee_email of EVERY live invitation. NO replacement row policy that
-- exposes key_b64 (column-level RLS doesn't exist in Postgres). The inbox reads
-- only via list_pending_invitations() (SECURITY DEFINER, omits key_b64).
-- ============================================================================
drop policy if exists "anyone with the token can resolve an invitation" on public.canvas_invitations;
-- "inviter manages own invitations" (invited_by = auth.uid()) is UNCHANGED and
-- still governs owner create/list/revoke + covers the new columns in list-invitations.

-- ============================================================================
-- 3. get_invitation_preview — DROP+RECREATE (return-type clash with returns json
-- means CREATE OR REPLACE would abort). Stop returning invitee_email (PII).
-- Sole anon path for the web /invite page after the policy drop.
-- ============================================================================
drop function if exists public.get_invitation_preview(text);
create function public.get_invitation_preview(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare invitation record; inviter_user record;
begin
    select * into invitation from public.canvas_invitations
    where token = p_token and accepted_at is null and declined_at is null and expires_at > now();
    if invitation is null then return null; end if;
    select id, email, raw_user_meta_data into inviter_user from auth.users where id = invitation.invited_by;
    return json_build_object(
        'blob_id', invitation.blob_id,
        'title_hint', invitation.title_hint,
        'expires_at', invitation.expires_at,
        'inviter_email', inviter_user.email,
        'inviter_display_name', coalesce(
            inviter_user.raw_user_meta_data->>'full_name',
            inviter_user.raw_user_meta_data->>'name',
            split_part(coalesce(inviter_user.email,''),'@',1)));
end; $$;
grant execute on function public.get_invitation_preview(text) to anon, authenticated;

-- ============================================================================
-- 4. accept_canvas_invitation — DROP+RECREATE: honor declined_at + bind directed
-- invites to invitee_user_id (link path stays token-only).
-- ============================================================================
drop function if exists public.accept_canvas_invitation(text);
create function public.accept_canvas_invitation(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare invitation record; inviter_user record; current_user_id uuid := auth.uid();
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    select * into invitation from public.canvas_invitations
    where token = p_token and accepted_at is null and declined_at is null and expires_at > now() for update;
    if invitation is null then raise exception 'Invitation not found, expired, declined, or already used' using errcode='P0002'; end if;
    -- SECURITY: a directed invite can only be accepted by the targeted account.
    if invitation.invitee_user_id is not null and invitation.invitee_user_id <> current_user_id then
        raise exception 'This invitation was sent to a different account' using errcode='P0007';
    end if;
    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at, key_b64)
    values (invitation.blob_id, current_user_id, 'editor', invitation.invited_by, now(), invitation.key_b64)
    on conflict (blob_id, user_id) do update set key_b64 = coalesce(public.canvas_collaborators.key_b64, invitation.key_b64);
    update public.canvas_invitations set accepted_at = now(), accepted_by = current_user_id where token = p_token;
    select id, email, raw_user_meta_data into inviter_user from auth.users where id = invitation.invited_by;
    return json_build_object('blob_id', invitation.blob_id, 'title_hint', invitation.title_hint, 'key_b64', invitation.key_b64,
        'inviter_email', inviter_user.email,
        'inviter_display_name', coalesce(inviter_user.raw_user_meta_data->>'full_name', inviter_user.raw_user_meta_data->>'name', split_part(coalesce(inviter_user.email,''),'@',1)));
end; $$;
grant execute on function public.accept_canvas_invitation(text) to authenticated;

-- ============================================================================
-- 5. create_canvas_invitation — server-side resolution; uniform output (no
-- directed/link oracle); audited rate limit; token generated in Node.
-- ============================================================================
create or replace function public.create_canvas_invitation(
    p_blob_id uuid, p_token text, p_email text, p_key_b64 text, p_title_hint text default null)
returns json language plpgsql security definer set search_path = public as $$
declare current_user_id uuid := auth.uid(); blob_owner uuid; v_email text := nullif(lower(trim(p_email)),'');
    matched_user uuid; v_expires timestamptz := now() + interval '7 days'; recent int; v_token text;
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    if length(coalesce(p_key_b64,'')) > 512 or length(coalesce(p_title_hint,'')) > 256 then
        raise exception 'Invite data too large' using errcode='P0008'; end if;
    select owner_id into blob_owner from public.canvas_blobs where id = p_blob_id;
    if blob_owner is null then raise exception 'Canvas not found' using errcode='P0002'; end if;
    if blob_owner <> current_user_id then raise exception 'Not the canvas owner' using errcode='P0003'; end if;
    -- Audited rate limit counts ALL attempts (incl. early returns below).
    insert into public.canvas_invite_attempts(inviter_id) values (current_user_id);
    select count(*) into recent from public.canvas_invite_attempts
    where inviter_id = current_user_id and created_at > now() - interval '1 hour';
    if recent > 20 then raise exception 'Invitation rate limit reached. Try again later.' using errcode='P0004'; end if;
    if v_email is not null then
        select id into matched_user from auth.users
        where lower(email) = v_email and email_confirmed_at is not null and id <> current_user_id limit 1;
    end if;
    if matched_user is not null and matched_user = blob_owner then
        raise exception 'You already own this canvas' using errcode='P0005'; end if;
    if matched_user is not null and exists (
        select 1 from public.canvas_collaborators where blob_id = p_blob_id and user_id = matched_user) then
        return json_build_object('ok', true, 'already_member', true, 'token', null); end if;
    -- Atomic coalesce via the partial unique index; refresh key/expiry on conflict.
    insert into public.canvas_invitations (token, blob_id, invited_by, invitee_email, invitee_user_id, title_hint, key_b64, expires_at)
    values (p_token, p_blob_id, current_user_id, v_email, matched_user, p_title_hint, p_key_b64, v_expires)
    on conflict (blob_id, invitee_user_id) where (invitee_user_id is not null and accepted_at is null and declined_at is null)
    do update set key_b64 = excluded.key_b64, title_hint = coalesce(excluded.title_hint, public.canvas_invitations.title_hint),
        expires_at = excluded.expires_at, created_at = now()
    returning token, expires_at into v_token, v_expires;
    return json_build_object('ok', true, 'token', v_token, 'invite_url', 'https://klypix.com/invite/' || v_token, 'expires_at', v_expires);
end; $$;
grant execute on function public.create_canvas_invitation(uuid, text, text, text, text) to authenticated;

-- ============================================================================
-- 6. list_pending_invitations — inbox; confirmed-email gated; no token, no key_b64;
-- includes register-after-invite link rows matching the caller's own email.
-- ============================================================================
create or replace function public.list_pending_invitations()
returns json language plpgsql security definer set search_path = public as $$
declare current_user_id uuid := auth.uid(); my_email text; result json;
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    select lower(email) into my_email from auth.users where id = current_user_id and email_confirmed_at is not null;
    if my_email is null then return '[]'::json; end if;
    select coalesce(json_agg(r order by r.created_at desc), '[]'::json) into result from (
        select i.id as invitation_id, i.blob_id, i.title_hint, i.created_at, i.expires_at,
            json_build_object('user_id', i.invited_by,
                'display_name', coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(coalesce(u.email,''),'@',1)),
                'masked_email', regexp_replace(coalesce(u.email,''), '(^.).*(@.*$)', '\1***\2')) as invited_by
        from public.canvas_invitations i left join auth.users u on u.id = i.invited_by
        where (i.invitee_user_id = current_user_id or (i.invitee_user_id is null and lower(i.invitee_email) = my_email))
          and i.accepted_at is null and i.declined_at is null and i.expires_at > now()
          and not exists (select 1 from public.canvas_collaborators c where c.blob_id = i.blob_id and c.user_id = current_user_id)
    ) r;
    return result;
end; $$;
grant execute on function public.list_pending_invitations() to authenticated;

-- ============================================================================
-- 7. accept_directed_invitation — token-free, id+invitee bound.
-- ============================================================================
create or replace function public.accept_directed_invitation(p_invitation_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare invitation record; inviter_user record; current_user_id uuid := auth.uid();
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    select * into invitation from public.canvas_invitations
    where id = p_invitation_id and accepted_at is null and declined_at is null and expires_at > now() for update;
    if invitation is null then raise exception 'Invitation not found, expired, declined, or already used' using errcode='P0002'; end if;
    if invitation.invitee_user_id is null or invitation.invitee_user_id <> current_user_id then
        raise exception 'This invitation was sent to a different account' using errcode='P0007'; end if;
    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at, key_b64)
    values (invitation.blob_id, current_user_id, 'editor', invitation.invited_by, now(), invitation.key_b64)
    on conflict (blob_id, user_id) do update set key_b64 = coalesce(public.canvas_collaborators.key_b64, invitation.key_b64);
    update public.canvas_invitations set accepted_at = now(), accepted_by = current_user_id where id = p_invitation_id;
    select id, email, raw_user_meta_data into inviter_user from auth.users where id = invitation.invited_by;
    return json_build_object('blob_id', invitation.blob_id, 'title_hint', invitation.title_hint, 'key_b64', invitation.key_b64,
        'inviter_email', inviter_user.email,
        'inviter_display_name', coalesce(inviter_user.raw_user_meta_data->>'full_name', inviter_user.raw_user_meta_data->>'name', split_part(coalesce(inviter_user.email,''),'@',1)));
end; $$;
grant execute on function public.accept_directed_invitation(uuid) to authenticated;

-- ============================================================================
-- 8. decline_canvas_invitation — directed-only (no multi-recipient link griefing).
-- ============================================================================
create or replace function public.decline_canvas_invitation(p_invitation_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare invitation record; current_user_id uuid := auth.uid();
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    select * into invitation from public.canvas_invitations where id = p_invitation_id for update;
    if invitation is null then raise exception 'Invitation not found' using errcode='P0002'; end if;
    if invitation.invitee_user_id is null then raise exception 'Link invitations cannot be declined' using errcode='P0009'; end if;
    if invitation.invitee_user_id <> current_user_id then raise exception 'Not your invitation' using errcode='P0007'; end if;
    if invitation.accepted_at is not null then raise exception 'Invitation already accepted' using errcode='P0006'; end if;
    update public.canvas_invitations set declined_at = coalesce(declined_at, now()), declined_by = coalesce(declined_by, current_user_id)
    where id = p_invitation_id;
    return json_build_object('ok', true, 'blob_id', invitation.blob_id);
end; $$;
grant execute on function public.decline_canvas_invitation(uuid) to authenticated;

-- ============================================================================
-- 9. transfer_canvas_ownership — deterministic, non-null key copy + consume
-- the old owner's outstanding pending invitations for this blob.
-- ============================================================================
create or replace function public.transfer_canvas_ownership(p_blob_id uuid, p_new_owner_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare current_user_id uuid := auth.uid(); blob_owner uuid; is_collab boolean; v_key text;
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    if p_new_owner_id is null then raise exception 'New owner is required' using errcode='P0002'; end if;
    if current_user_id = p_new_owner_id then raise exception 'You are already the owner' using errcode='P0003'; end if;
    select owner_id into blob_owner from public.canvas_blobs where id = p_blob_id for update;
    if blob_owner is null then raise exception 'Canvas not found' using errcode='P0004'; end if;
    if blob_owner <> current_user_id then raise exception 'Only the current owner can transfer ownership' using errcode='P0005'; end if;
    select exists(select 1 from public.canvas_collaborators where blob_id = p_blob_id and user_id = p_new_owner_id) into is_collab;
    if not is_collab then raise exception 'New owner must already be a collaborator on this canvas' using errcode='P0006'; end if;
    -- Deterministic, non-null key for the demoted owner.
    select c.key_b64 into v_key from public.canvas_collaborators c
    where c.blob_id = p_blob_id and c.key_b64 is not null order by c.accepted_at limit 1;
    if v_key is null then raise exception 'No usable canvas key found for transfer' using errcode='P0007'; end if;
    update public.canvas_blobs set owner_id = p_new_owner_id where id = p_blob_id;
    delete from public.canvas_collaborators where blob_id = p_blob_id and user_id = p_new_owner_id;
    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at, key_b64)
    values (p_blob_id, current_user_id, 'editor', p_new_owner_id, now(), v_key) on conflict (blob_id, user_id) do nothing;
    -- Reassign management of pending invites so they aren't orphaned/zombie.
    update public.canvas_invitations set invited_by = p_new_owner_id
    where blob_id = p_blob_id and accepted_at is null and declined_at is null;
    return json_build_object('ok', true, 'new_owner_id', p_new_owner_id, 'former_owner_id', current_user_id);
end; $$;
grant execute on function public.transfer_canvas_ownership(uuid, uuid) to authenticated;

-- ============================================================================
-- 10. leave_canvas — also consume the leaver's pending invites for the blob to
-- prevent leave-then-reaccept resurrection.
-- ============================================================================
create or replace function public.leave_canvas(p_blob_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare current_user_id uuid := auth.uid();
begin
    if current_user_id is null then raise exception 'Not authenticated' using errcode='P0001'; end if;
    delete from public.canvas_collaborators where blob_id = p_blob_id and user_id = current_user_id;
    update public.canvas_invitations set declined_at = now(), declined_by = current_user_id
    where blob_id = p_blob_id and invitee_user_id = current_user_id and accepted_at is null and declined_at is null;
end; $$;
grant execute on function public.leave_canvas(uuid) to authenticated;