# MedAcademy — Developer Setup Guide

This guide covers everything needed to get the MedAcademy backend and mobile app running from a fresh clone. No manual Supabase Dashboard configuration is required beyond creating the project.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| pnpm | ≥ 8 | `npm i -g pnpm` |
| Supabase CLI | ≥ 1.200 | See below |
| Expo CLI | bundled | via pnpm |

### Install Supabase CLI

```bash
# macOS / Linux (Homebrew)
brew install supabase/tap/supabase

# Windows (Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# npm (cross-platform)
npm install -g supabase

# Verify
supabase --version
```

---

## 1. Clone the Repository

```bash
git clone <your-repo-url> medacademy
cd medacademy
pnpm install
```

---

## 2. Create a Supabase Project

1. Go to https://supabase.com and sign in.
2. Click **New Project**.
3. Choose your organisation, name it `medacademy`, select a region, and set a strong database password.
4. Wait for the project to finish provisioning (~2 minutes).
5. From **Project Settings → API**, copy:
   - **Project URL**
   - **anon / public key**
   - **service_role key** *(keep this secret)*
6. From **Project Settings → General**, copy the **Reference ID** (e.g. `xdvjwfuqipatkpimejcb`).
7. From **Project Settings → Database**, copy the **Database Password** you set in step 3.

---

## 3. Configure Environment Variables

The project enforces a strict **security boundary** between client and server secrets.

### Security boundary

```
┌─────────────────────────────────────────────┐
│  MOBILE APP BINARY (.env.local)             │
│  Prefix: EXPO_PUBLIC_  ← visible in APK     │
│                                             │
│  EXPO_PUBLIC_SUPABASE_URL                   │
│  EXPO_PUBLIC_SUPABASE_ANON_KEY              │
│  EXPO_PUBLIC_APP_ID          = medacademy   │
│  EXPO_PUBLIC_APP_SCHEME      = medacademy   │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  SERVER ONLY (never in app binary)          │
│                                             │
│  SUPABASE_PROJECT_ID   ← CLI only           │
│  SUPABASE_DB_PASSWORD  ← CLI only           │
│  SERVICE_ROLE_KEY          ← Edge Functions │
│  VDOCIPHER_API_SECRET      ← Edge Functions │
│  VDOCIPHER_WEBHOOK_SECRET  ← optional       │
│  APP_DOMAIN (optional)     ← Edge Functions │
└─────────────────────────────────────────────┘
```

### 3a. Mobile App Variables (client-safe)

These are bundled into the app binary. **Only public keys go here.**

```bash
cp .env.local.template .env.local
```

Open `.env.local` and fill in:

| Variable | Value | Where to get it |
|----------|-------|----------------|
| `EXPO_PUBLIC_SUPABASE_URL` | your URL | Supabase Dashboard → Project Settings → API → **Project URL** |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | your key | Supabase Dashboard → Project Settings → API → **anon / public** key |
| `EXPO_PUBLIC_APP_ID` | `medacademy` | Pre-filled — stable identifier, independent from Supabase |
| `EXPO_PUBLIC_APP_SCHEME` | `medacademy` | Pre-filled — change only if renaming the app |

> ⚠️ **NEVER add** `SERVICE_ROLE_KEY`, `DB_PASSWORD`, or `VDOCIPHER_API_SECRET` to `.env.local`.
> Variables prefixed `EXPO_PUBLIC_` are visible to anyone who decompiles the app binary.
>
> VdoCipher requires **no public key in the app**. The app requests a fresh OTP from the backend
> for every playback. Only `VDOCIPHER_API_SECRET` is needed, and it lives exclusively in the
> Edge Function runtime.

### 3b. Server-Side Secrets (CLI + Edge Functions only)

These **never touch the mobile app**. Two steps:

**Step 1 — Supabase CLI** (local terminal):

```bash
cp supabase/secrets.template supabase/.env.secrets
# supabase/.env.secrets is gitignored
```

Fill in `supabase/.env.secrets`:

| Variable | Where to get it |
|----------|----------------|
| `SUPABASE_PROJECT_ID` | Supabase Dashboard → Project Settings → General → **Reference ID** |
| `SUPABASE_DB_PASSWORD` | The password you set when creating the project |

**Step 2 — Edge Function secrets** (deployed encrypted to Supabase cloud):

```bash
supabase secrets set SERVICE_ROLE_KEY=<value>
supabase secrets set VDOCIPHER_API_SECRET=<value>
# optional: restrict VdoCipher OTP to your domain
# supabase secrets set APP_DOMAIN=medacademy.app
```

| Secret | Where to get it | Used by |
|--------|----------------|---------|
| `SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → **service_role / secret** key | credits, device-binding, activation-codes Edge Functions |
| `VDOCIPHER_API_SECRET` | VdoCipher Dashboard → Account → API Keys → **API Secret** | vdocipher-otp Edge Function — generates fresh OTP per playback request |
| `VDOCIPHER_WEBHOOK_SECRET` *(optional)* | Random string you set in VdoCipher Dashboard → Webhooks as the signing secret | Enables the `/vdocipher-otp/webhook` endpoint for encoding events; leave unset to disable |
| `APP_DOMAIN` *(optional)* | Your app domain, e.g. `medacademy.app` | vdocipher-otp whitelist — leave empty during development |

These are stored encrypted in Supabase's secret manager and injected at Edge Function runtime. They never appear in the repository or the app bundle.

---

## 4. Link Project to Supabase CLI

```bash
supabase login
supabase link --project-ref <your-project-ref>
# Enter your database password when prompted
```

---

## 5. Run Database Migrations

This applies all tables, indexes, RLS policies, functions and triggers to your remote Supabase project.

```bash
supabase db push
```

To verify migrations were applied:

```bash
supabase db diff
# Should output: No changes found
```

---

## 6. Seed the Database (Development Only)

Seeds default system configuration and course categories. **Do not run on production.**

```bash
supabase db reset --db-url "postgresql://postgres:<your-db-password>@db.<your-project-ref>.supabase.co:5432/postgres"
# This runs all migrations + seed.sql
```

Or seed only (without resetting):

```bash
psql "postgresql://postgres:<your-db-password>@db.<your-project-ref>.supabase.co:5432/postgres" \
  -f supabase/seed.sql
