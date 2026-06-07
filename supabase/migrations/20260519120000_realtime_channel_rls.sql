-- Phase 12: lock down the Realtime collab channel to canvas members.
--
-- WHAT THIS DOES
-- Adds an RLS policy on the realtime.messages table so only signed-in
-- users who are owners or collaborators of the canvas (matched via the
-- 'klypix-canvas-<blob_id>' channel name) can subscribe to the channel.
-- The desktop app's renderer authenticates via setAuth() with the
-- current user's JWT, so RLS sees auth.uid() = the signed-in user.
--
-- WHEN TO APPLY
-- This is a DEFERRED migration. The renderer-side auth plumbing was
-- shipped in commit "Phase 12 — auth plumbing for Realtime" but the
-- channel itself stays public (legacy behavior) until this SQL runs.
-- Apply when:
--   1. All editor clients are on a Klypix version >= the auth-plumbing
--      commit (otherwise pre-auth clients fail to subscribe).
--   2. You're prepared to break the anonymous web viewer's presence
--      (admin/lib/useViewerCollab.ts) — it joins without a JWT.
--      Mitigations:
--      a) Use a separate "public" channel name for the viewer
--         ('klypix-canvas-public-<blob_id>') and don't restrict that.
--      b) Or accept the trade-off and let viewers join only via signed-in
--         flows (link to klypix.com/sign-in).
--
-- BEFORE APPLYING — verify the renderer is up-to-date:
--   grep "setRealtimeAuth" src/canvas/collab/useCanvasCollab.ts
--   (should match — the call happens in the effect that opens the
--   channel; without it the desktop will fail RLS on private channels)
--
-- HOW TO APPLY
--   - Supabase CLI: `supabase db push` (or specific migration up)
--   - Or via the dashboard's SQL editor, paste this file's body.
--
-- HOW TO REVERT
--   drop policy if exists "canvas collab channel members only" on realtime.messages;
--
-- =============================================================================

-- Realtime's Authorization feature requires the CHANNEL to be created with
-- `config.private: true` (per-channel, NOT the global realtime client params).
-- As of Phase C this is wired behind a runtime flag in channelRegistry.ts:
-- the channel passes `private: isCollabPrivateChannels()`, which reads
-- localStorage['klypix:collab:privateChannels'] (default OFF). To enable:
--   1. Apply this migration (dashboard SQL editor or `supabase db push`).
--   2. Handle the anonymous web viewer (see "WHEN TO APPLY" above) — it joins
--      without a JWT and WILL be denied on a private channel.
--   3. On each editor PC: localStorage.setItem('klypix:collab:privateChannels','1')
--      then reopen the canvas. channelRegistry primes the JWT (primeRealtimeAuth)
--      before subscribe so RLS sees auth.uid().
--   4. 2-PC test: both members still sync; a removed collaborator and an
--      anonymous client can NO LONGER subscribe/broadcast.
-- Full checklist: docs/COLLAB_PRIVATE_CHANNELS.md.

-- Extract the blob_id from a 'klypix-canvas-<uuid>' channel topic.
-- Returns NULL for any other topic shape so the policy fails closed.
create or replace function public.klypix_topic_blob_id(topic text)
returns uuid
language sql
immutable
as $$
    select case
        when topic like 'klypix-canvas-%'
            then (substring(topic from 'klypix-canvas-([0-9a-fA-F-]{36})'))::uuid
        else null
    end
$$;

-- Read access: a canvas owner or collaborator may subscribe.
-- drop-then-create so re-running is idempotent (no 42710 "already exists").
drop policy if exists "canvas collab channel members only" on realtime.messages;
create policy "canvas collab channel members only"
    on realtime.messages
    for select
    to authenticated
    using (
        public.klypix_topic_blob_id(realtime.topic()) is not null
        and (
            public.is_canvas_owner(public.klypix_topic_blob_id(realtime.topic()))
            or public.is_canvas_collaborator(public.klypix_topic_blob_id(realtime.topic()))
        )
    );

-- Write access (broadcasting): same membership check.
drop policy if exists "canvas collab channel members can write" on realtime.messages;
create policy "canvas collab channel members can write"
    on realtime.messages
    for insert
    to authenticated
    with check (
        public.klypix_topic_blob_id(realtime.topic()) is not null
        and (
            public.is_canvas_owner(public.klypix_topic_blob_id(realtime.topic()))
            or public.is_canvas_collaborator(public.klypix_topic_blob_id(realtime.topic()))
        )
    );
