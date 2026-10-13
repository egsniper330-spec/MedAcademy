# Archived documents

Superseded, historical, or one-off documents moved out of the repository root to
keep the top level readable. Nothing here is current guidance — the live sources
of truth are listed below.

| File | Why it was archived | Current source of truth |
|---|---|---|
| `CHANGELOG_V562_TO_V568.md` | Historical changelog covering a single version range (V562 → V568, 2026-07-13). Superseded by later releases; having two root changelogs covering different, non-overlapping ranges was confusing. | [`../../CHANGELOG.md`](../../CHANGELOG.md) |
| `CHANGES.md` | One-off root-cause write-up for a single fix ("Logout Delay Fix"), not a changelog despite the name. Same shape as the `tasks/*/CHANGES.md` notes. | The fix is in `src/`; release history in [`../../CHANGELOG.md`](../../CHANGELOG.md) |
| `PROJECT_STATUS.md` | Stale: it claims "Latest version: V562" and "Stack: … Supabase", while the shipped app is versionName 1.0.844 (versionCode 221) on a PHP backend. A stale status page is actively misleading during release review. | [`../PRODUCTION_READINESS_AUDIT.md`](../PRODUCTION_READINESS_AUDIT.md) |

## Retained at the repository root

- `CHANGELOG.md` — the single canonical changelog.
- `README.md`, `SETUP.md`, `BUILD_INSTRUCTIONS.md` — setup and build entry points.
- `website/` — the deployed static marketing site (tracked, actively maintained,
  pinned by `tests/websiteTheme.test.cjs`). This is deliverable content, not a build artifact.

## Not archived

`tasks/` is a separate, intentional archive of historical working copies and
diagnostic notes. `metro.config.js` excludes the whole tree from module
resolution (see the comment there), so it is deliberately left in place rather
than merged into this directory.
