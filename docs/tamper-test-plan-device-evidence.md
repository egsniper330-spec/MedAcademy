# MedAcademy — Authorized Tamper Test Plan (Device-Evidence Layer)

## Gap-closure addendum (schema v2 layers) — Part 19 scenarios

New-layer tamper scenarios and the REQUIRED backend response for each:

| # | Tamper scenario | Expected backend response |
|---|---|---|
| H1 | Patched client omits `integrity` field entirely | Verification passes structural checks; `integrity_state='absent'`; assurance per policy — integrity anchoring silently skipped, tier still applies |
| H2 | Patched client sends `runtime_sha256` different from its earlier baseline | `BLOCKED`, reason `integrity_mismatch`, decision row `integrity_state='rejected'`; enforcement layer rejects the row at ANY tier |
| H3 | Patched client sends malformed hash (non-hex / wrong length) | `BLOCKED`, reason `evidence_schema_mismatch` |
| H4 | Patched client sends `vpn_state='off'` while actually on VPN | Sensors inside signed evidence still carry `vpn=true` (separate signal) → `blocking_signals=['vpn']` → BLOCKED. vpn_state alone lying is insufficient |
| H5 | Patched client sends `vpn_state='suspicious'` to look honest | Warning only (`vpn_state_suspicious`); DEGRADED — cannot satisfy `enforce_strict` without server promotion |
| H6 | Patched client sends invalid `vpn_state` value (e.g. `false`) | `BLOCKED`, reason `evidence_schema_mismatch` (type/enum validation) |
| H7 | Fresh key registered by patched client → immediate `enforce_strict` action | Denied: key is UNVERIFIED → capped DEGRADED → `enforce_strict` requires TRUSTED |
| H8 | Same as H7 but attacker waits out `warmup_hours` with clean account | Server promotes (tenure is server-observed) → residual risk documented; mitigations: `promotion_require_integrity`, violation history, revocation |
| H9 | Replayed v2 evidence (same counter/challenge) | `challenge_reused` or `counter_replayed` (transactional single-use) |
| H10 | Modified client strips new fields and re-signs (schema rollback) | `schema_version` must equal 2; v1 payload → `evidence_schema_mismatch` |
| H11 | `X-Security-Evidence` header points to an `integrity_state='rejected'` row | Enforcement rejects: reason `integrity_rejected`, regardless of tier |
| H12 | `config_version` spoofed to match server | Correlation field only; policy comes from `security_config` server-side — spoofing changes nothing |

Physical-device tests required for the new layers: collectBinaryIntegrity()
stability across legitimate installs (same aggregate on all genuine copies),
libmedasec load behavior on OEM ROMs, entrypoint/lib availability on
split-APK (App Bundle) installs, medasec_manifest digest parity.

**Scope:** verify that patching ANY client-side security state does NOT grant
protected backend capabilities. A modified client may hide the LOCAL security
gate — that is a UI limitation, not an authorization failure. What must never
happen: OTP / redeem / device-bind access without the backend's own
verification passing.

Design of record: `backend/src/Services/SecurityEvidenceService.php`,
`src/lib/deviceKey.ts`, `backend/database/mysql-migrations/018_device_keys_challenges_evidence.sql`.

**Status key:** IMPLEMENTED · VERIFIED STATICALLY · VERIFIED WITH AUTOMATED TESTS ·
REQUIRES PHYSICAL DEVICE · REQUIRES PRODUCTION CONFIGURATION

---

## A. Patch scenarios

