# Releasing a New KLYPIX Version

Runbook for shipping a new KLYPIX build that existing users will
auto-update to.

## How auto-update works (at a glance)

1. KLYPIX desktop runs `initAutoUpdater()` 10 seconds after launch
2. electron-updater fetches `https://github.com/dahshanlabs/KLYPIX/releases/latest/download/latest.yml`
3. If the version in `latest.yml` is newer than the running app's version,
   electron-updater calls Supabase's `releases` table to check staged
   rollout eligibility (optional — defaults to "everyone" if the row is missing)
4. If eligible, the new installer downloads in the background
5. A toast appears: "Update ready · Restart now / Later"
6. On next quit (clean or user-triggered restart), the installer runs and
   relaunches KLYPIX on the new version

The whole thing is driven by **two artifacts** sitting on a GitHub Release:
- `Klypix-Setup-X.Y.Z.exe` — the NSIS installer
- `latest.yml` — a manifest with version + sha512 of the installer

electron-builder produces both when you run a publishing build.

## First-time setup (one-time per machine that ships releases)

### 1. Create a GitHub Personal Access Token

1. https://github.com/settings/tokens → **Generate new token (classic)**
2. Note: "klypix-electron-builder"
3. Expiration: 90 days (renew when it expires — only used to publish)
4. Scopes: check **`repo`** (full control of private repositories — needed
   even for public repos because Releases are a write API)
5. Generate → copy the token (starts with `ghp_...`)

Save it somewhere private — GitHub won't show it again.

### 2. Set it as an environment variable

PowerShell (current session only):
```powershell
$env:GH_TOKEN = "ghp_yourTokenHere"
```

To make it persistent across sessions, use Windows System Properties →
Environment Variables → User variables → New → `GH_TOKEN`. Then restart
your terminal. Don't commit the token anywhere.

## Shipping a release

### Step 1 — bump the version

In `package.json`, change `"version": "1.0.0"` to the next semver
(e.g. `"1.0.1"` for a patch, `"1.1.0"` for a minor, `"2.0.0"` for a major).

Commit + push that change:
```bash
git add package.json
git commit -m "chore: bump to v1.0.1"
git push
```

### Step 2 — build + publish

From `e:\ANTIGRAVITY\KLYPIX`:
```bash
npm run build -- --publish always
```

This does the full electron-builder pipeline AND uploads the resulting
installer + manifest to GitHub Releases as a **draft**. Takes 3-5 minutes.

If `GH_TOKEN` isn't set, electron-builder will skip the upload step
(it'll print a warning and the installer will only land in `release/`).

### Step 3 — publish the draft on GitHub

1. Go to https://github.com/dahshanlabs/KLYPIX/releases
2. You'll see a new **Draft** release named `v1.0.1` (matching the version)
3. Optionally fill in release notes (markdown supported)
4. Click **Publish release**

The moment you publish, every running KLYPIX install at version < 1.0.1
will check for updates within 10 minutes of next launch and start
downloading.

### Step 4 (optional) — staged rollout via Supabase

If you applied the `releases` table migration
([20260515160000_releases.sql](../supabase/migrations/20260515160000_releases.sql)),
you can throttle the rollout:

In Supabase → Table Editor → `releases` → Insert row:
```
version: 1.0.1
rollout_percentage: 10
is_mandatory: false
min_supported_version: null
release_notes: (markdown summary)
```

This means only ~10% of users will get v1.0.1 on the first launch after
publish. Bucketing is deterministic per machine — the same install always
lands in the same bucket — so a given user either gets it or doesn't,
consistently.

After verifying with the canary group, bump rollout_percentage to 25 →
50 → 100 over hours/days.

If you set `is_mandatory: true`, every machine gets the update regardless
of the rollout percentage. Use for security fixes.

If you set `min_supported_version: "1.0.0"`, any user still on 1.0.0
is forced to update even outside their rollout bucket.

## Rollback

If a release breaks things in the wild:

1. **Delete the GitHub Release** (Releases page → click the bad one → Delete)
2. electron-updater on user machines now sees the previous release as
   "latest" and won't try to update further
3. Users who already updated to the broken version are stuck until you
   ship a fix — there's no auto-downgrade. Ship a patch fast.

For staged rollouts, you can also drop `rollout_percentage` to 0 on the
Supabase row to stop new machines from picking it up while you investigate.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find the application 'KLYPIX' in package.json` during build | Run from repo root, not subfolder | `cd e:\ANTIGRAVITY\KLYPIX` |
| `GitHub Personal Access Token is not set, using anonymous access` | Forgot to `$env:GH_TOKEN=...` | Set the env var, retry |
| `signing` errors or NSIS code-signing prompts | Not currently signing builds (no code-signing cert) | Windows SmartScreen may flag installers as untrusted — users get "More info → Run anyway". Address by buying an EV code-signing cert later. |
| Build succeeds but no upload | `electron-builder` only uploads with `--publish always` | Re-run with the flag |
| Update toast doesn't appear after publish | App needs full 10s after launch to check + may take a few min before electron-updater hits GitHub's cache | Wait 5 min on the older install, check `%APPDATA%\Klypix\logs` for updater logs |

## Version policy

- **Patch (1.0.X)** — bugfixes only, no behavior changes. Roll out at 100%
  immediately.
- **Minor (1.X.0)** — new features, non-breaking. Stage at 10% → 50% → 100%
  over 2-3 days.
- **Major (X.0.0)** — breaking changes (e.g. file format that older apps
  can't read). Use `min_supported_version` to force upgrade, and stage
  carefully.
