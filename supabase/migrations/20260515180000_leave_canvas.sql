-- Lets a collaborator remove themselves from a canvas that was shared with
-- them ("leave shared canvas" from the desktop dashboard). Mirror of the
-- owner's revoke flow — owner-side revoke deletes the collaborator row via
-- the "owner manages own canvas collaborators" RLS policy; the recipient
-- side has no equivalent DELETE policy, so we expose this RPC instead.
--
-- We intentionally do NOT add a blanket "collaborator can delete own row"
-- RLS policy: keeping the only path through a security-definer RPC means
-- we can audit/extend it later (e.g. notify the owner, soft-delete) without
-- another migration.

create or replace function public.leave_canvas(p_blob_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    deleted_count int;
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;

    delete from public.canvas_collaborators
    where blob_id = p_blob_id
      and user_id = current_user_id;

    get diagnostics deleted_count = row_count;

    -- No-op when the row is already gone (e.g. owner just revoked us, or
    -- the user double-clicked the X). We swallow this silently — the
    -- end-state the caller wanted is already true.
    if deleted_count = 0 then
        return;
    end if;
end;
$$;

grant execute on function public.leave_canvas(uuid) to authenticated;
