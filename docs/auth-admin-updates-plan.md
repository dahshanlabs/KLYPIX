# ⚠️ SUPERSEDED — see CLAUDE.md

# ALT+Space — Authentication, Admin Panel, Auto-Updates & Content Generation

**Document Type:** Architecture Plan
**Date:** 2026-03-22
**Status:** Proposal — Pre-Implementation

---

## Table of Contents

1. [Authentication System](#1-authentication-system)
2. [Admin Panel](#2-admin-panel)
3. [Auto-Update Rollout](#3-auto-update-rollout)
4. [Document & Image Generation](#4-document--image-generation)
5. [Implementation Phases](#5-implementation-phases)

---

## 1. Authentication System

### The Decision: Cloud-Backed vs Local-Only

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Supabase Auth** | Free tier, OAuth (Google/Microsoft), JWT tokens, user management API, row-level security | Requires internet for login, adds a cloud dependency | SaaS distribution, team licensing, usage analytics |
| **Firebase Auth** | Same as Supabase, stronger Google ecosystem | Google lock-in, heavier SDK | If already using Google services (you are — Gemini) |
| **License Key (offline)** | No server needed, works offline, simple | No user management, no usage tracking, keys can be shared | One-time purchase model, privacy-focused users |
| **Custom Backend** | Full control | Must build and host everything | Enterprise deployments |

### Recommendation: Supabase

**Why:** Free tier covers 50,000 monthly active users. Built-in OAuth. PostgreSQL database for admin panel data. Edge functions for license validation. No server to manage. Pairs well with the existing architecture (desktop app + API calls).

### Auth Flow

```
┌─────────────────────────────────────────────────────────┐
│  APP LAUNCH                                             │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │ Has valid    │─→  │ Load app     │                   │
│  │ cached token │YES │ normally     │                   │
│  └──────────────┘    └──────────────┘                   │
│         │ NO                                            │
│         ↓                                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │  LOGIN SCREEN                                    │   │
│  │                                                  │   │
│  │  ┌─────────────────────────────────────────┐     │   │
│  │  │         ALT+Space                       │     │   │
│  │  │                                         │     │   │
│  │  │    [ Sign in with Google    ]            │     │   │
│  │  │    [ Sign in with Microsoft ]            │     │   │
│  │  │                                         │     │   │
│  │  │    ── or ──                             │     │   │
│  │  │                                         │     │   │
│  │  │    Email: [_______________]              │     │   │
│  │  │    Password: [____________]              │     │   │
│  │  │    [ Sign In ]  [ Sign Up ]              │     │   │
│  │  │                                         │     │   │
│  │  │    ── or ──                             │     │   │
│  │  │                                         │     │   │
│  │  │    License Key: [_________]              │     │   │
│  │  │    [ Activate ]                          │     │   │
│  │  │                                         │     │   │
│  │  └─────────────────────────────────────────┘     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Token stored in:                                       │
│  - Electron safeStorage (encrypted keychain)            │
│  - NOT localStorage (insecure for auth tokens)          │
│                                                         │
│  Token refresh:                                         │
│  - Supabase JWT auto-refresh (1 hour expiry)            │
│  - Refresh token stored encrypted, valid 30 days        │
│  - If refresh fails → show login screen                 │
└─────────────────────────────────────────────────────────┘
```

### Implementation Architecture

```
electron/
  auth/
    supabaseClient.ts     ← Supabase client init (anon key + URL)
    authService.ts        ← login(), logout(), refreshToken(), getUser()
    tokenStore.ts         ← Electron safeStorage wrapper (encrypted)
    authGuard.ts          ← IPC middleware: checks token before allowing app

src/
  components/
    LoginScreen.tsx       ← Login/signup UI
    AuthProvider.tsx      ← React context: user state, loading, logout
```

### Key Design Decisions

**Token storage: `electron.safeStorage`** — not localStorage. safeStorage uses the OS keychain (Windows Credential Manager). Tokens are encrypted at rest. Even if someone copies the app data folder, they can't extract the token without the user's Windows login.

```typescript
// electron/auth/tokenStore.ts
import { safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

const TOKEN_PATH = path.join(app.getPath('userData'), '.auth');

export function storeToken(token: string): void {
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(TOKEN_PATH, encrypted);
}

export function getToken(): string | null {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const encrypted = fs.readFileSync(TOKEN_PATH);
    return safeStorage.decryptString(encrypted);
}

export function clearToken(): void {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
}
```

**Offline grace period:** If the user was authenticated but loses internet, the app should still work for 7 days using the cached token. After 7 days without a refresh, require re-login. This prevents the app from becoming unusable on flights or spotty connections.

**License key fallback:** For users who don't want to create an account, offer a license key option. License keys are validated against Supabase on first use, then cached locally. Supports offline use after activation.

### User Tiers

| Tier | Access | Limit |
|------|--------|-------|
| **Free** | Chat, screenshot mode, basic actions | 50 queries/day, no Deep Mode |
| **Pro** | All features, Deep Mode, Agent Mode | Unlimited queries, priority support |
| **Team** | Pro + Admin Panel + shared workflows | Per-seat licensing |
| **Enterprise** | Team + custom model endpoints + SSO | Custom |

Tier enforcement happens in the renderer before API calls:

```typescript
// src/auth/tierGuard.ts
function canUseFeature(feature: string, user: User): boolean {
    const tierLimits: Record<string, string[]> = {
        'free': ['chat', 'screenshot', 'basic_actions'],
        'pro': ['chat', 'screenshot', 'basic_actions', 'deep_mode', 'agent_mode', 'export'],
        'team': ['chat', 'screenshot', 'basic_actions', 'deep_mode', 'agent_mode', 'export', 'admin', 'shared_workflows'],
    };
    return tierLimits[user.tier]?.includes(feature) ?? false;
}
```

---

## 2. Admin Panel

### What It Manages

The admin panel is a **web dashboard** (separate from the desktop app) that lets you:

| Section | Purpose |
|---------|---------|
| **Users** | View all registered users, tiers, last active, query counts |
| **Licenses** | Generate, revoke, and track license keys |
| **Usage Analytics** | Queries per day, active users, feature usage heatmap, error rates |
| **App Config** | Default model, feature flags, announcement banner, maintenance mode |
| **Updates** | Upload new versions, set rollout percentage, view update adoption |
| **Workflows** (future) | Shared workflow templates for Team tier users |

### Architecture Options

| Option | Stack | Effort | Hosting |
|--------|-------|--------|---------|
| **A: Supabase Studio + custom views** | Supabase dashboard + SQL views | Low | Supabase (free) |
| **B: Next.js admin app** | Next.js + Supabase + Tailwind | Medium | Vercel (free tier) |
| **C: In-app admin panel** | React route inside Electron | Medium | None (embedded) |

### Recommendation: Option B — Next.js Web Dashboard

**Why:**
- Accessible from any device (phone, another PC) — not tied to the desktop app
- Can be deployed to Vercel for free
- Same Supabase backend as the auth system
- Tailwind already used in the main app — consistent styling
- Separates admin concerns from the user-facing app

### Dashboard Pages

```
/dashboard
  /dashboard/users         ← User list, search, filter by tier
  /dashboard/users/[id]    ← Individual user: usage history, tier, license
  /dashboard/licenses      ← Generate keys, bulk create, revocation
  /dashboard/analytics      ← Charts: DAU, queries/day, feature usage
  /dashboard/config        ← Feature flags, default model, announcements
  /dashboard/updates       ← Upload builds, manage rollout, view adoption
```

### Data Model (Supabase PostgreSQL)

```sql
-- Users (extends Supabase auth.users)
create table public.profiles (
    id uuid references auth.users primary key,
    email text,
    display_name text,
    tier text default 'free',        -- free, pro, team, enterprise
    license_key text,
    queries_today int default 0,
    queries_total int default 0,
    last_active_at timestamptz,
    app_version text,
    os_version text,
    created_at timestamptz default now()
);

-- License Keys
create table public.licenses (
    key text primary key,
    tier text not null,
    max_activations int default 1,
    current_activations int default 0,
    created_at timestamptz default now(),
    expires_at timestamptz,
    revoked boolean default false,
    notes text
);

-- Usage Analytics (append-only log)
create table public.usage_events (
    id bigint generated always as identity primary key,
    user_id uuid references public.profiles,
    event_type text,                  -- 'query', 'screenshot', 'deep_mode', 'agent_action', 'export'
    feature text,                     -- 'decision', 'risk', 'compare', etc.
    model text,                       -- 'gemini-2.5-flash'
    tokens_in int,
    tokens_out int,
    duration_ms int,
    created_at timestamptz default now()
);

-- App Config (key-value store)
create table public.app_config (
    key text primary key,
    value jsonb,
    updated_at timestamptz default now()
);

-- Update Releases
create table public.releases (
    version text primary key,
    download_url text,
    release_notes text,
    rollout_percentage int default 100,  -- 0-100, for staged rollouts
    is_mandatory boolean default false,
    min_supported_version text,          -- versions below this MUST update
    published_at timestamptz default now()
);
```

### Admin Authentication

The admin panel uses the same Supabase auth but checks for an `admin` role:

```sql
-- Row-level security
create policy "Admin only" on public.profiles
    for all using (
        auth.uid() in (
            select id from public.profiles where tier = 'admin'
        )
    );
```

Only your account (and any accounts you explicitly promote) can access the dashboard.

---

## 3. Auto-Update Rollout

### Current State

- No auto-updater installed
- NSIS installer builds to `release/` folder
- Manual distribution only

### Solution: `electron-updater` + GitHub Releases (or Supabase Storage)

`electron-updater` is the standard for Electron apps. It checks for updates, downloads them, and installs on next restart.

### Update Flow

```
┌──────────────────────────────────────────────────────────┐
│  APP STARTS                                              │
│      ↓                                                   │
│  Check for updates (background, silent)                  │
│      ↓                                                   │
│  ┌─────────────┐   ┌───────────────────────────────┐     │
│  │ No update   │   │ Update available               │     │
│  │ → continue  │   │ v1.2.0 → v1.3.0               │     │
│  └─────────────┘   └──────────┬────────────────────┘     │
│                                ↓                          │
│                     ┌──────────────────────┐              │
│                     │ Staged rollout check │              │
│                     │ Am I in the 20%?     │              │
│                     └──────────┬───────────┘              │
│                         YES ↓        ↓ NO                 │
│                     ┌────────────┐  ┌──────────┐          │
│                     │ Download   │  │ Skip for │          │
│                     │ in bg      │  │ now      │          │
│                     └──────┬─────┘  └──────────┘          │
│                            ↓                              │
│                     ┌──────────────────────────────┐      │
│                     │ Toast notification:           │      │
│                     │ "Update ready. Restart now?"  │      │
│                     │ [ Restart ]  [ Later ]        │      │
│                     └──────────────────────────────┘      │
│                                                           │
│  If mandatory update (min_supported_version):             │
│      → Force update, no "Later" option                    │
│      → Show "This version is no longer supported"         │
└──────────────────────────────────────────────────────────┘
```

### Implementation

**Step 1: Install electron-updater**

```bash
npm install electron-updater
```

**Step 2: Add to package.json build config**

```json
{
  "build": {
    "publish": {
      "provider": "github",
      "owner": "dahshanlabs",
      "repo": "altspace-releases"
    }
  }
}
```

Or use a generic provider pointing to Supabase Storage:

```json
{
  "build": {
    "publish": {
      "provider": "generic",
      "url": "https://your-supabase-project.supabase.co/storage/v1/object/public/releases"
    }
  }
}
```

**Step 3: Auto-update module in main process**

```typescript
// electron/updater.ts
import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';

export function initAutoUpdater(mainWindow: BrowserWindow) {
    autoUpdater.autoDownload = false;  // Don't download until rollout check passes
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', async (info) => {
        // Check staged rollout
        const shouldUpdate = await checkRolloutEligibility(info.version);
        if (!shouldUpdate) return;

        // Notify renderer
        mainWindow.webContents.send('update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes,
        });

        // Start download
        autoUpdater.downloadUpdate();
    });

    autoUpdater.on('download-progress', (progress) => {
        mainWindow.webContents.send('update-progress', {
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        mainWindow.webContents.send('update-downloaded', {
            version: info.version,
        });
    });

    // User clicks "Restart Now"
    ipcMain.on('install-update', () => {
        autoUpdater.quitAndInstall(false, true);
    });

    // Check on launch (after 10s delay to not block startup)
    setTimeout(() => autoUpdater.checkForUpdates(), 10_000);

    // Check every 4 hours
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}

async function checkRolloutEligibility(version: string): Promise<boolean> {
    // Fetch rollout percentage from Supabase
    const res = await fetch(`https://your-project.supabase.co/rest/v1/releases?version=eq.${version}`, {
        headers: { apikey: SUPABASE_ANON_KEY }
    });
    const [release] = await res.json();
    if (!release) return false;

    // Mandatory update — always eligible
    if (release.is_mandatory) return true;

    // Staged rollout: hash the machine ID to get a deterministic 0-99 value
    const machineHash = hashCode(getMachineId()) % 100;
    return machineHash < release.rollout_percentage;
}
```

### Rollout Strategy (Admin Panel Controls)

From the admin dashboard, you control:

| Control | Purpose |
|---------|---------|
| **Rollout %** | Start at 5%, monitor for crashes, increase to 25% → 50% → 100% |
| **Mandatory flag** | Force-update for security fixes or breaking API changes |
| **Min supported version** | Versions below this see "update required" on launch |
| **Release notes** | Shown in the update toast — what changed |
| **Pause rollout** | Set % to 0 if a critical bug is found post-release |

### Release Workflow (Your Process)

```
1. Bump version in package.json
2. npm run build
3. Upload .exe to GitHub Releases (or Supabase Storage)
4. In admin panel: create release record with rollout_percentage = 5
5. Monitor error reports for 24 hours
6. Increase to 50%, then 100%
```

---

## 4. Document & Image Generation

### What This Is NOT

This is NOT "save chat as PDF." The app already has copy-all-chat. This is **full document generation** — the user says "create a budget spreadsheet" and gets a real `.xlsx` file. The user says "make a presentation about our Q1 results" and gets a real `.pptx`.

### What This IS

The AI becomes a **document factory**. It generates the content AND the correctly formatted file, ready to open in the native application.

### Constraint Analysis

| Capability | LLM Can Do It? | App Supports It? | Gap |
|-----------|----------------|-------------------|-----|
| Generate structured content (text, tables, lists) | Yes | Yes (displayed in chat) | None |
| Generate images (diagrams, illustrations, logos) | Yes — Gemini supports image output | No — app never calls image gen API | **App constraint** |
| Create PDF with layout, headings, tables | LLM generates the content; app must render it | No — `pdfjs-dist` is read-only | **App constraint** |
| Create DOCX with styles, sections, headers | LLM generates the content; app must render it | No — `mammoth` is read-only | **App constraint** |
| Create XLSX with formulas, sheets, formatting | LLM can generate structured JSON; app must write it | `xlsx` is installed but only used for reading | **App constraint** |
| Create PPTX with slides, layouts, charts | LLM can generate slide structure; app must render it | No library installed | **App constraint** |
| Create MD / TXT / CSV / JSON | LLM generates the content directly | No save-to-file mechanism | **App constraint** |

**Every gap is an app constraint.** The LLM already knows how to create the content. The app just doesn't know how to write it to a file in the correct format.

---

### 4.1 — Generation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  USER REQUEST                                                    │
│  "Create a project budget spreadsheet with Q1-Q4 columns"       │
│                                                                  │
│      ↓  Intent Detection (is this a generation request?)         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  STEP 1: AI generates structured output                    │  │
│  │                                                            │  │
│  │  The AI is prompted with a format-specific system prompt   │  │
│  │  that tells it to output structured JSON, not markdown.    │  │
│  │                                                            │  │
│  │  For XLSX: → JSON with sheets, rows, columns, formulas    │  │
│  │  For DOCX: → JSON with sections, headings, paragraphs     │  │
│  │  For PPTX: → JSON with slides, titles, bullet points      │  │
│  │  For PDF:  → Markdown with explicit heading levels         │  │
│  │  For Image:→ Gemini image generation API (direct output)   │  │
│  │  For plain:→ Raw text (MD, TXT, CSV, JSON, code files)    │  │
│  └────────────────────────────┬───────────────────────────────┘  │
│                               ↓                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  STEP 2: Preview in chat                                   │  │
│  │                                                            │  │
│  │  Show the user a preview of what was generated:            │  │
│  │  - Spreadsheet → rendered table in chat                    │  │
│  │  - Document → formatted text with headings                 │  │
│  │  - Presentation → slide thumbnails                         │  │
│  │  - Image → inline image preview                            │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Here's your budget spreadsheet:                     │  │  │
│  │  │                                                      │  │  │
│  │  │  | Category    | Q1    | Q2    | Q3    | Q4    |     │  │  │
│  │  │  |-------------|-------|-------|-------|-------|     │  │  │
│  │  │  | Engineering | 120K  | 130K  | 125K  | 140K  |     │  │  │
│  │  │  | Marketing   | 45K   | 50K   | 55K   | 60K   |     │  │  │
│  │  │  | Operations  | 30K   | 30K   | 35K   | 35K   |     │  │  │
│  │  │  | Total       | =SUM  | =SUM  | =SUM  | =SUM  |     │  │  │
│  │  │                                                      │  │  │
│  │  │  [ Download .xlsx ]  [ Revise ]  [ Add Sheet ]       │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────┬───────────────────────────────┘  │
│                               ↓                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  STEP 3: File generation + save                            │  │
│  │                                                            │  │
│  │  User clicks "Download .xlsx" →                            │  │
│  │  App takes the structured JSON → writes real file →        │  │
│  │  Save dialog → file on disk                                │  │
│  │                                                            │  │
│  │  OR user clicks "Revise" →                                 │  │
│  │  "Add a row for R&D budget" →                              │  │
│  │  AI regenerates with changes → new preview → download      │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 — Format-Specific Generation Prompts

Each output format gets a dedicated system prompt that tells the AI **how to structure its output** so the app can parse it into a real file.

#### XLSX Generation Prompt

```
You are a spreadsheet generation assistant. The user wants an Excel file.

OUTPUT FORMAT (strict JSON, no markdown wrapping):
{
  "filename": "suggested_filename.xlsx",
  "sheets": [
    {
      "name": "Sheet1",
      "columns": [
        { "header": "Column Name", "width": 15 }
      ],
      "rows": [
        ["value1", "value2", 123, "=SUM(B2:B10)"],
        ["value3", "value4", 456, "=SUM(B2:B10)"]
      ],
      "formatting": {
        "headerStyle": "bold",
        "numberColumns": [2, 3],
        "currencyColumns": [3]
      }
    }
  ]
}

RULES:
- Use real Excel formulas (=SUM, =AVERAGE, =IF, =VLOOKUP, etc.)
- Include column widths appropriate to the content
- Use multiple sheets if the data is logically separable
- Include a Totals/Summary row where appropriate
- Currency values should be numbers, not strings with $ signs
```

#### DOCX Generation Prompt

```
You are a document generation assistant. The user wants a Word document.

OUTPUT FORMAT (strict JSON, no markdown wrapping):
{
  "filename": "suggested_filename.docx",
  "metadata": {
    "title": "Document Title",
    "author": "ALT+Space",
    "subject": "Brief description"
  },
  "sections": [
    {
      "type": "heading1",
      "text": "Main Heading"
    },
    {
      "type": "paragraph",
      "text": "Body text here. Can include **bold** and *italic* markers."
    },
    {
      "type": "heading2",
      "text": "Sub Heading"
    },
    {
      "type": "bullet_list",
      "items": ["Point one", "Point two", "Point three"]
    },
    {
      "type": "numbered_list",
      "items": ["Step one", "Step two", "Step three"]
    },
    {
      "type": "table",
      "headers": ["Col A", "Col B", "Col C"],
      "rows": [["val1", "val2", "val3"]]
    },
    {
      "type": "page_break"
    }
  ]
}

RULES:
- Use heading1 for main sections, heading2 for subsections
- Tables must have headers
- Keep paragraphs focused — one idea per paragraph
- Include page breaks between major sections for documents > 2 pages
- Use professional tone unless the user specifies otherwise
```

#### PPTX Generation Prompt

```
You are a presentation generation assistant. The user wants a PowerPoint file.

OUTPUT FORMAT (strict JSON, no markdown wrapping):
{
  "filename": "suggested_filename.pptx",
  "theme": "professional",
  "slides": [
    {
      "layout": "title",
      "title": "Presentation Title",
      "subtitle": "Author or date"
    },
    {
      "layout": "content",
      "title": "Slide Title",
      "bullets": [
        "Key point one — keep it short",
        "Key point two — one line each",
        "Key point three — maximum 6 bullets per slide"
      ],
      "notes": "Speaker notes go here — full sentences, details the bullets don't cover"
    },
    {
      "layout": "two-column",
      "title": "Comparison",
      "left": { "header": "Option A", "bullets": ["Point 1", "Point 2"] },
      "right": { "header": "Option B", "bullets": ["Point 1", "Point 2"] }
    },
    {
      "layout": "table",
      "title": "Data Overview",
      "headers": ["Metric", "Q1", "Q2"],
      "rows": [["Revenue", "1.2M", "1.5M"]]
    },
    {
      "layout": "closing",
      "title": "Thank You",
      "subtitle": "Contact info or next steps"
    }
  ]
}

RULES:
- Maximum 6 bullets per slide
- Maximum 7 words per bullet
- Every slide must have speaker notes (the full explanation)
- Include a title slide and closing slide
- 8-15 slides for a standard presentation
- Use two-column layout for comparisons, table layout for data
```

#### PDF Generation

PDF uses markdown as intermediate format (since PDFs are layout-driven, and markdown-to-PDF libraries handle pagination):

```
Generate the content in clean markdown with:
- # for main headings (become PDF section headers)
- ## for subheadings
- Tables in markdown format
- Bold for emphasis
- No HTML tags

The app will render this markdown into a styled PDF with proper pagination,
fonts, margins, and table formatting.
```

#### Image Generation

Direct Gemini image generation API — no intermediate format needed:

```typescript
// src/api/gemini.ts

async function generateImage(prompt: string): Promise<{ base64: string; mimeType: string }> {
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        generationConfig: {
            responseModalities: ['image', 'text'],
        }
    });

    const result = await model.generateContent(prompt);
    const response = result.response;

    for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
            return {
                base64: part.inlineData.data,
                mimeType: part.inlineData.mimeType
            };
        }
    }
    throw new Error('No image generated');
}
```

#### Plain Text Formats (MD, TXT, CSV, JSON, code files)

No special prompt needed — the AI generates the raw content, and the app writes it directly to a file. The only addition is detecting the output type and offering a save button:

```
User: "Generate a README.md for this project"
AI: Returns raw markdown content
App: Displays in chat + shows [ Download README.md ] button
     Click → save dialog → fs.writeFile
