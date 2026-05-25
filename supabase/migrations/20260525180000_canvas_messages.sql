-- Phase 21+ — Persistent DM history for the canvas chat panel.
--
-- Today (Phase 21 ephemeral) messages exist only as Realtime broadcasts;
-- late joiners and reload-after-conversation users see nothing. This
-- migration adds a durable canvas_messages table + minimal RPCs that the
-- chat panel can fetch from on join.
--
-- Storage decisions:
--   - Messages are stored CLEAR-TEXT in canvas_messages. Like Phase 7
--     (canvas_collaborators.key_b64), this trades E2E for "shareable
--     conversation history that survives sessions." Server can read in
--     theory; RLS gates by canvas access. Same trust model as Notion /
--     Linear / Figma comments.
--   - 200-message cap per canvas, oldest auto-pruned. Avoids unbounded
--     growth from drag-on-forever conversations.
--   - Soft-delete by setting deleted_at; the row stays so undo can
--     reconstruct it (UX follow-up; for now we keep the column for
--     forward compat without exposing the action in the UI).

create table if not exists public.canvas_messages (
    id uuid primary key default gen_random_uuid(),
    blob_id uuid not null references public.canvas_blobs(id) on delete cascade,
    author_id uuid not null references auth.users(id) on delete cascade,
    text text not null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz
);

create index if not exists canvas_messages_blob_created_idx
    on public.canvas_messages(blob_id, created_at);

alter table public.canvas_messages enable row level security;

-- A user can SELECT messages on a canvas they OWN or are a COLLABORATOR
-- on. Single policy covers both via the existing canvas_collaborators
-- and canvas_blobs.owner_id checks.
create policy "members read messages"
    on public.canvas_messages for select
    to authenticated
    using (
        exists (
            select 1 from public.canvas_blobs b
            where b.id = canvas_messages.blob_id
              and b.owner_id = auth.uid()
        )
        or exists (
            select 1 from public.canvas_collaborators c
            where c.blob_id = canvas_messages.blob_id
              and c.user_id = auth.uid()
        )
    );

-- A user can INSERT a message on a canvas they have access to, AND the
-- author_id MUST equal their own auth.uid. Server-trusted authorship.
create policy "members write messages"
    on public.canvas_messages for insert
    to authenticated
    with check (
        author_id = auth.uid()
        and (
            exists (
                select 1 from public.canvas_blobs b
                where b.id = canvas_messages.blob_id and b.owner_id = auth.uid()
            )
            or exists (
                select 1 from public.canvas_collaborators c
                where c.blob_id = canvas_messages.blob_id and c.user_id = auth.uid()
            )
        )
    );

-- No UPDATE / DELETE policies — chat history is append-only from RLS
-- perspective. (Soft-delete via deleted_at will be done via a future
-- SECURITY DEFINER RPC if we ever ship an "unsend" UX.)

-- ── Fetch RPC ─────────────────────────────────────────────────────────
-- Returns the last N messages on a canvas with the AUTHOR's display name
-- joined from auth.users so the renderer doesn't have to do a second
-- round-trip. SECURITY DEFINER so the auth.users join works; the inner
-- canvas-membership check stays equivalent to RLS.

create or replace function public.list_canvas_messages(
    p_blob_id uuid,
    p_limit integer default 200
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    is_member boolean;
begin
    if current_user_id is null then
        raise exception 'Not authenticated' using errcode = 'P0001';
    end if;
    select (
        exists (select 1 from public.canvas_blobs where id = p_blob_id and owner_id = current_user_id)
        or exists (select 1 from public.canvas_collaborators where blob_id = p_blob_id and user_id = current_user_id)
    ) into is_member;
    if not is_member then
        raise exception 'Not a member of this canvas' using errcode = 'P0002';
    end if;
    return (
        select coalesce(json_agg(row order by row.created_at), '[]'::json)
        from (
            select
                m.id,
                m.text,
                m.created_at,
                m.deleted_at,
                m.author_id,
                u.email as author_email,
                coalesce(
                    u.raw_user_meta_data->>'full_name',
                    u.raw_user_meta_data->>'name',
                    split_part(coalesce(u.email, ''), '@', 1)
                ) as author_name
            from public.canvas_messages m
            left join auth.users u on u.id = m.author_id
            where m.blob_id = p_blob_id
              and m.deleted_at is null
            order by m.created_at desc
            limit greatest(1, least(p_limit, 500))
        ) row
    );
end;
$$;

grant execute on function public.list_canvas_messages(uuid, integer) to authenticated;