```

---

## 7. Configure Storage Buckets

Storage buckets are created by migration `00002_create_storage_buckets.sql`. Verify in the Supabase Dashboard under **Storage** that these buckets exist:

- `avatars` — public
- `course-images` — public
- `lesson-pdfs` — private
- `app-assets` — public

If they are missing, re-run:

```bash
supabase db push
```

---

## 8. Start the Mobile App (Local Development)

```bash
pnpm start
# or
pnpm run dev
```

Scan the QR code with **Expo Go** (iOS/Android) or press `w` for web preview.

---

## 9. Local Supabase Development (Optional)

Run a full local Supabase stack via Docker:

```bash
# Requires Docker Desktop
supabase start

# Apply migrations to local instance
supabase db reset

# Stop local instance
supabase stop
```

Local endpoints after `supabase start`:

| Service | URL |
|---------|-----|
| API | http://127.0.0.1:54321 |
| Studio | http://127.0.0.1:54323 |
| Inbucket (email) | http://127.0.0.1:54324 |
| DB | postgresql://127.0.0.1:54322/postgres |

For local dev, use `.env.development.local` (copy from `.env.development.example`) with the local URL `http://127.0.0.1:54321`.

---

## 10. Deploy Edge Functions

```bash
# Deploy all functions
supabase functions deploy

# Deploy a specific function
supabase functions deploy <function-name>

# Set function secrets
supabase secrets set VDOCIPHER_API_SECRET=<your-secret>
```

---

## 11. Deploy Schema Changes to Production

**Never modify existing migration files.** Always create a new migration:

```bash
# Create a new versioned migration
supabase migration new <description>
# e.g. supabase migration new add_video_progress_table

# Edit the new file in supabase/migrations/
# Then push to production
supabase db push
```

---

## Migration Files

| File | Description |
|------|-------------|
| `00001_create_medacademy_schema.sql` | Full schema: profiles, courses, lessons, devices, credits, activation codes, audit logs, notifications |
| `00002_create_storage_buckets.sql` | Storage buckets and RLS policies |
| `00003_assistant_doctor_ownership_model.sql` | Doctor–Assistant relationship, role promotion functions, granular permission columns |

---

## Environment Files Reference

| File | Purpose |
|------|---------|
| `.env.example` | Template — commit this |
| `.env.development.example` | Local dev template — commit this |
| `.env.staging.example` | Staging template — commit this |
| `.env.production.example` | Production template — commit this |
| `.env.local` | Your real credentials — **gitignored** |
| `.env.development.local` | Local dev credentials — **gitignored** |
| `.env.staging.local` | Staging credentials — **gitignored** |
| `.env.production.local` | Production credentials — **gitignored** |

---

## Security Notes

- **Password reset** only changes the auth credential. It does NOT affect: trusted device, device binding, login history, credits, activation codes, course enrollments, or video progress. This is enforced by database design — Supabase `resetPasswordForEmail` only touches `auth.users`.
- **Service role key** is never exposed to the client. It is only used in Edge Functions or CLI operations.
- **RLS policies** are applied to every table. All data access is controlled by `auth.uid()` at the database level.
- **Migrations** are idempotent where possible (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

---

## Backup & Restore

### Manual backup
```bash
pg_dump "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
  --format=custom \
  --no-acl \
  --no-owner \
  -f backup_$(date +%Y%m%d_%H%M%S).dump
```

### Restore
```bash
pg_restore \
  --verbose \
  --no-acl \
  --no-owner \
  -d "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
  backup_YYYYMMDD_HHMMSS.dump
```

### Automated backups
Supabase Pro plans include daily automated backups with point-in-time recovery. For additional backup schedules, use the Supabase Management API or `pg_dump` in a scheduled CI job.

---

## Portable Workflow Summary

```
git clone <repo>
↓
pnpm install
↓
cp .env.local.template .env.local  →  fill in your credentials
↓
supabase login
supabase link --project-ref <ref>
↓
supabase db push
↓
pnpm start
```

That's it. No manual dashboard table creation. No platform-specific setup.

### What gets committed to git

| File | Committed | Contains secrets |
|------|-----------|-----------------|
| `.env.local.template` | ✅ Yes | ❌ No — client-safe placeholders only |
| `.env.example` | ✅ Yes | ❌ No — client-safe placeholders only |
| `supabase/secrets.template` | ✅ Yes | ❌ No — server-side placeholders only |
| `.env.local` | ❌ No (gitignored) | ✅ Yes — your client credentials |
| `supabase/.env.secrets` | ❌ No (gitignored) | ✅ Yes — your CLI credentials |
| Edge Function secrets | ❌ Never in repo | ✅ Encrypted in Supabase cloud |

**Security guarantee**: `SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, and `VDOCIPHER_API_SECRET` never appear in any file that reaches the mobile app binary. The repository is the single source of truth.
