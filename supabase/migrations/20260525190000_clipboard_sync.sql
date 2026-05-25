-- Phase 23 follow-up — cross-device clipboard sync.
--
-- Pinned clipboard items only, per user. Other devices the same user
-- signs in on can SELECT their own rows and INSERT new ones. Rows
-- auto-expire after 30 days to keep the table small.
--
-- Privacy: text + images encoded as data: URLs are stored CLEAR-TEXT in
-- Supabase. Same trust model as canvas_messages — the server can read
-- in theory, RLS gates by owner. The client surface is opt-in only
-- (Settings toggle, default OFF), and only items the user explicitly
-- PINS get synced. Free-flowing clipboard captures never go server-side.

create table if not exists public.clipboard_sync (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    kind text not null check (kind in ('text', 'image', 'files', 'html')),
    text text,                 -- for text/html
    image_data_url text,       -- for image
    file_paths text[],         -- for files (paths only — bytes aren't synced)
    source_app text,
    captured_at timestamptz not null default now(),
    -- 30-day expiry. Clients should also self-prune on list.
    expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists clipboard_sync_user_captured_idx
    on public.clipboard_sync(user_id, captured_at desc);

alter table public.clipboard_sync enable row level security;

-- Owner-only access.
create policy "users read own clipboard"
    on public.clipboard_sync for select
    to authenticated
    using (user_id = auth.uid());

create policy "users insert own clipboard"
    on public.clipboard_sync for insert
    to authenticated
    with check (user_id = auth.uid());

create policy "users delete own clipboard"
    on public.clipboard_sync for delete
    to authenticated
    using (user_id = auth.uid());

-- No UPDATE policy — clipboard items are immutable; to "edit" a snippet
-- the client deletes + reinserts.

-- Server-side prune job analog: clients SELECT only WHERE expires_at > now()
-- so expired rows are invisible. A future maintenance cron can DELETE
-- WHERE expires_at < now() to reclaim space.
