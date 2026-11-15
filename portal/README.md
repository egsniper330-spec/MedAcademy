# MedAcademy Staff Portal

A separate React + TypeScript + Vite web portal for **Doctor**, **Admin** and
**Super Admin** accounts. It talks to the existing PHP API
(`https://api.medacademy.site`) and the same MySQL data as the mobile app.
Students are rejected by the server and cannot obtain a portal session.

## Quick start

```bash
cd portal
cp .env.example .env       # VITE_API_URL only; no secrets
npm ci
npm run dev                # http://localhost:5173
```

Production build and checks:

```bash
npm test                   # Vitest: role matrix, portal login, backend contract
npm run build              # tsc -b && vite build → dist/
```

The built app is static; no Node process is required on the host.

## Authentication

- `POST /portal/auth/login` (new, backward-compatible backend endpoint) runs the
  same credential/status/device/audit pipeline as `/auth/login`, then checks the
  **database role** before issuing a session. Allowed: `doctor`, `admin`,
  `super_admin`. A student receives `403 portal_role_forbidden` and **no token**.
- The mobile app continues to use `/auth/login`, so student sign-in is untouched.
- Access token is kept in memory. Refresh token is kept in `sessionStorage`;
  closing the tab ends the session. A single-flight refresh handles expiry.
- Every screen is gated in the client **and** every backend route enforces its
  own `role` allow-list. Client role values are never trusted.
- Admins cannot modify another Admin/Super Admin account. The backend now
  enforces this in addition to the UI.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Public API base URL. Defaults to `https://api.medacademy.site`. |

Never add a secret to a `VITE_*` variable: Vite embeds it in the browser bundle.
Backend secrets remain in the API server's `.env`, outside this document root.

The API server's `CORS_ALLOWED_ORIGINS` must include
`https://portal.medacademy.site` (and `http://localhost:5173` for development).
That is the only backend infrastructure change required by the portal.

## Pages and capabilities

| Route | Roles | Capabilities |
| --- | --- | --- |
| `/dashboard` | Doctor, Admin, SA | Role-specific KPIs, recent courses/audit, quick actions |
| `/courses` | Doctor, Admin, SA | List/search/filter, create, edit, publish/unpublish, archive, duplicate, delete, CSV |
| `/courses/:id` | Doctor, Admin, SA | Course edit, sections CRUD, lessons CRUD, video ID, material upload/delete |
| `/students` | Doctor | Enrolled students, create+enroll (credits), suspend/resume, remove |
| `/users` | Admin, SA | Search/filter, detail, role/status, block/restore, trash, password reset, device reset |
| `/academic` | Admin, SA | Universities, faculties, levels; add, activate/deactivate, delete |
| `/devices` | Admin, SA | Device list, block/unblock |
| `/credits` | Doctor, Admin, SA | Balances, ledger, allocate/refund |
| `/videos` | Doctor, Admin, SA | VdoCipher asset library, import, sync, delete |
| `/analytics` | Admin, SA | Enrollment/doctor/course analytics, security counters |
| `/audit` | Admin, SA | Audit log, filter, detail payload, CSV |
| `/notifications` | All staff | Inbox, mark read |
| `/profile` | All staff | Profile/contact edit, password change |
| `/branding` | SA | Platform identity, colours, contact links |
| `/cms` | SA | Terms, privacy, about, contact pages |
| `/feature-flags` | SA | Global kill switches/rollouts |
| `/app-updates` | SA | Android/iOS minimum versions and prompts |
| `/support` | SA | Support channels shown to blocked users |
| `/maintenance` | SA | Enable/disable maintenance mode |
| `/security` | SA | Detection policies and VPN whitelist |
| `/system` | SA | Live diagnostics for DB, storage, video, SMTP, JWT, PHP |

See `FEATURE_PARITY.md` for the complete mobile-to-portal inventory and the
honest status of work that remains mobile-only.

## Deployment

Use the guarded workflow at the repository root:

```bash
./deploy/deploy.sh portal   # portal only
./deploy/deploy.sh          # portal + PHP backend
```

It runs tests, build and lint, rejects source maps or development files, creates
timestamped portal and backend backups, stages the upload, activates atomically,
verifies SHA-256 checksums and runs live smoke tests. `scripts/deploy.sh` is a
compatibility wrapper around the portal-only mode. See `deploy/README.md`.

The deployed `.htaccess`:

- disables directory listing (the empty docroot previously exposed an index),
- falls back to `index.html` for SPA routes,
- sets CSP, frame denial, nosniff, referrer and permissions policies,
- marks `index.html` no-store and hashed assets immutable,
- denies dotfiles, source maps, and config files.

## Rollback

Backups are written under `~/backups/medacademy-<timestamp>/`. Use the recorded
rollback command:

```bash
CONFIRM_ROLLBACK=yes ./deploy/rollback.sh <timestamp> all
```

## Tests

`npm test` runs 13 assertions across 3 files:

- `tests/permissions.test.ts` — every role × route boundary and account-management rule.
- `tests/api-login.test.ts` — student token rejection, doctor session storage, server error surface.
- `tests/backend-contract.test.ts` — the portal login route/role gate and Admin privilege guard exist in the PHP source.

Live integration checks (valid staff credentials) must be run with a real staff
account. Do not create production test users without owner approval.
