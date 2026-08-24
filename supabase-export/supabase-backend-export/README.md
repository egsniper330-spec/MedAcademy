# MedAcademy — Supabase Backend Export
**Complete forensic snapshot for PHP/MySQL migration**

| Field | Value |
|-------|-------|
| Project | MedAcademy (Medical Education Platform) |
| Supabase Project ID | xdvjwfuqipatkpimejcb |
| Supabase URL | https://xdvjwfuqipatkpimejcb.supabase.co |
| Export Generated | 2026-07-13 |
| App Type | Expo React Native (iOS + Android) |
| Platform Currency | EGP (Egyptian Pound) |

---

## ⚠️ Security Notice

**This export does NOT contain:**
- Plaintext passwords (never stored)
- Service role keys or JWT secrets
- VdoCipher API keys
- Google Play Integrity keys
- Any live credentials

All sensitive secrets are documented as `NOT_EXPORTABLE` in
`secrets/required-secrets.env.example`.

---

## Directory Structure

```
supabase-backend-export/
│
├── README.md                          ← This file
├── migration-inventory.json           ← Complete component inventory
├── database-inventory.json            ← All tables, enums, views, indexes
├── rpc-inventory.json                 ← All 59 PostgreSQL RPCs/functions
├── edge-functions-inventory.json      ← All 42 Edge Functions
├── frontend-supabase-usage.json       ← Frontend dependency map
├── migration-gap-report.md            ← Supabase → PHP/MySQL gap analysis
│
├── database/
│   ├── schema.sql                     ← Canonical CREATE TABLE statements
│   ├── enums/
│   │   └── enums.sql                  ← All 18 PostgreSQL enum types
│   ├── functions/
│   │   └── functions.sql              ← All trigger fns + key RPCs with source
│   ├── triggers/
│   │   └── triggers.sql               ← All 25 trigger definitions
│   ├── views/
│   │   └── views.sql                  ← All 9 documented view definitions
│   ├── policies/
│   │   └── rls_policies.sql           ← All 110+ RLS policies
│   └── indexes/
│       └── indexes.sql                ← All key performance indexes
│
├── data/
│   ├── seed/
│   │   ├── categories.sql             ← 12 medical categories
│   │   └── universities_faculties_levels.sql  ← Horus University tree (19 rows)
│   └── configuration/
│       ├── system_config.sql          ← 10 system config rows
│       ├── feature_flags.sql          ← 9 feature flags
│       ├── security_policies.sql      ← 15 security detection policies
│       └── support_settings.sql       ← 3 support channel settings
│
├── edge-functions/
│   ├── _shared/                       ← Shared Deno modules
│   │   ├── auth.ts                    ← requireAuth, createServiceClient, etc.
│   │   ├── enums.ts                   ← Shared enum definitions
│   │   ├── phone.ts                   ← Phone number normalization (E.164)
│   │   └── provider-check.ts          ← Video provider permission checks
│   ├── activation-codes/              ← Full code lifecycle management
│   ├── admin-doctor-earnings/         ← Doctor earnings admin panel
│   ├── admin-enrollment/              ← Admin student enrollment
│   ├── admin-update-email/            ← Admin email change
│   ├── auth-probe/                    ← [DIAGNOSTIC - delete after migration]
│   ├── block-user/                    ← Block/unblock users
│   ├── bootstrap-super-admin/         ← [ONE-TIME - delete after use]
│   ├── bulk-user-ops/                 ← Bulk user management
│   ├── change-password/               ← Password change (self + admin)
│   ├── credits/                       ← Credit allocation/refund/revoke
│   ├── delete-course/                 ← Course + video deletion
│   ├── delete-lesson/                 ← Lesson + video deletion
│   ├── delete-user/                   ← Full user + data deletion
│   ├── device-binding/                ← Device registration/verification
│   ├── get-security-config/           ← Security config for mobile client
│   ├── get-security-version/          ← Security config version hash
│   ├── get-signed-url/                ← Private storage signed URLs
│   ├── impersonate/                   ← Admin user impersonation
│   ├── process-violation/             ← Content protection strikes
│   ├── provider-health/               ← VdoCipher API health check
│   ├── restore-account/               ← Restore trashed/suspended accounts
│   ├── security-logger/               ← Client-side security event logging
│   ├── student-operations/            ← Doctor manages students
│   ├── system-health/                 ← Platform health dashboard
│   ├── trash-cleanup/                 ← [CRON] Daily trash purge
│   ├── trash-user/                    ← Soft-delete (trash) user
│   ├── upload-patch/                  ← OTA patch ZIP upload
│   ├── user-lookup/                   ← Universal user search
│   ├── user-management/               ← Create users (all roles)
│   ├── vdocipher-debug-creds/         ← [DEBUG - delete after migration]
│   ├── vdocipher-delete-video/        ← Delete VdoCipher video
│   ├── vdocipher-orphan-cleanup/      ← Clean orphan VdoCipher videos
│   ├── vdocipher-otp/                 ← Video playback OTP + webhook
│   ├── vdocipher-upload-init/         ← Initialize video upload
│   ├── vdocipher-upload-status/       ← Poll video processing status
│   ├── verify-play-integrity/         ← Android Play Integrity check
│   ├── video-assemble-upload/         ← Assemble chunked video upload
│   ├── video-daily-health/            ← [CRON] Daily video health check
│   ├── video-health-scan/             ← On-demand video health scan
│   └── video-upload-chunk/            ← Upload single video chunk
│   (verify-app-integrity: NOT ON DISK — deployed separately)
│
├── auth/
│   └── auth-inventory.json            ← Auth config, user mapping, limitations
│
├── storage/
│   └── storage-inventory.json         ← All 8 buckets with policies
│
├── integrations/
│   └── integrations-inventory.json    ← VdoCipher, Play Integrity, cron, webhooks
│
└── secrets/
    └── required-secrets.env.example   ← All env vars (values redacted)
```

