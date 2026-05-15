-- ============================================================================
-- ALT+Space — Supabase Database Schema
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================================

-- 1. Profiles table (extends Supabase auth.users)
create table if not exists public.profiles (
    id uuid references auth.users on delete cascade primary key,
    email text,
    display_name text,
    tier text not null default 'free' check (tier in ('free', 'pro', 'team', 'enterprise', 'admin')),
    license_key text,
    queries_today int not null default 0,
    queries_total int not null default 0,
    last_active_at timestamptz,
    app_version text,
    os_version text,
    created_at timestamptz not null default now()
);

-- 2. License Keys
create table if not exists public.licenses (
    key text primary key,
    tier text not null default 'pro' check (tier in ('pro', 'team', 'enterprise')),
    max_activations int not null default 1,
    current_activations int not null default 0,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked boolean not null default false,
    notes text
);

-- 3. Usage Analytics (append-only log)
create table if not exists public.usage_events (
    id bigint generated always as identity primary key,
    user_id uuid references public.profiles on delete set null,
    event_type text not null,
    feature text,
    model text,
    tokens_in int,
    tokens_out int,
    duration_ms int,
    created_at timestamptz not null default now()
);

-- 4. App Config (key-value store)
create table if not exists public.app_config (
    key text primary key,
    value jsonb,
    updated_at timestamptz not null default now()
);

-- 5. Update Releases
create table if not exists public.releases (
    version text primary key,
    download_url text,
    release_notes text,
    rollout_percentage int not null default 100,
    is_mandatory boolean not null default false,
    min_supported_version text,
    published_at timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.licenses enable row level security;
alter table public.usage_events enable row level security;
alter table public.app_config enable row level security;
alter table public.releases enable row level security;

-- Profiles: users can read/update their own profile
create policy "Users can view own profile"
    on public.profiles for select
    using (auth.uid() = id);

create policy "Users can update own profile"
    on public.profiles for update
    using (auth.uid() = id);

-- Profiles: admins can read all profiles
create policy "Admins can view all profiles"
    on public.profiles for select
    using (
        exists (select 1 from public.profiles where id = auth.uid() and tier = 'admin')
    );

-- Admins can update any profile (tier changes, etc.)
create policy "Admins can update all profiles"
    on public.profiles for update
    using (
        exists (select 1 from public.profiles where id = auth.uid() and tier = 'admin')
    );

-- Licenses: only admins can manage
create policy "Admins can manage licenses"
    on public.licenses for all
    using (
        exists (select 1 from public.profiles where id = auth.uid() and tier = 'admin')
    );

-- Licenses: authenticated users can read (for activation check)
create policy "Users can read licenses for activation"
    on public.licenses for select
    using (auth.role() = 'authenticated');

-- Usage events: users can insert their own
create policy "Users can insert own events"
    on public.usage_events for insert
    with check (auth.uid() = user_id);

-- Usage events: admins can read all
create policy "Admins can view all events"
    on public.usage_events for select
    using (
        exists (select 1 from public.profiles where id = auth.uid() and tier = 'admin')
    );

-- App config: anyone can read (feature flags etc.)
create policy "Anyone can read app config"
    on public.app_config for select
    using (true);

-- App config: only admins can write
create policy "Admins can manage app config"
    on public.app_config for all
    using (
        exists (select 1 from public.profiles where id = auth.uid() and tier = 'admin')
    );

-- Releases: anyone can read (update checker)
create policy "Anyone can read releases"
    on public.releases for select
    using (true);

-- Releases: only admins can write
create policy "Admins can manage releases"
    on public.releases for all
    using (
        exists (select 1 from public.profiles where id = auth.uid() and tier = 'admin')
    );

-- ============================================================================
-- Auto-create profile on signup trigger
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, email, display_name)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
    );
    return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ============================================================================
-- Daily query counter reset (run via Supabase cron or pg_cron)
-- Schedule: 0 0 * * * (midnight UTC daily)
-- ============================================================================
-- select cron.schedule('reset-daily-queries', '0 0 * * *', $$
--     update public.profiles set queries_today = 0;
-- $$);

-- ============================================================================
-- Indexes
-- ============================================================================

create index if not exists idx_profiles_tier on public.profiles (tier);
create index if not exists idx_profiles_license_key on public.profiles (license_key);
create index if not exists idx_usage_events_user_id on public.usage_events (user_id);
create index if not exists idx_usage_events_created_at on public.usage_events (created_at);
create index if not exists idx_licenses_key on public.licenses (key);