```

---

### 4.3 — Intent Detection for Generation Requests

The AI needs to know when a user is asking for a document vs asking a question. Add a generation intent classifier:

```typescript
type GenerationFormat = 'xlsx' | 'docx' | 'pptx' | 'pdf' | 'image' | 'md' | 'txt' | 'csv' | 'json' | 'code';

interface GenerationIntent {
    isGeneration: boolean;
    format: GenerationFormat;
    description: string;  // "Budget spreadsheet with quarterly columns"
}

// Detection heuristics (fast, no API call needed):
const GENERATION_SIGNALS: Record<string, GenerationFormat[]> = {
    'create': ['docx', 'xlsx', 'pptx', 'pdf'],
    'generate': ['docx', 'xlsx', 'pptx', 'pdf', 'image'],
    'make': ['docx', 'xlsx', 'pptx', 'image'],
    'build': ['xlsx', 'code'],
    'draw': ['image'],
    'design': ['image', 'pptx'],
    'write': ['docx', 'md', 'txt', 'code'],
    'draft': ['docx', 'md'],
    'spreadsheet': ['xlsx'],
    'presentation': ['pptx'],
    'slide': ['pptx'],
    'document': ['docx'],
    'report': ['docx', 'pdf'],
    'letter': ['docx', 'pdf'],
    'resume': ['docx', 'pdf'],
    'invoice': ['xlsx', 'pdf'],
    'chart': ['image'],
    'diagram': ['image'],
    'logo': ['image'],
    'table': ['xlsx'],
    'csv': ['csv'],
};
```

When a generation intent is detected, the app:
1. Selects the format-specific generation prompt
2. Appends it to the user's message as the system instruction
3. Parses the AI's structured JSON output
4. Renders the preview in chat
5. Shows the download button

If the format is ambiguous (e.g., "create a report" — could be DOCX or PDF), show a format picker:

```
┌──────────────────────────────────────────────┐
│  What format would you like?                  │
│                                               │
│  [ PDF ]  [ Word ]  [ Markdown ]              │
│                                               │
└──────────────────────────────────────────────┘
```

---

### 4.4 — File Writers (Main Process)

All file writing happens in the Electron main process via IPC:

```typescript
// electron/fileGenerators/xlsxGenerator.ts
import XLSX from 'xlsx';