| # | Client patch | Expected local effect | Expected backend effect | Status |
|---|---|---|---|---|
| A | VPN detector → always `false` | Local VPN gate hidden | Protected calls proceed only per server tier. With `enforce_strict`, the call requires TRUSTED — unreachable for a freshly registered (unverified) key even with all-clean signed evidence; with `enforce`, DEGRADED suffices (bootstrap-tolerant); with `log_only`, the call proceeds (policy decision, unchanged from today). | REQUIRES PHYSICAL DEVICE (enforce tiers), VERIFIED STATICALLY (tier gate ordering) |
| B | Root detector → always `false` | Local root gate hidden | **Bootstrap-capped (migration 019):** signed evidence from an UNVERIFIED key cannot exceed DEGRADED — the patched client cannot reach TRUSTED during warmup regardless of what its sensors report. After server-side promotion (tenure ≥ warmup_hours, active account/device, clean server-recorded violation history), a patched sensor still yields signed-but-false evidence — remaining mitigation: Play Integrity layer, revocation, violation history. | REQUIRES PHYSICAL DEVICE |
| C | Tamper detector → always `false` | Local tamper gate hidden | Same as A. APK-layer truth remains with Play Integrity (migration 017): a re-signed APK fails `certificateSha256Digest` there. | REQUIRES PHYSICAL DEVICE |
| D | Developer Options detector → always `false` | Local dev-options gate hidden | Same as A. Existing `security_policies` rows (migration 016) keep the LOCAL block mandatory; the evidence layer adds the server-side second gate. | REQUIRES PHYSICAL DEVICE |
| E | Debugger detector → always `false` | Local debugger gate hidden | Same as A. | REQUIRES PHYSICAL DEVICE |
| F | Security UI → always "trusted" | Cosmetic only | No backend effect — the UI displays server-pushed policy/config and never sends an authorization value. | VERIFIED STATICALLY (no client→server "securityStatus" field exists on any protected route) |
| G | Security API response handling → pretend backend said "trusted" | Cosmetic only | No backend effect — the server never reads a client verdict; `assertEvidenceAllowed()` consults `security_evidence` rows written ONLY by `SecurityEvidenceService::verifyEvidence()`. | VERIFIED STATICALLY |
| H | Skip evidence flow entirely (no headers) | None visible | `enforce` tier → 403 `This action requires a verified device security check`; `log_only` tier → proceed (policy). | VERIFIED STATICALLY (code path) |
| I | Replay an old evidence id + signature | None | `assertEvidenceAllowed` requires `expires_at > now` on the decision row AND the decision row is bound to (user, action); TTL is `evidence_ttl_seconds` (default 180 s). The signature header alone authorizes nothing. | VERIFIED STATICALLY |
| J | Replay a captured challenge (same device) | None | Challenge is consumed transactionally (`consumed_at` guard, `rowCount() === 1`); second spend loses the race → `challenge_reused`. Counter must be strictly greater than `device_keys.counter`. | VERIFIED STATICALLY (transactional guard) |
| K | Use another user's challenge/key | None | Challenge row `user_id` ≠ JWT `sub` → `challenge_user_mismatch`; key lookup is scoped `user_id = ? AND key_id = ? AND device_fingerprint = ?`. | VERIFIED STATICALLY |
| L | Re-scope a challenge to another action/body | None | Action + request-hash are read from the SERVER row and compared with `hash_equals`; client-supplied values cannot re-scope. | VERIFIED STATICALLY |
| M | Forge a signature | None | `openssl_verify` against the SERVER-stored SPKI PEM (EC P-256). Without the Keystore private key (non-exportable), forging requires extracting the TEE-backed key — out of scope for client patching. | VERIFIED STATICALLY (crypto primitives; key-extraction resistance REQUIRES PHYSICAL DEVICE) |
| N | Register a bogus public key | Possible but useless | Registration requires an authenticated session + a server-verified device row; a bogus key means the attacker must ALSO hold its private key to sign — self-defeating. | VERIFIED STATICALLY |

## B. Execution procedure (physical device, when scheduled)

1. Build release APK from `main`; install; log in; confirm key registration
   (`device_keys` row appears; `keystore_security` honest).
2. Apply patch (apktool/smali per scenario A–E), re-sign with the TEST key.
3. Repeat: app launch → OTP playback attempt → redeem attempt (test code) →
   device re-bind.
4. Flip `security_config.extras.device_evidence.actions` to `enforce` per
   action and repeat steps 1–3.
5. Assert: with `enforce`, every protected call without valid evidence → 403;
   with a valid pre-registered device and unpatched sensors → passes.
6. Record `security_evidence` rows (assurance/reason) and
   `security_events` for the audit trail.

## C. Race/replay automated tests (backend, recommended next step)

`verifyEvidence()` is written for PHPUnit-style verification but the project
currently has no PHP test runner configured. The following cases are fully
deterministic and should become the first PHPUnit suite when CI adds one:

1. double-spend race (two concurrent `verifyEvidence` on one challenge →
   exactly one passes),
2. expired challenge, 3. wrong user, 4. wrong device fingerprint,
5. wrong session, 6. wrong action, 7. mutated request_hash,
8. invalid signature, 9. counter regression (`counter_replayed`),
10. counter gap > 1000, 11. evidence schema_version mismatch,
12. revoked key, 13. unregistered key, 14. oversized evidence payload.
