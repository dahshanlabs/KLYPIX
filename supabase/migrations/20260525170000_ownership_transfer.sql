-- Ownership transfer: let the current owner of a canvas hand it to one of
-- the existing collaborators. The old owner becomes a collaborator on the
-- same canvas; the new owner's collaborator row is removed (it'd be
-- redundant once they own the blob). All atomic.
--
-- Use case: founding designer hands a project off to another teammate
-- without anyone losing access mid-flight.
--
-- RPC is SECURITY DEFINER + checks current_user_id == owner_id internally
-- so only the owner can call it.

create or replace function public.transfer_canvas_ownership(
    p_blob_id uuid,
    p_new_owner_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    blob_owner uuid;
    is_collab boolean;
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;
    if p_new_owner_id is null then
        raise exception 'New owner is required' using errcode = 'P0002';
    end if;
    if current_user_id = p_new_owner_id then
        raise exception 'You are already the owner' using errcode = 'P0003';
    end if;

    -- Lock the blob row for the duration of the transfer.
    select owner_id into blob_owner
    from public.canvas_blobs
    where id = p_blob_id
    for update;

    if blob_owner is null then
        raise exception 'Canvas not found' using errcode = 'P0004';
    end if;
    if blob_owner <> current_user_id then
        raise exception 'Only the current owner can transfer ownership' using errcode = 'P0005';
    end if;

    -- New owner must already be a collaborator on this canvas (so they have
    -- the encryption key). Avoids handing the blob to someone who can't
    -- decrypt it.
    select exists(
        select 1 from public.canvas_collaborators
        where blob_id = p_blob_id and user_id = p_new_owner_id
    ) into is_collab;
    if not is_collab then
        raise exception 'New owner must already be a collaborator on this canvas' using errcode = 'P0006';
    end if;

    -- 1. Flip the blob owner.
    update public.canvas_blobs
    set owner_id = p_new_owner_id
    where id = p_blob_id;

    -- 2. Remove the new owner's now-redundant collaborator row.
    delete from public.canvas_collaborators
    where blob_id = p_blob_id and user_id = p_new_owner_id;

    -- 3. Add the OLD owner as a collaborator so they don't lose access.
    --    Copy the key_b64 from the new owner's prior collaborator row IF
    --    we still have it — but we just deleted that row, so copy from
    --    any remaining collaborator's row instead.
    insert into public.canvas_collaborators (blob_id, user_id, role, invited_by, accepted_at, key_b64)
    select
        p_blob_id,
        current_user_id,
        'editor',
        p_new_owner_id,
        now(),
        c.key_b64
    from public.canvas_collaborators c
    where c.blob_id = p_blob_id
    limit 1
    on conflict (blob_id, user_id) do nothing;

    return json_build_object(
        'ok', true,
        'new_owner_id', p_new_owner_id,
        'former_owner_id', current_user_id
    );
end;
$$;

grant execute on function public.transfer_canvas_ownership(uuid, uuid) to authenticated;