function generateXLSX(spec: XLSXSpec): Buffer {
    const workbook = XLSX.utils.book_new();
    for (const sheet of spec.sheets) {
        const data = [sheet.columns.map(c => c.header), ...sheet.rows];
        const ws = XLSX.utils.aoa_to_sheet(data);
        // Apply column widths
        ws['!cols'] = sheet.columns.map(c => ({ wch: c.width }));
        XLSX.utils.book_append_sheet(workbook, ws, sheet.name);
    }
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// electron/fileGenerators/docxGenerator.ts
import { Document, Paragraph, TextRun, HeadingLevel, Table, Packer } from 'docx';

async function generateDOCX(spec: DOCXSpec): Promise<Buffer> {
    const children = spec.sections.map(section => {
        switch (section.type) {
            case 'heading1':
                return new Paragraph({ text: section.text, heading: HeadingLevel.HEADING_1 });
            case 'heading2':
                return new Paragraph({ text: section.text, heading: HeadingLevel.HEADING_2 });
            case 'paragraph':
                return new Paragraph({ children: parseInlineFormatting(section.text) });
            case 'bullet_list':
                return section.items.map(item =>
                    new Paragraph({ text: item, bullet: { level: 0 } })
                );
            case 'table':
                return buildTable(section.headers, section.rows);
            // ... other types
        }
    }).flat();

    const doc = new Document({
        creator: spec.metadata?.author || 'ALT+Space',
        title: spec.metadata?.title,
        sections: [{ children }]
    });
    return Packer.toBuffer(doc);
}

// electron/fileGenerators/pptxGenerator.ts
import PptxGenJS from 'pptxgenjs';

function generatePPTX(spec: PPTXSpec): Promise<Buffer> {
    const pptx = new PptxGenJS();
    for (const slide of spec.slides) {
        const s = pptx.addSlide();
        switch (slide.layout) {
            case 'title':
                s.addText(slide.title, { x: 1, y: 2, fontSize: 36, bold: true });
                s.addText(slide.subtitle, { x: 1, y: 3.5, fontSize: 18, color: '666666' });
                break;
            case 'content':
                s.addText(slide.title, { x: 0.5, y: 0.3, fontSize: 24, bold: true });
                slide.bullets.forEach((b, i) => {
                    s.addText(b, { x: 1, y: 1.2 + i * 0.6, fontSize: 16, bullet: true });
                });
                break;
            case 'table':
                s.addText(slide.title, { x: 0.5, y: 0.3, fontSize: 24, bold: true });
                s.addTable([slide.headers, ...slide.rows], { x: 0.5, y: 1.2, w: 9 });
                break;
        }
        if (slide.notes) s.addNotes(slide.notes);
    }
    return pptx.write({ outputType: 'nodebuffer' });
}

// electron/fileGenerators/pdfGenerator.ts
// Uses markdown-pdf or pdfkit to render markdown → styled PDF
```

**IPC handler:**

```typescript
// electron/main.ts
ipcMain.handle('generate-file', async (_event, { format, spec }) => {
    let buffer: Buffer;
    let defaultExt: string;

    switch (format) {
        case 'xlsx': buffer = generateXLSX(spec); defaultExt = 'xlsx'; break;
        case 'docx': buffer = await generateDOCX(spec); defaultExt = 'docx'; break;
        case 'pptx': buffer = await generatePPTX(spec); defaultExt = 'pptx'; break;
        case 'pdf':  buffer = await generatePDF(spec); defaultExt = 'pdf'; break;
        default:     buffer = Buffer.from(spec.content, 'utf-8'); defaultExt = format; break;
    }

    const { filePath } = await dialog.showSaveDialog({
        defaultPath: spec.filename || `generated.${defaultExt}`,
        filters: [{ name: format.toUpperCase(), extensions: [defaultExt] }]
    });

    if (filePath) {
        fs.writeFileSync(filePath, buffer);
        return { success: true, path: filePath };
    }
    return { success: false, reason: 'cancelled' };
});
```

---

### 4.5 — Iterative Refinement

The real power is **revision without regenerating from scratch**. After the AI generates a document:

```
User: "Create a project proposal document"
AI: Generates DOCX spec → preview in chat → [Download .docx]

User: "Add a budget section with a table"
AI: Takes the PREVIOUS spec, adds the section → new preview → [Download .docx]

User: "Change the title to 'Q2 Initiative Proposal'"
AI: Modifies the existing spec → new preview → [Download .docx]
```

This works because the structured JSON spec is kept in the conversation context. Each revision is a delta on the previous spec, not a full regeneration. This does cost tokens (the full spec is in context), but it's the only way to get real iterative document editing.

---

### 4.6 — Image Generation

Gemini supports direct image output. The app needs to:

1. Detect image generation intent ("draw", "create an image", "design a logo", "generate a chart")
2. Call Gemini with `responseModalities: ['image', 'text']`
3. Display the image inline in chat
4. Offer save button (PNG/JPG)

```typescript
// src/api/gemini.ts

async function generateImage(prompt: string): Promise<{ base64: string; mimeType: string }> {
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        generationConfig: {
            responseModalities: ['image', 'text'],
        }
    });

    const result = await model.generateContent(prompt);
    const response = result.response;

    for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
            return {
                base64: part.inlineData.data,
                mimeType: part.inlineData.mimeType
            };
        }
    }
    throw new Error('No image generated');
}
```

**Supported image generation use cases:**
- Diagrams and flowcharts
- Logos and icons
- Charts and data visualizations
- Illustrations and concept art
- UI mockups and wireframes
- Infographics

**Image in chat UI:**

```
┌──────────────────────────────────────────────┐
│  Here's the system architecture diagram:      │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │                                         │  │
│  │         [Generated Image]               │  │
│  │                                         │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  [ Save PNG ] [ Save JPG ] [ Revise ] [ Copy ]│
└──────────────────────────────────────────────┘
```

---

### 4.7 — Dependencies

```bash
# Document generation
npm install docx           # DOCX writer (pure JS, no native deps)
npm install pptxgenjs      # PPTX writer (pure JS)
npm install pdfkit         # PDF writer (pure JS, supports fonts/tables/images)

