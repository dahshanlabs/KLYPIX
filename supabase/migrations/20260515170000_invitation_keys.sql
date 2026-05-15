-- Phase 7 sync prep: store the canvas decryption key alongside collaborators
-- so the server can deliver it to authorized users.
--
-- Architectural note — this is a deliberate E2E trade-off for team collab:
--   * Share-by-URL canvases remain fully E2E. The key lives only in the
--     recipient's URL fragment; the server never sees it.
--   * Invite-based canvases relax E2E to "trust Supabase with the key for
--     this canvas." Same model as Notion / Linear / Figma — the server can
--     read shared workspaces but RLS gates who's allowed to read each.
--
-- The trade-off is needed because an authenticated collaborator (e.g. Bob)
-- has no out-of-band way to receive Alice's encryption key. The only place
-- to put it is server-side, behind RLS.

alter table public.canvas_invitations
    add column if not exists key_b64 text;

alter table public.canvas_collaborators
    add column if not exists key_b64 text;

-- accept_canvas_invitation now copies the key from the invitation row onto
-- the collaborator row (so revoking a collaborator deletes their key copy
-- atomically) and returns it to the accepting client so the desktop can
-- start decrypting immediately.

drop function if exists public.accept_canvas_invitation(text);

create function public.accept_canvas_invitation(p_token text)
returns json
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

    select * into invitation
    from public.canvas_invitations
    where token = p_token
      and accepted_at is null
      and expires_at > now()
    for update;

    if invitation is null then
        raise exception 'Invitation not found, expired, or already used' using errcode = 'P0002';
    end if;

    -- Insert or update the collaborator row. ON CONFLICT branch handles
    -- re-acceptance (e.g. invitation revoked-then-re-issued for the same
    -- user) by overwriting an absent key with the new one. We never blow
    -- away an existing key — the canvas key is stable per-canvas.
    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at, key_b64)
    values (invitation.blob_id, current_user_id, 'editor', invitation.invited_by, now(), invitation.key_b64)
    on conflict (blob_id, user_id) do update
        set key_b64 = coalesce(public.canvas_collaborators.key_b64, invitation.key_b64);

    update public.canvas_invitations
    set accepted_at = now(),
        accepted_by = current_user_id
    where token = p_token;

    return json_build_object(
        'blob_id', invitation.blob_id,
        'title_hint', invitation.title_hint,
        'key_b64', invitation.key_b64
    );
end;
$$;

grant execute on function public.accept_canvas_invitation(text) to authenticated;
