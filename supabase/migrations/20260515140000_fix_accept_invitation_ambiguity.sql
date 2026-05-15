-- Fix "column reference 'blob_id' is ambiguous" in accept_canvas_invitation.
--
-- The previous version used RETURNS TABLE(blob_id uuid, title_hint text),
-- which implicitly creates function-scope variables with those names. The
-- INSERT ... ON CONFLICT (blob_id, user_id) clause then couldn't decide
-- whether `blob_id` referred to the canvas_collaborators column or the
-- function variable. Postgres errored on every call.
--
-- Fix: return a JSON object instead of a TABLE. The client gets a single
-- object (not an array) and the function body has no shadowed identifiers.

create or replace function public.accept_canvas_invitation(p_token text)
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

    return json_build_object(
        'blob_id', invitation.blob_id,
        'title_hint', invitation.title_hint
    );
end;
$$;

grant execute on function public.accept_canvas_invitation(text) to authenticated;