---

## System Architecture

```
Mobile App (Expo React Native)
         │
         │ HTTPS / Supabase JS Client
         ▼
┌─────────────────────────────────────────┐
│          Supabase Platform              │
│  ┌─────────┐  ┌──────────────────────┐ │
│  │  Auth   │  │  Edge Functions (42) │ │
│  │ (GoTrue)│  │  Deno Runtime        │ │
│  └────┬────┘  └──────────┬───────────┘ │
│       │                  │             │
│  ┌────▼──────────────────▼──────────┐  │
│  │     PostgreSQL Database          │  │
│  │   60 tables, 59 RPCs, 25 triggers│  │
│  │   110+ RLS policies, 18 enums    │  │
│  └──────────────────────────────────┘  │
│  ┌──────────┐  ┌───────────────────┐   │
│  │ Storage  │  │    Realtime       │   │
│  │ 8 buckets│  │ 9 subscribed tbls │   │
│  └──────────┘  └───────────────────┘   │
└─────────────────────────────────────────┘
         │
         │ REST API calls
         ▼
    VdoCipher (video DRM)
    Google Play Integrity (Android attestation)
```

---

## User Roles

| Role | Permissions |
|------|------------|
| `student` | View enrolled courses, track progress, redeem codes, manage own devices |
| `doctor` | All student permissions + create courses, upload videos, manage own students |
| `assistant` | Same as doctor |
| `admin` | All doctor permissions + manage users, credits, codes, security settings |
| `super_admin` | All admin permissions + reset platform earnings, impersonate users, bootstrap |

---

## Key Business Flows

### Student Enrollment Flow
1. Student redeems activation code → credits added to wallet (RPC: `redeem_activation_code`)
2. Student purchases course with credits → enrollment created (RPC: `grant_course_access` or credit deduction flow)
3. Student watches video → VdoCipher OTP generated (`vdocipher-otp` Edge Function)
4. Doctor earns credits when student enrolls

