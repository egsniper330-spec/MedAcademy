# MedAcademy — agent instructions

## Mandatory local → production synchronization

Every task that changes `backend/`, `portal/` or `website/` must **also** compare the
local files with production by **SHA-256** and deploy the intended changes, then verify.
Deployment is part of task completion, not a follow-up.

Three independent targets — never mix them:

| Target | Local source | Host | Production root |
|---|---|---|---|
| Backend (PHP API) | `backend/` | api.medacademy.site | `/home/vcoafnqsgg/api.medacademy.site` |
| Portal (built SPA) | `portal/` → `portal/dist` | portal.medacademy.site | `/home/vcoafnqsgg/portal.medacademy.site` |
| Public website (static) | `website/` | medacademy.site | `/home/vcoafnqsgg/medacademy.site` |

Access: `deploy/config.env` (`SSH_HOST=66.29.148.128`, port 21098, user `vcoafnqsgg`,
key `~/.ssh/id_ed25519`). Never print or commit keys/passwords.

### Procedure per target

1. Build local manifests with `sha256sum` and compare against production
   (`sha256sum -c` on the server). Never rely on timestamps.
2. Classify: differing content, missing on server, production-only.
3. Back up production files before replacing them
   (`~/backups/medacademy-<UTC>/`, `~/backups/medacademy-website-<UTC>/`, DB dumps in
   `~/backups/db/`).
4. Deploy only intended files: stage in `/tmp`, write a temp sibling and `mv` into
   place (atomic). Backend: use `./deploy/deploy.sh all|portal|backend`, which gates on
   tests/build/lint, PHP lint, checksums and smoke tests.
5. Verify remote checksums after upload and hit the live URLs.
6. Never delete production-only files without proving ownership and obsolescence.
   Never overwrite a production file that differs from both local and the expected
   previous release — investigate and report the conflict instead.

Migrations are **never** applied automatically; apply one only with a DB dump first and
verify with `information_schema` afterwards.

Portal keeps old hashed `assets/index-*` bundles on purpose so cached documents do not
break. `medacademy.site/app.apk` is a production-only download artifact — never touch it
unless a new APK is explicitly being published.

## Public website content policy

`website/` must describe the **current** product only:

- It is a **university learning platform for all faculties**, not a medical-only product.
- Do **not** advertise DRM, Widevine/FairPlay, VdoCipher, offline video downloads or
  offline playback — those are retired (all `/video/*` API routes answer
  `410 video_provider_retired`; YouTube is the only supported video source).
- Valid current capabilities may be described: structured courses and lessons, video
  lessons, PDF materials watermarked per reader, instructor/doctor panel, credits and
  enrollments, admin panel, device-bound sessions and integrity checks.
- Keep the existing visual identity, theme script, responsive layout and valid links.

## Repo conventions

- npm only (never pnpm). Do not commit secrets; no native Android/iOS builds locally.
- iOS IPA workflow `.github/workflows/ios-build.yml` is protected — never modify it.
