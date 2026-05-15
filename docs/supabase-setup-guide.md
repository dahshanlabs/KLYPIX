# ⚠️ SUPERSEDED — see CLAUDE.md

# ALT+Space — Supabase Setup Guide

Follow these steps to connect the auth system to your Supabase project.

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in (or create an account)
2. Click **New Project**
3. Choose an organization, name it `altspace`, pick a region close to your users
4. Set a strong database password (save it — you won't see it again)
5. Wait for the project to finish provisioning (~2 minutes)

---

## Step 2: Run the Database Schema

1. In your Supabase dashboard, go to **SQL Editor** (left sidebar)
2. Click **New Query**
3. Copy the entire contents of `docs/supabase-setup.sql` and paste it
4. Click **Run**
5. Verify: go to **Table Editor** — you should see: `profiles`, `licenses`, `usage_events`, `app_config`, `releases`

---

## Step 3: Get Your API Keys

1. Go to **Settings** → **API** in your Supabase dashboard
2. Copy these two values:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public key** — starts with `eyJ...`

3. Open `electron/auth/supabaseClient.ts` and replace the placeholders:

```typescript
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...YOUR_ANON_KEY...';
```

> For production builds, use environment variables instead:
> - Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in your build pipeline
> - The code already reads from `process.env` first

---

## Step 4: Enable OAuth Providers

### Google Sign-In

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Go to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add authorized redirect URI: `https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback`
7. Copy the **Client ID** and **Client Secret**
8. In Supabase: go to **Authentication** → **Providers** → **Google**
9. Toggle it ON, paste the Client ID and Client Secret
10. Save

### Microsoft Sign-In

1. Go to [Azure Portal](https://portal.azure.com/) → **Azure Active Directory** → **App Registrations**
2. Click **New Registration**
3. Name: `ALT+Space`
4. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
5. Redirect URI: **Web** → `https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback`
6. After creation, copy the **Application (client) ID**
7. Go to **Certificates & secrets** → **New client secret** → copy the **Value**
8. In Supabase: go to **Authentication** → **Providers** → **Azure (Microsoft)**
9. Toggle it ON, paste the Client ID and Client Secret
10. Set the **Azure Tenant URL** to: `https://login.microsoftonline.com/common`
11. Save

---

## Step 5: Configure Authentication Settings

1. In Supabase dashboard → **Authentication** → **URL Configuration**
2. Set **Site URL** to: `altspace://auth/callback`
3. Add to **Redirect URLs**:
   - `altspace://auth/callback`
   - `altspace://auth/reset-password`
4. Save

---

## Step 6: Set Up Daily Query Reset (Optional)

If you want the `queries_today` counter to reset at midnight:

1. In Supabase SQL Editor, run:
```sql
select cron.schedule(
    'reset-daily-queries',
    '0 0 * * *',
    $$ update public.profiles set queries_today = 0; $$
);
```

> Note: `pg_cron` must be enabled. Go to **Database** → **Extensions** → enable `pg_cron`.

---

## Step 7: Create Your Admin Account

1. Run the app and create an account (email/password or OAuth)
2. In Supabase **Table Editor** → `profiles` table
3. Find your row and change `tier` from `free` to `admin`
4. Save — you now have full admin access

---

## Step 8: Generate License Keys (Optional)

To create license keys for Pro users, insert into the `licenses` table:

```sql
insert into public.licenses (key, tier, max_activations, notes)
values
    ('PRO-XXXX-XXXX-XXXX', 'pro', 1, 'Single user license'),
    ('TEAM-XXXX-XXXX-XXXX', 'team', 10, 'Team license - 10 seats');
```

Users activate these from the app's login screen → "Activate with license key".

---

## Step 9: Add the Query Counter RPC (Required)

The usage tracking system calls an RPC to increment query counts. Run this in SQL Editor:

```sql
create or replace function public.increment_query_count(user_id uuid)
returns void as $$
begin
    update public.profiles
    set queries_today = queries_today + 1,
        queries_total = queries_total + 1,
        last_active_at = now()
    where id = user_id;
end;
$$ language plpgsql security definer;
```

---

## Step 10: Test

1. Run `npm run dev`
2. The app should show the login screen
3. Create an account with email/password
4. Check Supabase **Authentication** → **Users** — your user should appear
5. Check **Table Editor** → `profiles` — a profile row should exist with `tier = 'free'`
6. Sign out, sign back in — should auto-restore session on next launch

---

## File Reference

| File | Purpose |
|------|---------|
| `electron/auth/supabaseClient.ts` | Supabase client initialization (URL + anon key) |
| `electron/auth/tokenStore.ts` | Encrypted token persistence (safeStorage / DPAPI) |
| `electron/auth/authService.ts` | All auth logic (sign in/up, OAuth, license, tiers) |
| `electron/auth/authGuard.ts` | IPC handler registration + deep link handler |
| `src/components/AuthProvider.tsx` | React context for auth state |
| `src/components/LoginScreen.tsx` | Login/signup/license UI |
| `docs/supabase-setup.sql` | Database schema (run once in SQL Editor) |

---

## Troubleshooting

**"Supabase not configured"** — You haven't replaced the placeholder values in `supabaseClient.ts`.

**OAuth opens browser but nothing happens** — Check that `altspace://auth/callback` is in your Supabase redirect URLs (Step 5). The deep link protocol `altspace://` must be registered — this happens automatically on Windows when the app runs.

**"Session expired"** — The refresh token has a 30-day lifetime. If the user hasn't opened the app in 30+ days, they need to re-login. The offline grace period (7 days) only covers network outages, not token expiry.

**License key "maximum activations"** — Each key has a `max_activations` limit. Increase it in the `licenses` table if needed.