### Video Upload Flow
1. Doctor initiates upload → `vdocipher-upload-init` creates VdoCipher upload slot
2. `video-upload-chunk` uploads chunks to Supabase Storage
3. `video-assemble-upload` assembles chunks and transfers to VdoCipher
4. VdoCipher processes video → sends webhook to `vdocipher-otp` endpoint
5. Video status updated in `video_uploads` and `video_assets`

### Security Flow
1. App startup: `get-security-config` fetches current policies
2. Mobile SDK detects threat → `security-logger` logs event
3. `verify-play-integrity` / `verify-app-integrity` on login (Android/iOS)
4. `pre_login_device_check` RPC validates device binding + limits
5. `device-binding` registers new device after successful login

---

## Reproduction Instructions (PHP/MySQL)

### Step 1 — Database
```sql
-- 1. Run enums → in MySQL: replace with ENUM columns or lookup tables
-- 2. Run schema.sql (adapt PostgreSQL syntax to MySQL)
-- 3. Run data/seed/*.sql
-- 4. Run data/configuration/*.sql
```

### Step 2 — Authentication
```php
// Replace Supabase Auth with JWT-based auth
// composer require firebase/php-jwt
// Implement: register, login, refresh, logout
// Post-register: create profiles + credits rows (replaces handle_new_user trigger)
```

### Step 3 — Edge Functions
```
Each Edge Function → PHP endpoint in /api/
See edge-functions-inventory.json for exact:
  - HTTP method
  - Auth requirements
  - Request/response structure
  - Tables accessed
  - External APIs called
```

### Step 4 — VdoCipher
```
Same VdoCipher REST API works from PHP.
Keep VDOCIPHER_API_SECRET — same value.
Update webhook URL in VdoCipher dashboard to new PHP endpoint.
```

### Step 5 — Cron Jobs (cPanel)
```
0 2 * * *  php /home/user/artisan trash:cleanup   (replaces trash-cleanup Edge Function)
0 3 * * *  php /home/user/artisan video:health    (replaces video-daily-health Edge Function)
```

---

## Counts at Export

| Component | Count |
|-----------|-------|
| Public tables | 60 |
| Custom enums | 18 |
| Database views | 30 |
| Database indexes | 200+ |
| RLS policies | 110+ |
| DB functions/RPCs | 59 |
| Triggers | 25 |
| Edge Functions | 42 |
| Storage buckets | 8 |
| Auth components | 12 |
| Cron jobs | 2 |
| Webhooks | 1 |
| External integrations | 3 |
| Environment variables | 14 |
| Non-exportable secrets | 9 |
| API entry points | 85+ |
| Frontend Supabase dependencies | 57 tables/views |
| Frontend RPC calls | 56 RPCs |
| Frontend Edge Function invocations | 19 functions |
| Frontend auth methods | 12 |

---

## Known Limitations

1. **Password hashes** — NOT EXPORTABLE. Supabase does not expose
   `auth.users.encrypted_password` via the SQL editor or API.
   All users must reset passwords on migration to PHP.

2. **verify-app-integrity Edge Function** — Source code NOT found on disk.
   Function is invoked by frontend but was deployed separately or removed
   from the repository. Must be re-implemented for PHP migration.

3. **auth-probe Edge Function** — Diagnostic only. Delete before migration.

4. **Push notifications** — No FCM/APNs integration found in backend.
   Notifications are stored in `public.notifications` table as in-app only.

5. **Full RPC source code** — Key functions are documented with full source.
   Remaining RPCs follow the same SECURITY DEFINER pattern. Full source
   available via Supabase Studio → Database → Functions.

---

*This export was generated by an automated forensic scan of the live Supabase project.*
*Do not commit this archive to public version control.*
