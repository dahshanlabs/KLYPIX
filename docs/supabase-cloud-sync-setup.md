# Supabase Setup — Canvas Cloud Sync

Runbook for enabling the **canvas cloud share** feature (Phase 6) on your
existing Supabase project. Until these steps are run, every "Share canvas"
click in the desktop app will fail at the Supabase call with
`auth-required` or `upload-failed`.

Scope: just the canvas-share backend. Auth, licensing, and the updater
`releases` table are unrelated and already live on the same project — this
adds one table + one Storage bucket alongside them.

---

## Prerequisites

- A Supabase project is already created and wired into KLYPIX (auth flow
  works — you can sign in from the desktop app today). If not, see the old
  superseded `supabase-setup-guide.md` for the auth-era walkthrough.
- You have either:
  - The Supabase CLI installed (`supabase --version` works), **or**
  - Web access to your project's SQL Editor at
    `https://app.supabase.com/project/<your-project-id>/sql`

The migration is already written and committed at
[supabase/migrations/20260430000000_canvas_blobs.sql](../supabase/migrations/20260430000000_canvas_blobs.sql).
You don't need to author SQL — only apply it.

---

## Step 1 — Apply the migrations

Two migrations need to be applied, in order:

| Order | File | What it does |
|---|---|---|
| 1 | [supabase/migrations/20260430000000_canvas_blobs.sql](../supabase/migrations/20260430000000_canvas_blobs.sql) | `canvas_blobs` table + `canvases` Storage bucket + owner-scoped RLS |
| 2 | [supabase/migrations/20260514120000_canvas_share_tokens.sql](../supabase/migrations/20260514120000_canvas_share_tokens.sql) | `canvas_share_tokens` table + anon-scoped RLS for share-by-URL |

Migration 1 enables the owner-side upload flow. Migration 2 mints the
tokens that go into `https://klypix.com/c/<token>` share URLs and adds the
RLS policies that let an unauthenticated browser download the encrypted
bytes for those tokens. **Without migration 2, the Share button will
fail with "Share-tokens table missing."**

### Option A: Supabase CLI (recommended if you'll add more migrations later)

```bash
# from the repo root
supabase link --project-ref <your-project-ref>   # one time, if not already linked
supabase db push
```

`db push` applies every migration in `supabase/migrations/` that hasn't run
yet, in timestamp order. Watch for two `Applying ... done` lines.

### Option B: SQL Editor (single-shot, no CLI)

1. Open
   [supabase/migrations/20260430000000_canvas_blobs.sql](../supabase/migrations/20260430000000_canvas_blobs.sql)
   and copy the whole file. Paste into
   `https://app.supabase.com/project/<your-project-id>/sql`, click **Run**.
2. Do the same for
   [supabase/migrations/20260514120000_canvas_share_tokens.sql](../supabase/migrations/20260514120000_canvas_share_tokens.sql).
3. Both should report "Success. No rows returned." (both migrations are
   pure DDL + policy + bucket insert, no data.)

Either option leaves the project in the same state. Pick whichever fits
your workflow.

---

## Step 2 — Verify the schema

In the Supabase dashboard, confirm:

1. **Tables** — `Table Editor` should show two tables:
   - `canvas_blobs` with columns `id`, `owner_id`, `title_hint`,
     `byte_size`, `created_at`, `updated_at`.
   - `canvas_share_tokens` with columns `token`, `blob_id`, `created_by`,
     `created_at`, `expires_at`, `revoked_at`.
2. **Storage bucket** — `Storage` → bucket named `canvases`, marked
   **Private** (NOT public). If it shows as public, something went wrong;
   re-run the migration's `insert into storage.buckets` block.
3. **RLS policies** — `Authentication` → `Policies`:
   - `canvas_blobs`: four owner-scoped policies (`select`, `insert`,
     `update`, `delete`) keyed off `auth.uid() = owner_id`.
   - `canvas_share_tokens`: four owner-scoped policies (same shape, but
     joining through `canvas_blobs.owner_id`) PLUS two anon/authenticated
     policies that allow reading non-revoked, non-expired tokens.
   - Storage policies for the `canvases` bucket: four owner CRUD
     policies PLUS two share-token policies (anon + authenticated) that
     allow reads when the object name matches an active share token.

