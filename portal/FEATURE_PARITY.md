# Mobile → Portal Feature Parity

Inventory taken from `src/app/**` and the PHP route table. “Complete” means the
operation calls the shared backend and is usable from the portal today.
“Partial” means the core workflow exists but a mobile-only sub-flow is missing.
“Mobile only” is an honest gap, not a placeholder.

## Doctor

| Mobile screen | Portal route | Actions | Backend | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| `(doctor)/dr-overview` | `/dashboard` | KPIs, recent courses, quick actions | `GET /courses`, `/credits/me`, `/doctors/students` | Complete | Typecheck/build; live login blocked on credentials |
| `(doctor)/dr-profile` | `/profile` | Edit name/contact channels | `GET/PATCH /users/me` | Complete | Build |
| `(doctor)/courses` | `/courses` | Search/status filter, create, edit, publish, unpublish, archive, duplicate, delete | `GET/POST/PATCH /courses`, `/courses/{id}/{publish,unpublish,archive,duplicate,delete}` | Complete | Build; destructive operations not run against production |
| `course-builder/[id]` | `/courses/:id` | Course fields, cover, contact, settings, sections (add/rename/reorder/delete), lessons (add/edit/duplicate/reorder/delete + bulk create from filenames), video source (MedAcademy/YouTube/coming soon), per-lesson settings, estimated time, notes, scheduled publishing, ready-video attachment, material upload and permission control, course templates | `/courses/{id}`, `/rpc/update-course-audited`, `/courses/{id}/sections`, `/courses/{id}/lessons`, `/api/sections`, `/api/lessons`, `/lessons/{id}/delete`, `/api/course_templates`, `/video/assets`, `/video/attach-lesson`, `/storage/upload`, `/api/lesson_materials`, `/materials/{id}/delete` | Complete for the Doctor web workflow; legacy raw VdoCipher IDs are replaced by owned ready assets | Build + unit + live route probes |
| Course templates (mobile parity) | `/courses` + `/courses/:id` | Start from a saved/public template, save an existing course as a reusable template | `/api/course_templates` | Implemented; student data is excluded and copied video assets are ownership-checked | Build |
| `(doctor)/students` | `/students` | List/search, create+enroll with credits, suspend/resume, remove, multi-select bulk suspend/resume/remove with per-record results | `/doctors/students`, `/student-operations`, `/api/enrollments`, `/rpc/remove-course-enrollment`, `/students/bulk-action` | Complete | Build + backend contract |
| `(doctor)/video-library` | `/videos` | List/search/filter, start direct VdoCipher upload with progress/cancel/retry, import, sync, rename, delete | `/video/upload-init`, `/video/upload-status`, `/video/import`, `/video/assets`, `/video/sync-library`, `/video/assets/delete`, `/api/video_assets` | Complete except mobile's chunked/resumable engine; browser upload uses the same server-authoritative pipeline and never exposes the API secret | Build; provider upload needs a real account/file for end-to-end proof |
| Course CSV import (web-only exception) | `/courses` | Template, parse/preview, row errors, duplicate rejection, server re-validation, per-row summary | `POST /courses/import` | Complete — ownership comes from the token, all rows are drafts, existing titles are never overwritten | Unit tests + live 401 route probe |
| Bulk course management (web-only exception) | `/courses` | Multi-select, select-all visible, clear, count, filter reconciliation, confirm, per-record partial failures for publish/unpublish/archive | existing per-course lifecycle endpoints | Complete — every record is authorized server-side | Build |
| Night mode (web-only exception) | every portal page | Light/dark/system toggle in header + user menu, immediate apply, persisted preference, dark neumorphic palette | browser only | Complete | Unit tests (persistence/application) |
| Doctor course statistics | `/analytics` (Admin/SA only) | Enrollment counts per course | `/analytics/enrollment-stats/*` | Mobile only for doctors (backend analytics routes are Admin/SA) | — |
| `credits.tsx`, `doctor-credit-timeline` | `/credits` | Balance, ledger | `/credits/me`, `/credits/transactions` | Complete (read) | Build |
| `notifications.tsx` | `/notifications` | Inbox, mark read | `/notifications`, `/notifications/read` | Complete | Build |
| `my-devices`, `login-history` | `/profile` device list via users API is not exposed to doctors | — | `/auth/devices` | Mobile only | — |

## Admin

| Mobile screen | Portal route | Actions | Backend | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| `(admin)/admin-overview` | `/dashboard` | Platform KPIs, recent audit | `/admin/stats`, `/admin/audit-logs` | Complete | Build |
| `(admin)/users` | `/users` | Search/filter, detail, role/status, block/restore, trash, password reset, device reset | `/admin/users*`, `/auth/admin/change-password`, `/users/{id}/trash` | Complete; Admin locked out of Admin/SA targets | Unit role-matrix; live DB writes not run |
| `(admin)/academic` | `/academic` | University/faculty/level CRUD | `/api/universities`, `/api/faculties`, `/api/academic_levels` | Complete | Build |
| `(admin)/devices` | `/devices` | List, block/unblock | `/api/devices`, `/security/devices/{id}/*` | Complete | Build |
| `(admin)/audit` | `/audit` | Filter, detail, CSV | `/admin/audit-logs` | Complete | Build |
| `enrollment-manager` | — | Assign/remove enrollment, visibility, pricing | `/admin/enrollment`, `/rpc/set-enrollment-assigned-price` | Mobile only | — |
| `fraud-alerts` | — | Review flags | `/api/fraud_flags` | Mobile only | — |
| `enrollment-stats`, `revenue-analytics`, `reports` | `/analytics` | Enrollment/doctor/course + security summary | `/analytics/enrollment-stats/*`, `/analytics/security-stats` | Partial — no revenue drill-down | Build |
| `export-panel`, `db-audit`, `trash-bin`, `storage` | — | Export, DB audit, restore, storage stats | mixed | Mobile only | — |
| `global-search` | Global search not yet in top bar; `/users` + `/courses` search cover the main entities | Search | `/admin/user-lookup`, `/courses` | Partial | — |
| `bulk-import`, `create-student`, `bulk-credits` | Single student creation + single credit allocation only | Bulk operations | `/student-operations`, `/credits/allocate` | Partial | — |