# Already installed (used for reading, now also for writing)
# xlsx                     # XLSX read/write (already in package.json)

# No new deps needed for:
# - MD, TXT, CSV, JSON     → direct fs.writeFile
# - Image generation        → Gemini API (already connected)
```

### 4.8 — Token Cost Reality

| Format | Typical Input Tokens | Typical Output Tokens | Gemini 2.5 Flash Cost |
|--------|---------------------|----------------------|----------------------|
| XLSX (10-row table) | ~500 | ~800 | ~$0.0003 |
| DOCX (2-page doc) | ~500 | ~2,000 | ~$0.0006 |
| PPTX (10 slides) | ~500 | ~3,000 | ~$0.001 |
| PDF (5-page report) | ~500 | ~4,000 | ~$0.0015 |
| Image (single) | ~100 | ~1,000 + image | ~$0.003 |
| Revision (delta) | ~3,000 (full spec in context) | ~1,500 | ~$0.001 |

**Bottom line:** Even a complex 10-slide presentation costs under $0.002. A full revision cycle (generate + 3 revisions) costs under $0.01. Token cost is not a meaningful concern for document generation.

---

## 5. Implementation Phases

### Phase 1 — Auth + Token Storage (1 week)

| Task | Effort |
|------|--------|
| Set up Supabase project | 1 hour |
| Create `profiles`, `licenses` tables | 2 hours |
| Build `tokenStore.ts` with safeStorage | 3 hours |
| Build `authService.ts` (login, logout, refresh) | 4 hours |
| Build `LoginScreen.tsx` | 6 hours |
| Wire auth guard into app launch flow | 4 hours |
| Add Google/Microsoft OAuth | 4 hours |
| Test: login → use app → restart → auto-login → logout | 2 hours |

### Phase 2 — Auto-Update System (3-4 days)

| Task | Effort |
|------|--------|
| `npm install electron-updater` | 10 min |
| Build `electron/updater.ts` | 4 hours |
| Add update UI (toast notification + progress bar) | 3 hours |
| Set up GitHub Releases (or Supabase Storage) | 2 hours |
| Add staged rollout logic | 3 hours |
| Test: build v1.0.1 → publish → v1.0.0 detects and updates | 3 hours |
| Add `publish` config to package.json | 30 min |

### Phase 3 — Document & Image Generation Engine (2 weeks)

**Sub-phase 3a — Infrastructure (3 days)**

| Task | Effort |
|------|--------|
| `npm install docx pptxgenjs pdfkit` | 10 min |
| Build `generate-file` IPC handler with save dialog | 3 hours |
| Build generation intent detector (keyword heuristics) | 4 hours |
| Build format picker UI (when format is ambiguous) | 3 hours |
| Add format-specific generation prompts (XLSX, DOCX, PPTX, PDF) | 6 hours |

**Sub-phase 3b — File Writers (4 days)**

| Task | Effort |
|------|--------|
| Build `xlsxGenerator.ts` — JSON spec → real .xlsx with formulas, widths, sheets | 6 hours |
| Build `docxGenerator.ts` — JSON spec → real .docx with headings, tables, lists | 8 hours |
| Build `pptxGenerator.ts` — JSON spec → real .pptx with layouts, notes, tables | 8 hours |
| Build `pdfGenerator.ts` — markdown → styled PDF with pagination | 6 hours |
| Plain text handler (MD, TXT, CSV, JSON, code) — direct write | 2 hours |

**Sub-phase 3c — Chat Integration (3 days)**

| Task | Effort |
|------|--------|
| Add structured preview in chat (table render for XLSX, formatted text for DOCX) | 6 hours |
| Add download button per format on generated responses | 3 hours |
| Add "Revise" button — iterative refinement without full regeneration | 4 hours |
| Add `generateImage()` to gemini.ts + inline image display in chat | 4 hours |
| Add image save buttons (PNG, JPG) | 2 hours |
| Test all formats: XLSX, DOCX, PPTX, PDF, MD, TXT, CSV, Image | 4 hours |

### Phase 5 — Admin Panel (1-2 weeks)

| Task | Effort |
|------|--------|
| Scaffold Next.js project | 1 hour |
| Users page (list, search, tier management) | 8 hours |
| Licenses page (generate, revoke, track) | 6 hours |
| Analytics page (charts, usage data) | 8 hours |
| Config page (feature flags, model defaults) | 4 hours |
| Updates page (upload, rollout control) | 6 hours |
| Deploy to Vercel | 1 hour |
| RLS policies for admin-only access | 2 hours |

### Total: ~6-7 weeks for all 4 phases

### Recommended Priority Order

```
1. Auth (everything else depends on knowing who the user is)
2. Auto-Updates (users need to get new versions without manual install)
3. Document & Image Generation (the killer feature — "create me a spreadsheet" → real file)
4. Admin Panel (only needed when you have users to manage)
```

---

## 6. Architecture Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                      ALT+Space Desktop App                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ Auth     │  │ Chat +   │  │ Agent    │  │ Doc Generator   │  │
│  │ Guard    │→ │ Actions  │  │ Mode     │  │ XLSX/DOCX/PPTX  │  │
│  │          │  │          │  │          │  │ PDF/IMG/MD/CSV   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬─────────┘  │
│       │             │             │                │             │
│       ↓             ↓             ↓                ↓             │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │               Electron Main Process                        │   │
│  │  auto-updater │ tokenStore │ file generators │ PS │ CDP   │   │
│  └──────────────────────┬────────────────────────────────────┘   │
└─────────────────────────┼────────────────────────────────────────┘
                          │
                          ↓
              ┌───────────────────────┐
              │      Supabase         │
              │  Auth │ DB │ Storage  │
              └───────────┬───────────┘
                          │
                          ↓
              ┌───────────────────────┐
              │   Admin Panel (Web)   │
              │   Next.js + Vercel    │
              └───────────────────────┘
```