If any of these are missing, the migrations didn't apply cleanly —
re-run and check the SQL Editor output for errors. The `on conflict (id) do
nothing` clause on the bucket insert makes migration 1 safe to re-run;
migration 2 is pure DDL and is also re-runnable if you drop the table
first.

---

## Step 3 — Smoke test from the desktop app

1. Launch KLYPIX (`npm run dev` or an installed build).
2. Sign in (Account / Settings if not already signed in — the cloud share
   needs an authenticated session).
3. Open or create a canvas, save it (Ctrl+S) so it has a file path on
   disk. Sharing requires a saved file — in-memory canvases get the
   `unsaved` error.
4. Click **Share** (cloud icon in the canvas toolbar / mode header). The
   modal should show "Encrypting and uploading…" then a share URL of the
   form `https://klypix.com/c/<token>#<base64-key>`.
5. Back in the Supabase dashboard:
   - Table Editor → `canvas_blobs`: one row should now exist with your
     user ID as `owner_id` and a non-zero `byte_size`.
   - Table Editor → `canvas_share_tokens`: one row whose `token` matches
     the share URL path and whose `blob_id` matches the canvas_blobs row.
   - Storage → `canvases` bucket: one `.bin` file named `<blob-id>.bin`.

That confirms the full path: renderer → encryption → IPC →
[electron/cloudHandlers.ts](../electron/cloudHandlers.ts) → Supabase
metadata insert + storage upload → metadata row visible.

---

## Troubleshooting matrix

The ShareModal surfaces four error reasons (see
[src/canvas/cloud/shareCurrentCanvas.ts](../src/canvas/cloud/shareCurrentCanvas.ts)
for the discriminated union). Each maps to a specific fix:

| Error in modal | Reason code | What's wrong | Fix |
|---|---|---|---|
| "Save the canvas first" | `unsaved` | Canvas has no file path yet | Ctrl+S, then retry |
| "Sign in to share canvases" | `auth-required` | No active Supabase session | Sign in via Settings → Account |
| "Could not read the canvas file" | `read-failed` | The `.klypix` file was moved/deleted between save and share | Re-save and retry |
| "Upload failed" | `upload-failed` | Network OR Supabase rejected the request | See sub-cases below |

**`upload-failed` sub-cases** — open DevTools (Ctrl+Shift+I) and look at
the main-process console for the actual Supabase error:

- `relation "canvas_blobs" does not exist` → migration 1 didn't apply,
  go back to Step 1.
- `Share-tokens table missing` → migration 2 didn't apply. Migration 1
  uploaded the bytes successfully but minting the URL failed; you'll
  have an orphan row in `canvas_blobs` that you can delete manually.
- `new row violates row-level security policy` → table exists but
  policies didn't apply. Check Step 2's RLS verification.
- `Bucket not found` → the `canvases` bucket wasn't created. Re-run the
  migration's storage block, or create the bucket manually in
  `Storage → New bucket → canvases → Private`.
- `JWT expired` / 401 → session is stale; sign out and back in.

---

## Anonymous share-link reads (backend ready, web viewer pending)

The `canvas_share_tokens` table (migration 2) adds the RLS plumbing so
that an unauthenticated browser at `https://klypix.com/c/<token>` can:

1. Look up the token in `canvas_share_tokens` (anon SELECT is allowed
   for non-revoked, non-expired rows).
2. Download the encrypted bytes from the `canvases` Storage bucket
   (anon SELECT is allowed when the object name matches a valid token).
3. Decrypt client-side using the key from the URL fragment.

**Backend is now ready for this flow.** What's still pending is the web
viewer itself — the Next.js page at `klypix.com/c/[token]` that runs
steps 1–3. That's the next Phase 9 slice. Until that page exists, share
URLs work end-to-end on the producer side but recipients have no app to
open them in.

---

## What this setup does NOT do

- Does not enable real-time multi-cursor collab (Phase 11-12).
- Does not enable conflict-handling for offline multi-device edits
  (Phase 7-8 — the migration is forward-compatible: when those land,
  an `ops/` log gets added without breaking what's here).
- Does not change anything about auth, licensing, releases, or any other
  existing Supabase usage in the project.
- Does not create thumbnails server-side. Dashboard thumbnails stay
  client-generated and live inside each `.klypix` file.
