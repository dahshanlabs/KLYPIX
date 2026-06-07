# Collab P0 — private Realtime channels (enable + test + rollback)

**Status:** built, **OFF by default**, **needs a 2-machine test before trusting.**

**Update (final-27):** the prerequisite is now in — **token refresh** keeps a
valid JWT applied to the Realtime client across multi-hour sessions
(`supabaseRealtimeClient.ts`), so private channels no longer die when the ~1h
token lapses. And the deny path is **headless-verified**: `node
scripts/collab-sim.mjs 2 5 private` shows anon (non-member) peers get
`TIMED_OUT/CLOSED` and **cannot subscribe** — the lockout works before you test.
What the 2-PC test must still confirm: authed **members still sync**, and a
**revoked** member is denied.

> ⚠️ **CRITICAL ORDERING:** apply the SQL migration FIRST, *then* flip the flag.
> A private channel with no RLS policy denies EVERYONE (including your members) —
> the headless test demonstrates exactly this. Flip the flag before the SQL and
> all collab breaks. Also confirm **Realtime Authorization is enabled** for the
> project (Dashboard → Realtime); if, after applying the SQL, even un-revoked
> members can't join, Authz isn't enforcing — enable it.

## The hole this closes

The live collab channel (`klypix-canvas-<blobId>`) is a **public** Supabase
Realtime channel. Anyone who knows the blob id can:

- **eavesdrop** — subscribe and watch every op/cursor/presence event;
- **inject** — broadcast ops onto everyone's canvas;
- **keep access after being removed** — a revoked collaborator still has the
  channel name and can rejoin the live stream.

(The stored blob is already RLS-gated on membership; this is specifically the
*live transport*.)

## The fix (two halves, both already written)

1. **Server** — `supabase/migrations/20260519120000_realtime_channel_rls.sql`
   adds RLS on `realtime.messages`: only the canvas **owner** or an accepted
   **collaborator** (via `is_canvas_owner` / `is_canvas_collaborator`, matched
   from the topic by `klypix_topic_blob_id`) may subscribe or broadcast.
   *Not auto-applied.*

2. **Client** — `channelRegistry.ts` creates the channel with
   `private: isCollabPrivateChannels()` and, when private, calls
   `primeRealtimeAuth()` (applies the user JWT) **before** subscribing.
   Controlled by `localStorage['klypix:collab:privateChannels']` — **default
   OFF**, so today's behavior is unchanged.

## Why it ships OFF

Flipping it without a correct server policy **silently breaks ALL collab** (no
one can join). It also **breaks the anonymous web viewer** (`admin/lib/
useViewerCollab.ts`), which joins without a JWT. So it must be enabled
deliberately and verified live.

## Enable + test (needs 2 machines)

1. **Apply the SQL** — paste the migration body into the Supabase dashboard SQL
   editor (project `hiqwovwavlczlbuzzbel`) and run it.
2. **Decide the viewer story** (pick one):
   - give the web viewer its own *public* channel name
     (`klypix-canvas-public-<blobId>`) and don't restrict that, **or**
   - accept that viewers must sign in.
   Until this is handled, the anonymous viewer will stop receiving presence.
3. **On BOTH editor PCs** (DevTools console, or a settings toggle):
   `localStorage.setItem('klypix:collab:privateChannels','1')` → reopen the
   canvas.
4. **Verify:**
   - ✅ Owner + collaborator still see each other's cursors/ops/presence.
   - ✅ Sign a 3rd account in that is NOT a collaborator → it cannot subscribe
     (no presence, no ops).
   - ✅ Remove a collaborator → on their next reconnect they're denied.
   - ✅ An anonymous client (no JWT) cannot subscribe.

## Rollback

- Client: `localStorage.removeItem('klypix:collab:privateChannels')` (or ship
  with it unset — it already defaults off).
- Server: `drop policy if exists "canvas collab channel members only" on realtime.messages;`
  and `drop policy if exists "canvas collab channel members can write" on realtime.messages;`

## Still open (separate, not in this change)

- **Key rotation on revoke** — a removed collaborator still holds the E2E key
  for blobs they synced while a member. Closing this means rotating the canvas
  key and re-wrapping it for remaining members on removal. Bigger change;
  design + test separately.
- **Invite email exact-match** — tighten invite acceptance to the invited
  address.
