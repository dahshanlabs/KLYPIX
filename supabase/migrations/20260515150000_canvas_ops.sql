-- Phase 7 part 2: operations log for sync.
--
-- Every time an editor (owner or collaborator) mutates a canvas, the change
-- is recorded as an op in canvas_ops. Other clients (running KLYPIX with the
-- same canvas open) replay those ops to converge their local state.
--
-- Why an op log instead of full-state push:
--   - Tiny payloads (bytes per op vs MB per canvas)
--   - Realtime channels can fan out new ops as they're inserted
--   - CRDT-style merging becomes possible later by reordering / replaying
--   - Conflict resolution is per-field, not per-canvas
--
-- For v1 we keep ops simple: a single JSON `op` column with a discriminated
-- `type` field. Schema evolution lives inside the JSON shape, not the
-- table. Periodically compaction can collapse old ops into a fresh canvas
-- snapshot (out of scope for this migration).

create table public.canvas_ops (
    -- Bigserial — ops have a strictly increasing global order. Clients pull
    -- ops where seq > lastSeen to catch up.
    seq bigserial primary key,
    blob_id uuid not null references public.canvas_blobs(id) on delete cascade,
    -- Who emitted the op. Used for client-side echo suppression (don't
    -- re-apply your own ops on receive) and for "last edited by" attribution.
    author_id uuid not null references auth.users(id) on delete cascade,
    -- Stable per-device UUID — survives reinstall via localStorage. Lets us
    -- distinguish two browsers signed in as the same user.
    device_id text not null,
    -- The op payload: discriminated by op.type. Examples:
    --   { type: 'item.create', id, item: {...} }
    --   { type: 'item.update', id, patch: { x: 100 } }
    --   { type: 'item.delete', id }
    --   { type: 'stroke.create', id, points: [...] }
    --   { type: 'line.create', id, x1, y1, x2, y2 }
    --   { type: 'connection.create', id, fromItemId, toItemId }
    -- Renderer-side op shape lives in src/canvas/sync/opTypes.ts (the schema
    -- contract); Postgres treats this column as opaque JSON.
    op jsonb not null,
    created_at timestamptz not null default now()
);

-- Pull queries are always "ops for this canvas with seq > X". This is the
-- hot path index.
create index canvas_ops_blob_seq_idx on public.canvas_ops(blob_id, seq);

-- Compaction / "what's changed in the last hour" can use created_at.
create index canvas_ops_blob_created_idx on public.canvas_ops(blob_id, created_at);

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.canvas_ops enable row level security;

-- Read: owners + collaborators of the underlying canvas. Lookups go through
-- the existing is_canvas_owner / is_canvas_collaborator helpers (added in
-- 20260515130000) which use SECURITY DEFINER to avoid recursion.
create policy "canvas members can read ops"
    on public.canvas_ops for select
    to authenticated
    using (
        public.is_canvas_owner(canvas_ops.blob_id)
        or public.is_canvas_collaborator(canvas_ops.blob_id)
    );

-- Insert: same membership check, plus author_id must be the current user
-- (can't impersonate someone else).
create policy "canvas members can insert ops"
    on public.canvas_ops for insert
    to authenticated
    with check (
        author_id = auth.uid()
        and (
            public.is_canvas_owner(canvas_ops.blob_id)
            or public.is_canvas_collaborator(canvas_ops.blob_id)
        )
    );

-- No UPDATE policy — ops are immutable. No DELETE policy for now either;
-- compaction will be server-side or owner-only via a future RPC.

-- =============================================================================
-- Realtime
-- =============================================================================
-- Add the table to the supabase_realtime publication so clients can
-- subscribe to new ops via Postgres logical replication. This is what makes
-- "live multi-cursor" cheap to add later — Realtime broadcasts the INSERTs
-- to every listening client, no polling required.
--
-- Note: the publication is created by Supabase on project init. If your
-- project predates Realtime defaults, the ALTER below may need a
-- `create publication supabase_realtime;` first.

alter publication supabase_realtime add table public.canvas_ops;
