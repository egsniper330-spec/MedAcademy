# Security and Permission Audit

Date: 2026-11-01. Scope: portal frontend, the portal-auth backend delta, and the
shared API surfaces the portal calls.

## 1. Authentication

| Control | Implementation | Result |
| --- | --- | --- |
| Staff-only sign-in | New `POST /portal/auth/login`; `AuthService::login(..., ['doctor','admin','super_admin'])` | Pass |
| Student rejection | Role is read from the credential-verified `profiles` row; 403 `portal_role_forbidden` is thrown **before** device registration, feature flags and session issue | Pass (code + contract test) |
| Mobile login compatibility | `/auth/login` still calls `login()` without an allow-list; its invalid-credential response was smoke-tested at 401 | Pass |
| Suspended/blocked accounts | Existing status checks run before the role gate; suspended/blocked staff cannot obtain a session | Reused existing control |
| Rate limiting | Existing per-IP login limiter in `AuthService::login` applies to the portal route | Reused existing control |
| Session issuance | Existing `SessionManager` (short-lived HS256 access token + rotating opaque refresh token) | Reused existing control |
| Token storage | Access token in memory only; refresh token in `sessionStorage` | Pass |
| Expiry | Single-flight refresh on 401; one retry; refresh failure clears the session and shows a sign-in message | Covered by client logic; unit-tested message/role paths |
| Logout | Revokes refresh token server-side, clears local storage, navigates to `/login` | Pass |
| No secrets in bundle | Only `VITE_API_URL`; no API keys, DB credentials or salts | Pass |
| CSRF | No cookie-based auth is used. State-changing requests need a bearer token that cross-site script cannot read, and CORS restricts browser origins | Acceptable for this token model |
| Secrets in URLs | No tokens are placed in query strings or fragments | Pass |

## 2. Authorization / RBAC

- Every portal route is gated in React **and** every PHP route used has an
  explicit `role` allow-list in `backend/routes/api.php` or an ownership check in
  the controller (`CourseController`, `DataController`).
- The browser never sends a role; the backend reads `profiles.role` from the
  token subject on every request.
- `AdminController` hierarchy hardened:
  - An Admin may not assign `admin` or `super_admin`.
  - An Admin may not change the role, status, block, restore, delete, trash,
    reset devices for, or bulk-modify an existing Admin/Super Admin.
  - The dedicated `/auth/trash-user` route enforces the same rule.
  - `bulkRestore`, `bulkTrash`, `bulkStatus` and `bulkResetDevices` enforce it
    per target and report refusals instead of silently succeeding.
- Super Admin routes (`branding`, CMS, flags, updates, support, maintenance,
  security policies, diagnostics) are server-gated to `super_admin`.
- Direct URL access without a staff session redirects to `/login` (verified in
  the deployed browser at `/security`).

## 3. XSS and content safety

- React escapes all interpolated values; the portal does not use
  `dangerouslySetInnerHTML`.
- CMS bodies are edited and stored as plain text, matching the backend contract
  (no HTML execution).
- CSP is served by `.htaccess`:
  `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, `connect-src` limited to the API, `img-src` limited to
  self/data/blob/https.
- `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, permissions policy,
  COOP/CORP and HSTS are set.
- `style-src 'unsafe-inline'` is required for React inline styles and the upload
  progress width. It does not permit script execution.

## 4. Uploads

- Lesson materials go to the existing private `lesson-materials` bucket.
- The portal sends the measured `File.size` as `declared_size` with
  `declared_size_source=stat`; the server measures the stored object and
  validates PDFs/type/size.
- Material row creation uses the shared `lesson_materials` checks; the server
  re-verifies the object before persisting.
- On a failed row insert, the portal calls `POST /storage/discard-upload`
  (best-effort) so orphaned bytes can be reclaimed. That endpoint refuses
  objects still referenced by a row.
- Filenames are sanitized before building the storage path.
- No upload is accepted into a public bucket by the portal.

## 5. CORS

- `CORS_ALLOWED_ORIGINS` on the API now includes
  `https://portal.medacademy.site` (plus the existing site and localhost
  development origins).
- Preflight from the deployed origin returned `204` with
  `access-control-allow-origin: https://portal.medacademy.site`.
- The API always returns `Vary`-safe allow-list behavior: unknown origins get no
  CORS headers.

## 6. Audit logging

Sensitive portal actions reuse the existing `AuditService` path:
role/status changes, blocks, device resets, credit allocation/refund, course
lifecycle changes, materials, security policy changes, branding/CMS/flags,
maintenance, support settings and app-update changes. No new parallel audit
store was added.

## 7. Content protection / DRM

The portal has **no student playback path** and does not issue VdoCipher OTPs.
It can manage assets and assign a `video_id` to a lesson, but protected playback
stays in the mobile app with its existing security/DRM lifecycle. No mobile
security or watermark code was modified.

## 8. Residual risks / limitations

1. A live Doctor session and a live Super Admin session were exercised
   read-only in the deployed browser (dashboards, courses, users, analytics,
   branding, app updates, security). A live Admin-role session and a live
   student-rejection attempt were not executed. Automated tests cover the client
   role gate, all route boundaries, the backend portal route/role gate and the
   Admin privilege boundary.
2. Refresh token lives in `sessionStorage`; an XSS in the portal origin could
   read it. CSP and React escaping reduce that surface, but no web app can
   eliminate it entirely.
3. No MFA is offered; the existing platform does not have an MFA contract.
4. The portal does not send a device fingerprint, so device-level blocks are not
   evaluated on portal login. Account status and role are enforced; mobile
   device binding remains unchanged.
5. `style-src 'unsafe-inline'` is present for React inline styles.
6. The portal does not expose impersonation by design.
7. The API CORS list still contains localhost development origins; these do not
   authorize requests without a valid staff token.
