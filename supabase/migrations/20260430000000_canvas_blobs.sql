-- KLYPIX cloud canvas sync: metadata table + Storage bucket + RLS policies.
--
-- Architecture:
--   * Encrypted ciphertext bytes live in Supabase Storage (private bucket).
--   * `public.canvas_blobs` holds metadata (id, owner, size, timestamps, optional
--     unencrypted title hint for the user's own canvas list).
--   * A row's `id` doubles as the storage object name: `<id>.bin` inside the
--     bucket. This 1:1 mapping means we don't need a separate path column.
--
-- Server NEVER decrypts. The encryption key lives only on the client (in the
-- share-link URL fragment, which browsers/HTTP clients strip from requests).
-- All RLS policies operate on metadata only — the bytes are opaque to Postgres.
--
-- To apply (run from project root with Supabase CLI installed):
--   supabase db push
-- Or paste into the SQL editor at https://app.supabase.com/project/<id>/sql.

-- =============================================================================
-- Metadata table
-- =============================================================================

create table public.canvas_blobs (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    -- Plaintext title hint shown in the owner's canvas list. Optional; the
    -- *real* canvas title lives encrypted inside the .any ZIP. Owners may
    -- choose to not set this (clients can pass NULL) for max privacy at the
    -- cost of "Untitled" listings.
    title_hint text,
    -- Cached size of the encrypted envelope, used by clients to show
    -- "uploading 2.4 MB" without doing an extra HEAD request.
    byte_size integer not null check (byte_size >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index canvas_blobs_owner_id_idx on public.canvas_blobs(owner_id);
create index canvas_blobs_owner_updated_idx on public.canvas_blobs(owner_id, updated_at desc);

-- updated_at auto-bump on UPDATE.
create or replace function public.touch_canvas_blob_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger canvas_blobs_touch_updated_at
    before update on public.canvas_blobs
    for each row execute function public.touch_canvas_blob_updated_at();

-- =============================================================================
-- Row-level security: owner can do anything with their own rows; nobody else
-- can see them at all. Share-link access (anonymous read with key in URL
-- fragment) is intentionally NOT supported in this slice — that requires a
-- separate `canvas_share_tokens` table to grant scoped read access without
-- exposing the owner's whole library. Add later when the share-link UI ships.
-- =============================================================================

alter table public.canvas_blobs enable row level security;

create policy "owner can select own blobs"
    on public.canvas_blobs for select
    using (auth.uid() = owner_id);

create policy "owner can insert own blobs"
    on public.canvas_blobs for insert
    with check (auth.uid() = owner_id);

create policy "owner can update own blobs"
    on public.canvas_blobs for update
    using (auth.uid() = owner_id)
    with check (auth.uid() = owner_id);

create policy "owner can delete own blobs"
    on public.canvas_blobs for delete
    using (auth.uid() = owner_id);

-- =============================================================================
-- Storage bucket for the encrypted bytes
-- =============================================================================
-- Bucket is private (`public := false`). Reads go through the JS client
-- against signed URLs / RLS-checked downloads. The bucket-level policies
-- mirror the table: only the owner of the matching `canvas_blobs` row may
-- read/write their object.

insert into storage.buckets (id, name, public)
values ('canvases', 'canvases', false)
on conflict (id) do nothing;

-- Storage policies key off the object's name (`<id>.bin`) joined back to
-- the canvas_blobs table to find the owner. Using a CTE-style join via
-- subquery keeps the policy readable.

create policy "owner can read own canvas objects"
    on storage.objects for select
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_blobs b
            where b.id::text || '.bin' = storage.objects.name
              and b.owner_id = auth.uid()
        )
    );

create policy "owner can upload own canvas objects"
    on storage.objects for insert
    with check (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_blobs b
            where b.id::text || '.bin' = storage.objects.name
              and b.owner_id = auth.uid()
        )
    );

create policy "owner can replace own canvas objects"
    on storage.objects for update
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_blobs b
            where b.id::text || '.bin' = storage.objects.name
              and b.owner_id = auth.uid()
        )
    );

create policy "owner can delete own canvas objects"
    on storage.objects for delete
    using (
        bucket_id = 'canvases'
        and exists (
            select 1 from public.canvas_blobs b
            where b.id::text || '.bin' = storage.objects.name
              and b.owner_id = auth.uid()
        )
    );
