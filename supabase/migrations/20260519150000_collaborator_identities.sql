-- Phase 17: list_canvas_collaborators RPC — surfaces each collaborator's
-- display name + email so the inviter's "Shared with" UI can show who's
-- on a canvas and detect new acceptances.
--
-- The existing direct SELECT on canvas_collaborators returns user_id (uuid)
-- only — useless for human-readable display, and auth.users isn't readable
-- to non-service-role callers under RLS. This RPC wraps the join in a
-- SECURITY DEFINER function gated by ownership of the blob: only the canvas
-- owner can see who's collaborating.

create or replace function public.list_canvas_collaborators(p_blob_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    blob_owner uuid;
    result json;
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;

    -- Only the owner can list collaborators. Mirrors the SELECT policy on
    -- canvas_collaborators (owners only) but is enforced explicitly here so
    -- nobody can read identities even via row-existence leaks.
    select owner_id into blob_owner
    from public.canvas_blobs
    where id = p_blob_id;

    if blob_owner is null then
        raise exception 'Canvas not found' using errcode = 'P0002';
    end if;
    if blob_owner <> current_user_id then
        raise exception 'Not the canvas owner' using errcode = 'P0003';
    end if;

    select coalesce(json_agg(row order by row.accepted_at desc), '[]'::json)
    into result
    from (
        select
            c.user_id,
            c.role,
            c.accepted_at,
            c.invited_by,
            u.email,
            coalesce(
                u.raw_user_meta_data->>'full_name',
                u.raw_user_meta_data->>'name',
                split_part(coalesce(u.email, ''), '@', 1)
            ) as display_name
        from public.canvas_collaborators c
        left join auth.users u on u.id = c.user_id
        where c.blob_id = p_blob_id
    ) row;

    return result;
end;
$$;

grant execute on function public.list_canvas_collaborators(uuid) to authenticated;
