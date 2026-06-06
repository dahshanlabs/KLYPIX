# Collab hardening plan (best-in-class, many users)

From the 7-dimension adversarial audit (2026-06-06). Honest scale target with
P0+P1 done: **reliable 10–20 concurrent editors, multi-hour sessions, flaky
networks, crashed tabs, untrusted *outsiders*.** Explicitly NOT delivered:
30–50+ on one canvas, CRDT-grade same-field text, defense against a malicious
*authenticated member* — those are P2 (server-side authz + a real CRDT).

## Verification substrate (Stage 0 — partially done)
- `scripts/collab-sim.mjs` — headless multi-peer simulator driving the REAL
  Supabase Realtime APIs from Node (no Electron, no DB writes). **Proved the
  transport is sound** (2- and 6-peer convergence + broadcast). ✅ shipped.
- **Next (to verify the risky fixes):** extract the pure presence-coalesce +
  op-apply logic out of the React hooks into `src/canvas/collab/shared/` so the
  simulator tests the SAME code, then add vitest assertions (convergence,
  lamport-order, drop+backfill, idempotency, token-expiry/refresh, capacity,
  security). This refactor is the gate for Stage 1 below.

## Done now (contained, low-risk, verified by type-check + sim)
- **Reconnect resilience** (`channelRegistry.ts`): jittered backoff (breaks the
  thunder-herd on mass reconnect), exponent clamp (no `2**attempt` overflow),
  one-time `'FAILED'` status after full escalation while still retrying at the
  cap (so the UI can show "reconnecting" and we still recover).
- **Ghost-peer TTL** (`useCanvasCollab.ts`): prune presence rows whose
  `joined_at` is older than 35s (>2× heartbeat) so a crashed tab's chip/cursor
  disappears; the 2s sweep also triggers on a stale row.
- **Cursor min-delta** (`useCanvasCollab.ts`): skip near-identical cursor
  positions (hover jitter) to cut redundant ~30 Hz traffic.
- Earlier in this push: stale-token gated to private-only + auto-reconnect
  (final-23); presence decoupled from `active` flap (final-24).

## Staged remainder (needs harness-extraction and/or staging + 2-PC)

**Stage 1 — op convergence (P0, in `useOpSync.ts`).** Idempotency (`opId` +
seen-set → no double-apply resurrection), drain rebase (re-stamp queued offline
ops to current lamport+1 so they don't clobber newer remote state), backfill
isolation (buffer inbound ops while backfilling, apply after). *Gate: do with
the extracted op-apply module + the drop+backfill/idempotency assertions green.*

**Stage 2 — done above** (reconnect). UI badge (`useCollabHealth` +
CollabPresenceChips) still to add.

**Stage 3 — token refresh (P0, `supabaseRealtimeClient.ts` + main).** Make
renderer Realtime auth a *living* subscription: re-prime at ~80% of JWT exp /
on main's `autoRefreshToken` cycle. **Prerequisite for enabling private
channels** — without it, private channels brick multi-hour sessions.

**Stage 4 — capacity (P1).** Batch ops into one `ops`-array broadcast
(back-compat with single `op`), cursor per-frame coalesce, gate viewport on
followers, THEN raise `eventsPerSecond` 30→~150–200 (batch *first*, cap is
headroom). At 2+ peers the 30/s cap silently drops 50–90% of events today.

**Stage 5 — presence/render scaling (P1).** Single parent rAF for all peer
cursors (GPU transforms, memoized, viewport-culled), halo culling, throttle
`setPeers` to ~10 Hz. (Ghost TTL already done.)

**Stage 6 — security / enable private channels (P1, the P0 hole).** Dual-channel
routing (members → private, anon web viewer → separate public read-only),
apply `20260519120000_realtime_channel_rls.sql`, wire `useMembershipGuard`
onRevoked to tear down channel + clear queue, flip flag default ON after a soak.
*Gate: Stage 3 (token refresh) MUST land first; verify with the security
assertion + a real 2-PC revoke test.*

**Stage 7+ — P2 (hard, honest).** E2E key rotation on revoke (server-side
re-encrypt + key distribution), op authenticity (Supabase Realtime Authz v2.5+
or per-op HMAC), CRDT for same-field text (Yjs/Automerge) — keep LWW for
geometry/style.

## Top risks
Private-channel flip is a footgun (gate on token refresh + staged + escape
hatch); the harness needs a throwaway Supabase test project for the
private/token assertions; the testability refactor touches the hard-won
single-channel + presence-flap code (extract as pure fns, keep convergence
assertion green before any logic change); op-batching is a wire-format change
(emit+accept both for a full release).
