# Deployment Record — Neumorphic Portal

## Current production release

| Item | Value |
| --- | --- |
| Release timestamp | **2026-11-01 17:44:04 UTC** (`20261101T174404Z`) |
| Portal URL | `https://portal.medacademy.site` |
| API URL | `https://api.medacademy.site` |
| Portal root | `/home/vcoafnqsgg/portal.medacademy.site` |
| API root | `/home/vcoafnqsgg/api.medacademy.site` |
| Portal bundle | `assets/index-hx8o5SXV.js` (424,917 bytes) |
| Portal stylesheet | `assets/index-COEdr6Hp.css` (70,480 bytes) |
| Release backup | `/home/vcoafnqsgg/backups/medacademy-20261101T174404Z` |
| Deployment log | `deploy/logs/20261101T174404Z/deploy.log` |

The portal is a static Vite build with SPA fallback and local fonts. The PHP API
remains the single backend; no database migration was required for this release.

## Files activated

Portal:

- `index.html` — points at the new bundle and stylesheet.
- `assets/index-hx8o5SXV.js` — new application bundle.
- `assets/index-COEdr6Hp.css` — neumorphic design system.
- `fonts/GlowSansSC-Latin.woff2`
- `fonts/NotoSansArabic-Latin.woff2`
- `fonts/NotoSansArabic-Regular.woff2`
- `favicon.svg`

Backend:

- `src/Http/HandlerUnavailableException.php` — was missing in production but is
  referenced by `src/Http/Router.php` and `src/Middleware/ErrorHandler.php`.

Every other backend application file already matched the intended local source.
No portal files were deleted. Previous hashed bundles and `icons.svg` were left
in place so browsers holding an older document can still load their assets.

`.htaccess`, `.env`, uploads, storage, videos, PDFs, database records, logs,
sessions, caches and backups were not replaced or deleted. No development source
or source maps were uploaded.

## Build and checks

| Check | Result |
| --- | --- |
| Portal tests | 13/13 passed (3 files) |
| TypeScript + Vite production build | Passed |
| Lint | 0 errors, 16 existing warnings |
| Portal SHA-256 comparison | 8/8 intended files `OK` |
| Backend SHA-256 comparison | 83/83 intended files `OK` |
| PHP syntax (`php -l`) | All intended PHP files pass |

## Live verification

| Check | Result |
| --- | --- |
| `GET https://portal.medacademy.site/` | 200 HTML, new bundle |
| JS / CSS / fonts | 200 with correct content types |
| SPA refresh (`/courses`) | 200 HTML |
| Directory listing (`/assets/`) | 403 |
| Source map request | 403 |
| HSTS, CSP, `X-Frame-Options`, Referrer and Permissions policies | Present |
| `index.html` cache policy | `no-cache, no-store, must-revalidate` |
| Hashed assets | `public, max-age=31536000, immutable` |
| TLS certificate | Valid Let's Encrypt certificate for `portal.medacademy.site` |
| API `/health` | 200, database `ok` |
| Unauthenticated `/auth/me` | 401 |
| Invalid portal login | 401, no session issued |
| Portal CORS preflight | 204 with `https://portal.medacademy.site` |
| Login page in Chromium | Neumorphic page renders with production fonts |

No destructive production action was performed. No test course, student, device
or account was created or modified.

## Backend source reconciliation

The backend deployment compares all 83 intended application files, not only files
changed in the latest task. On this release, 82 files were already byte-identical
and one missing class was added. Production-only runtime files (for example the
legacy `VideoLibrarySyncService.php.bak-*` file) are intentionally preserved.

Local and production configuration are not merged. Production `.env` remains
untouched, and no secret was read, printed or committed.

## Permanent workflow

Deployment is now scripted and guarded:

```bash
./deploy/deploy.sh            # portal + backend
./deploy/deploy.sh portal
./deploy/deploy.sh backend
```

The workflow runs tests/build/lint, creates timestamped backups, uses a source
allowlist, stages uploads, activates atomically, validates PHP syntax, compares
SHA-256 checksums and runs live smoke tests. See `deploy/README.md` and
`deploy/config.env`.

## Rollback

```bash
CONFIRM_ROLLBACK=yes ./deploy/rollback.sh 20261101T172257Z all
```

`20261101T172257Z` is the backup taken immediately before the redesign was
activated, so it restores the previous portal. Compatible rollback archive names
were added to that backup. Later timestamped releases keep the normal
pre-deployment backup layout for future rollbacks.

The backup contains full portal and backend-source archives plus
`portal-before.sha256` and `backend-before.sha256`. Earlier pre-deployment
backups are retained under `/home/vcoafnqsgg/backups/medacademy-*`.

## Remaining verification limits

Authenticated end-to-end flows for Doctor, Admin and Super Admin still require
real staff credentials or owner-approved test accounts. Deployment verified the
login surface, API health, unauthenticated rejection, CORS and all static assets;
it did not create or exercise production staff accounts.
