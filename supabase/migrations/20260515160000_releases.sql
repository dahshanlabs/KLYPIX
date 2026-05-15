-- Auto-update release manifest.
--
-- electron/updater.ts queries this table on every launch to decide:
--   1. Is the new version available to THIS user? (staged rollout via
--      machine-ID bucketing — same machine always lands in the same bucket)
--   2. Is the update mandatory? (forces install regardless of bucket)
--   3. Has this user fallen below the minimum supported version? (forces)
--
-- Without this table, the updater code defaults to "eligible: true,
-- mandatory: false" — i.e. everyone gets every update immediately. So this
-- migration is only required if you want staged rollouts. Safe to skip on
-- first deploy.
--
-- Anyone (anon + authenticated) can read — the version manifest is public.
-- Only admins should write (insert/update rows when shipping a new release);
-- we'll wire the admin dashboard to that, or you can use the SQL editor.

-- `if not exists` so re-running this migration on a project where the table
-- pre-exists (e.g. created by earlier setup scripts) doesn't crash. The
-- ALTERs below also use idempotent variants for the same reason.
create table if not exists public.releases (
    version text primary key,
    -- 0-100. Machines with rollout bucket < this value get the update.
    -- Start at 10 (canary), bump to 25, 50, 100 over hours/days. Defaults to
    -- 100 if not set, which means full rollout.
    rollout_percentage integer not null default 100 check (rollout_percentage between 0 and 100),
    -- If true, every machine gets the update regardless of rollout_percentage.
    -- Use for critical security fixes.
    is_mandatory boolean not null default false,
    -- Optional. If set, any user on a version < min_supported_version is
    -- forced to update. Use for "this old version has a server-incompatible
    -- bug that we can't work around."
    min_supported_version text,
    -- Free-text release notes shown in the in-app toast / future changelog
    -- panel.
    release_notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists releases_created_at_idx on public.releases(created_at desc);

create or replace function public.touch_release_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists releases_touch_updated_at on public.releases;
create trigger releases_touch_updated_at
    before update on public.releases
    for each row execute function public.touch_release_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.releases enable row level security;

-- Public read. The updater queries this with the anon key — no session, no
-- per-user filtering. Anyone with the URL of your Supabase project can read
-- the manifest. That's fine: version numbers + rollout percentages aren't
-- secrets.
drop policy if exists "anyone can read release manifest" on public.releases;
create policy "anyone can read release manifest"
    on public.releases for select
    to anon, authenticated
    using (true);

-- No INSERT / UPDATE / DELETE policies for anon or authenticated. Only the
-- service-role key (used from the admin dashboard or SQL editor) can write.
-- Service role bypasses RLS by default.
