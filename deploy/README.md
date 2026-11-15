# MedAcademy Production Deployment

This directory is the permanent deployment workflow for the portal and PHP API.

## Production targets (verified)

| Item | Value |
| --- | --- |
| SSH host | `66.29.148.144` |
| SSH port | `21098` |
| SSH user | `vcoafnqsgg` |
| SSH key | `$HOME/.ssh/id_ed25519` (outside this repository) |
| Portal root | `/home/vcoafnqsgg/portal.medacademy.site` |
| API root | `/home/vcoafnqsgg/api.medacademy.site` |
| Portal URL | `https://portal.medacademy.site` |
| API URL | `https://api.medacademy.site` |
| Backups | `/home/vcoafnqsgg/backups/medacademy-<UTC timestamp>/` |

The connection values live in `config.env`. The private key must never be copied
into the repository, a web root, a backup archive or a log. This workflow never
prints key contents or reads `.env` files.

## Deploy a completed change

From `D:\v3` in Git Bash:

```bash
./deploy/deploy.sh              # portal + backend
./deploy/deploy.sh portal       # portal only
./deploy/deploy.sh backend      # backend source only
```

The script performs these gates in order:

1. Portal tests, TypeScript/Vite production build and lint.
2. Rejects source maps, `.env*`, TypeScript source or a missing production API origin in `dist/`.
3. Creates timestamped remote backups and before-deployment checksum manifests.
4. Uses a backend source allowlist: `src/`, `config/`, `routes/`, `public/index.php`, `public/.htaccess`, `composer.json`, `composer.lock`.
5. Uploads to a timestamped staging directory, never directly over a live file.
6. Replaces backend files atomically, then runs `php -l` before success.
7. Installs portal assets and fonts first and the entry point last.
8. Verifies every intended file with SHA-256.
9. Runs live portal, SPA, asset, font, header, API health, unauthenticated-session and CORS checks.
10. Writes a local log and checksum manifests under `deploy/logs/<UTC timestamp>/`.

A failure at any gate stops the release and points to the backup. The script is
idempotent: unchanged backend files are not rewritten.

## Safety boundaries

- `.env` files, secrets, database contents, uploads, videos, PDFs, logs, caches,
  sessions and user-generated content are **not** included in any archive.
- The backend is synchronized without deleting production-only files. Old hashed
  portal assets are retained so clients holding a previous document do not break.
- Database migrations are never applied automatically. A migration needs its own
  inspected, backward-compatible release with a database backup.
- No production account, course, student, device or data record is modified by
  the deployment script.
- The PHP API is not a Node application; `node_modules`, `vendor` rebuilds and
  local development configuration are never uploaded.

## Verification contract

Deployment is complete only when:

- every intended portal and backend file reports `OK` from `sha256sum -c`;
- the portal returns 200 for `/`, a deep link and the current bundle;
- Arabic font and security headers are present;
- the API health endpoint reports `"status":"ok"`;
- unauthenticated `/auth/me` returns 401;
- portal CORS preflight returns 204 with the portal origin.

## Rollback

Each release creates full portal-site and backend-source archives:

```bash
CONFIRM_ROLLBACK=yes ./deploy/rollback.sh 20261101T172257Z all
CONFIRM_ROLLBACK=yes ./deploy/rollback.sh 20261101T172257Z portal
CONFIRM_ROLLBACK=yes ./deploy/rollback.sh 20261101T172257Z backend
```

The backups also contain `portal-before.sha256` and `backend-before.sha256` for
auditing what production contained immediately before the release.

## Notes

- LiteSpeed resets the SSH connection when `index.html` is written in place.
  The workflow always writes a temporary sibling and renames it atomically.
- The API document root is the `public/` directory; API paths do **not** include
  an extra `/api` prefix except for the explicitly registered health alias.
- The private key path can be overridden only through the local environment when
  the key is legitimately rotated; update `config.env` after receiving new,
  explicitly authorized connection details.