## Super Admin

| Mobile screen | Portal route | Actions | Backend | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| `sa-overview`, `sa-platform` | `/dashboard`, `/branding` | KPIs, identity, contact links | `/admin/stats`, `/platform/branding` | Complete | Build |
| `branding` | `/branding` | All public branding fields and colours | `GET/PUT /platform/branding` | Complete | Build |
| `cms`, `sa-cms` | `/cms` | Terms/privacy/about/contact pages, publish | `GET /platform/pages`, `PUT /platform/pages/{key}` | Complete | Build |
| `feature-flags` | `/feature-flags` | Toggle each registered flag | `GET/PUT /platform/feature-flags` | Complete | Build |
| `app-updates` | `/app-updates` | Android/iOS min versions, mode, URL, notes, enforcement | `GET/PUT /admin/app-updates` | Partial — app release archive/draft/publish/rollback screens are mobile-only | Build |
| `support-settings` | `/support` | Per-channel label/value/enabled | `GET/PUT /admin/support-settings` | Complete | Build |
| `maintenance` | `/maintenance` | Enable/disable + message | `GET/POST /admin/maintenance` | Complete | Build |
| `content-protection`, `sec-policies` | `/security` | Detection action/enable, VPN whitelist | `/admin/security/policies`, `/admin/security/vpn-whitelist` | Partial — violations/content settings not exposed | Build |
| `health`, `sec-diag` | `/system` | DB/video/SMTP/storage/JWT/PHP checks | `/admin/system/diagnostics` | Complete | Build |
| `sa-users` | `/users` | Full role/status/block/trash/password/device controls | `/admin/users*` | Complete | Unit + build |
| `sa-analytics`, `sa-finance` | `/analytics` | Enrollment/security; revenue totals not exposed | analytics endpoints | Partial | Build |
| `sa-courses`, `sa-video-library`, `sa-video-settings` | `/courses`, `/videos` | All-course management, asset list/import/sync/delete | course/video endpoints | Partial — provider/VdoCipher settings not exposed | Build |
| `sa-credits`, `sa-bulk-credits`, `sa-redeem-codes` | `/credits` | Allocate/refund, ledger | `/credits/*`, `/api/credit_transactions` | Partial — redeem-code create/list/revoke missing | Build |
| `impersonation` | — | Start/end impersonation | `/auth/impersonate` | Deliberately not exposed on the web portal | — |
| `trash-bin`, `db-audit`, `export-panel`, `storage`, `global-search`, `bulk-import`, `audit` (extra) | `/audit` covers logs only | — | mixed | Mobile only / partial | — |
| `currency`, `video-providers`, `system-providers`, `delete-permissions`, `redeem-codes`, `content-protection` settings | — | Platform configuration | dedicated/generic endpoints | Mobile only | — |
| `notifications-center`, `security` diagnostics | `/notifications`, `/system` | Staff inbox, diagnostics | notifications/diagnostics | Complete | Build |

## Cross-cutting

| Requirement | Status |
| --- | --- |
| Student rejected by portal auth | Complete (server gate before session) |
| Student rejected from every portal route | Complete (client matrix + backend role gates) |
| Doctor cannot reach Admin/SA pages | Complete (client matrix; backend role gates) |
| Admin cannot modify Admin/SA | Complete (backend guard added) |
| Session expiry | Complete (single-flight refresh, 401 logout) |
| Arabic/English + RTL | Complete for navigation, page copy, forms, tables and states; a few technical/provider labels remain English (`dir` switches) |
| Responsive layouts | Complete (desktop/tablet/mobile CSS) |
| Secure tokens | Access in memory; refresh in sessionStorage; no secrets in bundle |
| CSRF | Bearer-token API with no cookie auth; mutations additionally rely on CORS origin allow-list |
| File upload progress | Complete for lesson materials |
| Pagination | Server-side for users/devices/audit limits; analytics top-N; course list backend limit 200 |
| Audit logging | Reuses backend audit for every sensitive mutation |

## Known gaps that must be stated to the owner

1. The browser video uploader sends one direct presigned request; the mobile
   app's chunked/resumable engine is not reproduced. Progress, cancellation,
   retry, server polling and ownership verification are implemented.
2. Redeem codes, revenue/finance drill-down, provider settings, currency
   settings, trash restore, storage management and impersonation remain
   unavailable in the portal.
3. Live role-based login tests require real Doctor/Admin/Super Admin credentials
   or owner-approved fixtures. No production users were created or modified.
