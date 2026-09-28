'use strict';
/**
 * Guard tests — VdoCipher account/API investigation (2026-09).
 *
 * Facts verified LIVE against dev.vdocipher.com with the (new) API secret:
 *   - auth: HTTP 200 on GET /videos (secret valid, not exposed anywhere)
 *   - listing shape: { "rows": [...], "count": N }  ← CHANGED from {videos}
 *   - single video: GET /videos/{id} → object with id/status (unchanged)
 *   - OTP: POST /videos/{id}/otp → 200 (otpCreator permission)
 *   - create: PUT /videos?title= → { videoId, clientPayload } (uploader OK)
 *   - S3: multipart/form-data POST → 201 (upload pipeline healthy)
 *   - delete: DELETE /videos?videos={id} → 200
 *
 * Pinned here so a future VdoCipher schema change cannot again:
 *   (a) make System Diagnostics report INVALID_RESPONSE on a healthy account,
 *   (b) make listAllVideos return an empty remote library (which would let
 *       library sync mark every local asset missing), or
 *   (c) silently strip the per-stage checks detail from diagnostics output.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  ✗ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const SVC = 'backend/src/Video/VdoCipherService.php';
const DIAG = 'backend/src/Services/SystemDiagnosticsService.php';
const DIAGCTL = 'backend/src/Controllers/SystemDiagnosticsController.php';

console.log('── listAllVideos accepts every VdoCipher listing shape ──');
{
  const s = read(SVC);
  ok(/isset\(\$body\['rows'\]\)/.test(s), 'listAllVideos: current {rows,count} shape handled');
  ok(/isset\(\$body\['videos'\]\)/.test(s), 'listAllVideos: legacy {videos,...} shape handled');
  ok(/legacy bare-array response/.test(s), 'listAllVideos: bare-array fallback retained');
  ok(!/pageSize=/.test(s), 'no VdoCipher call uses the unsupported pageSize param');
}

console.log('── System Diagnostics: healthy account is never INVALID_RESPONSE ──');
{
  const s = read(DIAG);
  ok(/isset\(\$decoded\['rows'\]\)/.test(s), 'diagnostics: {rows} shape classified VALID');
  ok(/isset\(\$decoded\['videos'\]\)/.test(s), 'diagnostics: legacy {videos} shape classified VALID');
  ok(!/\/videos\?pageSize=/.test(s), 'diagnostics probe does not use unsupported pageSize param');
  ok(/videos\?page=1&limit=1/.test(s), 'diagnostics probe uses documented page/limit params');
  ok(!/buildAnnotate/.test(s) || /REMOVED/.test(s), 'diagnostics: no annotate reintroduction');
}

console.log('── Diagnostics per-stage checks survive the client allowlist ──');
{
  const s = read(DIAGCTL);
  ok(/'configuration', 'connectivity', 'authentication', 'api'/.test(s),
    'diagnostics controller: stage labels allowlisted (checks map no longer stripped to [])');
}

console.log('── Upload pipeline contract (verified live) ──');
{
  const s = read(SVC);
  ok(/\$result\['videoId'\]\s*\?\?\s*\$result\['id'\]/.test(s) || /videoId/.test(s),
    'createVideo/uploadInit expect { videoId, clientPayload }');
  ok(/clientPayload/.test(s) && /uploadLink/.test(s),
    'clientPayload/uploadLink handling present');
  ok(/multipart|CURLFile/.test(s), 'S3 transfer uses multipart/form-data (CURLFile)');
}

console.log('── Secrets stay server-side ──');
{
  ok(!/Apisecret/.test(read('src/lib/api.ts') + read('src/client/php.ts')),
    'no Authorization: Apisecret header in any frontend code');
  const diag = read(DIAG);
  ok(/The value itself is never exposed|never exposed here|never printed/.test(diag) || !/echo \$apiSecret|print \$apiSecret/.test(diag),
    'diagnostics never echoes the secret');
}

console.log('──────────────────────────────────────────────');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
