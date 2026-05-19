-- Phase 18: identity surfacing on invitations.
--
-- The invite acceptance flow knew the inviter's user_id (canvas_invitations.invited_by)
-- but never surfaced their display name / email to the invitee. Real two-PC test feedback:
-- the invitee saw an "anonymous canvas" with no idea who shared it.
--
-- This migration adds two things, both under SECURITY DEFINER + RLS-safe so anon callers
-- can only get identity data tied to a valid invitation token they hold:
--
--   1. get_invitation_preview(p_token) — public, anon-callable. Returns the invitation
--      preview (title hint, blob id) PLUS the inviter's display name + email. Used by
--      the web /invite/<token> page so the recipient knows who invited them BEFORE
--      they click Accept.
--
--   2. accept_canvas_invitation(p_token) is updated to include the inviter's identity
--      in its return payload, so the desktop can persist "Shared by Alice (alice@ex.com)"
--      into the local cloudShareStore for later display in the Shared-with-me UI.

create or replace function public.get_invitation_preview(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    invitation record;
    inviter_user record;
    blob_title text;
begin
    select * into invitation
    from public.canvas_invitations
    where token = p_token
      and accepted_at is null
      and expires_at > now();

    if invitation is null then
        -- Don't leak whether the token ever existed — return null so the
        -- caller renders a generic "Invitation expired or invalid" state.
        return null;
    end if;

    -- Look up inviter's identity. Display name lives in user_metadata under
    -- 'full_name' (set by Google OAuth / passed by Klypix signup); fall
    -- back to email-prefix if absent so we always have *something* to show.
    select id, email, raw_user_meta_data
    into inviter_user
    from auth.users
    where id = invitation.invited_by;

    return json_build_object(
        'blob_id', invitation.blob_id,
        'title_hint', invitation.title_hint,
        'expires_at', invitation.expires_at,
        'invitee_email', invitation.invitee_email,
        'inviter_email', inviter_user.email,
        'inviter_display_name',
            coalesce(
                inviter_user.raw_user_meta_data->>'full_name',
                inviter_user.raw_user_meta_data->>'name',
                split_part(coalesce(inviter_user.email, ''), '@', 1)
            )
    );
end;
$$;

-- Anyone (incl. signed-out web visitors hitting /invite/<token>) can call this,
-- but they need the token in-hand. Tokens are random + single-use + expire, so
-- this is effectively as gated as the URL itself.
grant execute on function public.get_invitation_preview(text) to anon, authenticated;


-- Refresh accept_canvas_invitation to include the inviter's identity in its
-- return payload. Desktop can then persist "Shared by Alice" alongside the
-- blobId + key in cloudShareStore so the chip stays visible after restart.

drop function if exists public.accept_canvas_invitation(text);

create function public.accept_canvas_invitation(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    invitation record;
    inviter_user record;
    current_user_id uuid := auth.uid();
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;

    select * into invitation
    from public.canvas_invitations
    where token = p_token
      and accepted_at is null
      and expires_at > now()
    for update;

    if invitation is null then
        raise exception 'Invitation not found, expired, or already used' using errcode = 'P0002';
    end if;

    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at, key_b64)
    values (invitation.blob_id, current_user_id, 'editor', invitation.invited_by, now(), invitation.key_b64)
    on conflict (blob_id, user_id) do update
        set key_b64 = coalesce(public.canvas_collaborators.key_b64, invitation.key_b64);

    update public.canvas_invitations
    set accepted_at = now(),
        accepted_by = current_user_id
    where token = p_token;

    select id, email, raw_user_meta_data
    into inviter_user
    from auth.users
    where id = invitation.invited_by;

    return json_build_object(
        'blob_id', invitation.blob_id,
        'title_hint', invitation.title_hint,
        'key_b64', invitation.key_b64,
        'inviter_email', inviter_user.email,
        'inviter_display_name',
            coalesce(
                inviter_user.raw_user_meta_data->>'full_name',
                inviter_user.raw_user_meta_data->>'name',
                split_part(coalesce(inviter_user.email, ''), '@', 1)
            )
    );
end;
$$;

grant execute on function public.accept_canvas_invitation(text) to authenticated;


-- list_shared_canvases — replaces the desktop's direct SELECT on
-- canvas_collaborators with an RPC that also resolves the inviter's
-- identity. Anon callers can't reach auth.users directly under RLS,
-- so we wrap the join in a SECURITY DEFINER function gated by auth.uid().
create or replace function public.list_shared_canvases()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    result json;
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;

    select coalesce(json_agg(row), '[]'::json)
    into result
    from (
        select
            c.blob_id,
            c.role,
            c.accepted_at,
            c.key_b64,
            json_build_object(
                'title_hint', b.title_hint,
                'byte_size', b.byte_size,
                'updated_at', b.updated_at
            ) as canvas_blobs,
            json_build_object(
                'user_id', c.invited_by,
                'email', u.email,
                'display_name', coalesce(
                    u.raw_user_meta_data->>'full_name',
                    u.raw_user_meta_data->>'name',
                    split_part(coalesce(u.email, ''), '@', 1)
                )
            ) as invited_by
        from public.canvas_collaborators c
        left join public.canvas_blobs b on b.id = c.blob_id
        left join auth.users u on u.id = c.invited_by
        where c.user_id = current_user_id
        order by c.accepted_at desc
    ) row;

    return result;
end;
$$;

grant execute on function public.list_shared_canvases() to authenticated;

