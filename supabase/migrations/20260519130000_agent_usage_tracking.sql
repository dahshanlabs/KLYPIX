-- Phase 13: server-side daily spend tracking.
--
-- Today CostTracker.isOverBudget() reads localStorage[klypix:spend:<date>],
-- which any user can edit in DevTools to reset their daily total to zero.
-- This migration adds a server-trusted source of truth so the renderer can
-- enforce daily caps that a localStorage edit can't bypass.
--
-- DEFERRED MIGRATION pattern (same as Phase 12): the renderer code that
-- consumes these RPCs ships in the same commit and gracefully no-ops when
-- the RPCs aren't available. Apply this SQL when you're ready to flip the
-- system to server-trusted spend.
--
-- WHAT IT ADDS
--   - agent_usage table: one row per agent run, with model + token counts
--     + cost_usd. RLS allows a user to insert their own rows + read their
--     own rows (no cross-user visibility).
--   - get_daily_spend(): RPC returning the signed-in user's spend today.
--   - record_agent_usage(): RPC inserting a row and returning the new
--     daily total in one round-trip.
--
-- HOW TO APPLY
--   Supabase CLI: `supabase db push`
--   Or paste into SQL editor in the dashboard.
--
-- HOW TO REVERT
--   drop function if exists public.record_agent_usage;
--   drop function if exists public.get_daily_spend;
--   drop table if exists public.agent_usage;

create table if not exists public.agent_usage (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    -- Free-form model id ("claude-opus-4-7", "gpt-4o", "deepseek-v4-pro", etc.)
    -- so we can break down usage by provider for analytics later.
    model text not null,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    cache_hit_tokens integer not null default 0,
    -- Stored as the same dollar precision the renderer's CostTracker uses.
    cost_usd numeric(10, 6) not null,
    -- Useful for "last 24 hours" rolling queries (timezone-aware) without
    -- having to compute on every read.
    created_at timestamptz not null default now()
);

create index if not exists agent_usage_user_created_idx
    on public.agent_usage(user_id, created_at desc);

alter table public.agent_usage enable row level security;

-- A user can see their own usage and nobody else's.
create policy "users read own usage"
    on public.agent_usage for select
    to authenticated
    using (user_id = auth.uid());

-- A user can insert their own usage and nothing else (user_id forced to self).
create policy "users insert own usage"
    on public.agent_usage for insert
    to authenticated
    with check (user_id = auth.uid());

-- No UPDATE / DELETE policies — usage is an append-only audit log.

-- ============================================================================
-- RPC: get_daily_spend
-- Returns the signed-in user's USD spend today (UTC day boundary).
-- ============================================================================

create or replace function public.get_daily_spend()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(sum(cost_usd), 0)
    from public.agent_usage
    where user_id = auth.uid()
      and created_at >= date_trunc('day', now() at time zone 'UTC');
$$;

revoke all on function public.get_daily_spend from public;
grant execute on function public.get_daily_spend to authenticated;

-- ============================================================================
-- RPC: record_agent_usage
-- Inserts a usage row and returns the updated daily total in one trip.
-- ============================================================================

create or replace function public.record_agent_usage(
    p_model text,
    p_input_tokens integer,
    p_output_tokens integer,
    p_cache_hit_tokens integer,
    p_cost_usd numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
    new_total numeric;
begin
    insert into public.agent_usage(
        user_id, model, input_tokens, output_tokens, cache_hit_tokens, cost_usd
    ) values (
        auth.uid(),
        coalesce(p_model, 'unknown'),
        greatest(coalesce(p_input_tokens, 0), 0),
        greatest(coalesce(p_output_tokens, 0), 0),
        greatest(coalesce(p_cache_hit_tokens, 0), 0),
        greatest(coalesce(p_cost_usd, 0), 0)
    );

    select coalesce(sum(cost_usd), 0) into new_total
    from public.agent_usage
    where user_id = auth.uid()
      and created_at >= date_trunc('day', now() at time zone 'UTC');

    return new_total;
end;
$$;

revoke all on function public.record_agent_usage from public;
grant execute on function public.record_agent_usage to authenticated;
