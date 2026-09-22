<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Uuid;

/**
 * SecurityEvidenceService — device-key + challenge + signed-evidence authority.
 *
 * TRUST MODEL (Phases 2–7)
 * ────────────────────────
 * The client is a SENSOR + EVIDENCE PRODUCER, never an authority. The client:
 *   - generates an EC P-256 keypair inside Android Keystore (private key is
 *     non-exportable — it cannot end up in JS, files, or logs),
 *   - registers the PUBLIC key here,
 *   - receives a server-issued, single-use, short-lived challenge bound to
 *     (user, device, session, action, request_hash),
 *   - signs CANONICAL evidence (sorted-key JSON) with the Keystore key,
 *   - sends evidence + signature for verification.
 *
 * The backend independently verifies ALL of it:
 *   signature (against the SERVER-STORED public key), challenge freshness,
 *   single-use consumption (transactional), user/device/session/action/
 *   request-hash binding, monotonic counter progression (anti-replay),
 *   evidence schema/version, and then derives an ASSURANCE verdict
 *   (UNKNOWN/DEGRADED/TRUSTED/BLOCKED) from verified evidence + server state.
 *
 * The backend NEVER accepts client-reported booleans (vpn=false, tampered=false,
 * securityStatus=trusted, …) as authorization. They are evidence to be weighed,
 * and the per-action policy (security_config extras.device_evidence) decides
 * what assurance each protected action requires.
 *
 * This layer is NOT platform attestation: a Keystore signature proves control
 * of a device key, not APK genuineness. It composes with the Play Integrity
 * flow (IntegrityService, migration 017) which remains the APK layer.
 */
final class SecurityEvidenceService
{
    /** Header carrying the base64url ECDSA signature on protected calls. */
    public const SIGNATURE_HEADER = 'X-Security-Signature';
    /** Header carrying the evidence bundle id returned by /security/evidence. */
    public const EVIDENCE_HEADER = 'X-Security-Evidence';

    /** Evidence schema version — bump when the canonical structure changes. */
    public const EVIDENCE_VERSION = 2;

    /** Actions for which a challenge may be issued (whitelist). */
    private const KNOWN_ACTIONS = ['vdo_otp', 'redeem', 'device_bind', 'financial'];

    private const CHALLENGE_TTL = 120;   // seconds
    private const EVIDENCE_TTL = 180;    // seconds — decision validity window
    private const CLOCK_SKEW = 30;       // seconds of tolerated client clock drift
    private const MAX_EVIDENCE_BYTES = 8192;

    private static ?array $policyCache = null;

    // ─────────────────────────────────────────────────────────────────────────
    // Policy
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Effective device-evidence policy from security_config.extras.device_evidence.
     * Default per-action tier is "log_only" (audit without blocking) so the
     * rollout cannot lock out users whose keys are not yet registered.
     *
     * @return array{actions:array<string,string>, require_registered_key:bool,
     *               challenge_ttl:int, evidence_ttl:int, min_counter_gap:int}
     */
    public static function policy(): array
    {
        if (self::$policyCache !== null) {
            return self::$policyCache;
        }

        $extra = [];
        try {
            $row = Database::instance()->row(
                'SELECT extras FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
            );
            $decoded = is_array($row) ? json_decode((string) ($row['extras'] ?? '{}'), true) : null;
            if (is_array($decoded)) {
                $extra = $decoded;
            }
        } catch (\Throwable) {
            // DB hiccup → hard defaults below.
        }

        $de = is_array($extra['device_evidence'] ?? null) ? $extra['device_evidence'] : [];

        self::$policyCache = [
            'actions' => array_merge([
                'vdo_otp'     => 'log_only',
                'redeem'      => 'log_only',
                'device_bind' => 'log_only',
                'financial'   => 'log_only',
            ], is_array($de['actions'] ?? null) ? array_map('strval', $de['actions']) : []),
            'require_registered_key' => (bool) ($de['require_registered_key'] ?? false),
            'challenge_ttl' => max(30, min(600, (int) ($de['challenge_ttl_seconds'] ?? self::CHALLENGE_TTL))),
            'evidence_ttl'  => max(30, min(900, (int) ($de['evidence_ttl_seconds'] ?? self::EVIDENCE_TTL))),
            'min_counter_gap' => max(1, (int) ($de['min_counter_gap'] ?? 1)),
            // Bootstrap hardening (migration 019): a key the SERVER has not
            // promoted is UNVERIFIED — its signed evidence can never yield
            // TRUSTED. Promotion requires server-observed tenure.
            'warmup_hours' => max(1, min(720, (int) ($de['warmup_hours'] ?? 24))),
            // Part 4: promotion additionally requires that THIS key has at
            // least one integrity_state='anchored' measurement (a baseline
            // exists) — never grants trust on a key with no binary history.
            'promotion_require_integrity_history' => (bool) ($de['promotion_require_integrity_history'] ?? true),            'promotion_require_integrity' => (bool) ($de['promotion_require_integrity'] ?? false),
            // Optional OPERATOR-PINNED release digest (migration 020): set per
            // release build in security_config; empty = first-seen anchoring.
            'integrity_pinned_sha256' => strtolower(trim((string) ($de['integrity_pinned_sha256'] ?? ''))),
        ];
        return self::$policyCache;
    }

    /** Test/ops hook: reset the in-process policy cache after config changes. */
    public static function resetPolicyCache(): void
    {
        self::$policyCache = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Device-key registration (Phase 3)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register (or rotate) a device key for (user, fingerprint).
     *
     * The client sends ONLY public material: key_id, SPKI PEM, keystore
     * backing summary. The server binds the key to the user + fingerprint;
     * rotation supersedes (never deletes) the previous key so outstanding
     * challenges fail instead of silently re-scoping.
     *
     * @param array{key_id:string, public_key_pem:string, device_fingerprint:string,
     *              keystore_security?:string, device_id?:?string} $body
     * @return array{key_id:string, status:string, rotated:bool}
     */
    public static function registerDeviceKey(string $userId, array $body): array
    {
        $keyId = trim((string) ($body['key_id'] ?? ''));
        $pem = trim((string) ($body['public_key_pem'] ?? ''));
        $fingerprint = trim((string) ($body['device_fingerprint'] ?? ''));
        $security = (string) ($body['keystore_security'] ?? 'unknown');
        $deviceId = isset($body['device_id']) ? (string) $body['device_id'] : null;

        if ($keyId === '' || $pem === '' || $fingerprint === '') {
            throw new ApiException(422, 'key_id, public_key_pem and device_fingerprint are required');
        }
        if (strlen($keyId) > 64 || strlen($fingerprint) > 191) {
            throw new ApiException(422, 'key_id or device_fingerprint exceeds length limits');
        }
        if (!in_array($security, ['strongbox', 'tee', 'software', 'unknown'], true)) {
            $security = 'unknown';
        }
        self::assertValidSpkiPem($pem);

        $db = Database::instance();
        $existing = $db->row(
            'SELECT id, status, public_key_pem FROM device_keys
              WHERE user_id = ? AND key_id = ? LIMIT 1',
            [$userId, $keyId]
        );

        $rotated = false;
        if ($existing !== null) {
            // Same key re-registered (idempotent) → refresh binding only.
            if (hash_equals((string) $existing['public_key_pem'], $pem)
                && $existing['status'] === 'active') {
                $db->query(
                    'UPDATE device_keys SET device_fingerprint = ?, device_id = COALESCE(?, device_id), last_used_at = UTC_TIMESTAMP(6) WHERE id = ?',
                    [$fingerprint, $deviceId, $existing['id']]
                );
                return ['key_id' => $keyId, 'status' => 'active', 'rotated' => false];
            }
            // Rotation: supersede the old row, insert the new material.
            $rotated = true;
            $db->query(
                "UPDATE device_keys SET status = 'superseded', revoked_at = UTC_TIMESTAMP(6),
                    revoked_reason = 'superseded_by_rotation' WHERE id = ?",
                [$existing['id']]
            );
        }

        $db->insert(
            'INSERT INTO device_keys
                (id, user_id, device_id, device_fingerprint, key_id, public_key_pem, keystore_security, status, registered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $userId, $deviceId, $fingerprint, $keyId, $pem, $security, 'active']
        );

        if ($rotated) {
            AuditService::write($userId, 'security_event', [
                'event' => 'device_key_rotated',
                'key_id' => $keyId,
                'device_fingerprint' => $fingerprint,
            ]);
        }

        return ['key_id' => $keyId, 'status' => 'active', 'rotated' => $rotated];
    }

    /** Server-side revocation (admin) — the key stops verifying immediately. */
    public static function revokeDeviceKey(string $keyRowId, string $actorId, string $reason): void
    {
        Database::instance()->query(
            "UPDATE device_keys SET status = 'revoked', revoked_at = UTC_TIMESTAMP(6),
                revoked_reason = ?, revoked_by = ? WHERE id = ?",
            [$reason, $actorId, $keyRowId]
        );
        AuditService::write($actorId, 'security_event', [
            'event' => 'device_key_revoked',
            'device_key_id' => $keyRowId,
            'reason' => $reason,
        ]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Challenge issuance (Phase 4) — the client NEVER chooses the challenge
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Issue a single-use challenge bound to (user, device, session, action,
     * request_hash). The action comes from the SERVER-SIDE whitelist; the
     * device binding from the SERVER'S device row; the request_hash is the
     * SHA-256 of the exact body the client intends to send.
     *
     * @return array{challenge:string, action:string, expires_in:int, counter_at_issue:int}
     */
    public static function issueChallenge(
        string $userId,
        string $action,
        string $deviceFingerprint,
        ?string $sessionId,
        string $requestHash
    ): array {
        if (!in_array($action, self::KNOWN_ACTIONS, true)) {
            // A client cannot invent privileged action names.
            throw new ApiException(422, 'Unknown protected action');
        }
        if ($deviceFingerprint === '') {
            throw new ApiException(422, 'device_fingerprint is required');
        }
        if (!preg_match('/^[0-9a-f]{64}$/', $requestHash)) {
            throw new ApiException(422, 'request_hash must be 64 lowercase hex chars');
        }

        $policy = self::policy();

        // The device must exist in the SERVER's device table — the binding is
        // server state, not a client claim.
        $device = Database::instance()->row(
            'SELECT id, status FROM devices WHERE user_id = ? AND device_fingerprint = ? LIMIT 1',
            [$userId, $deviceFingerprint]
        );
        if ($device === null) {
            throw new ApiException(403, 'Device not registered');
        }
        if ((string) $device['status'] === 'blocked') {
            throw new ApiException(403, 'Device is blocked');
        }

        // Counter snapshot binds the challenge to the key's replay state.
        $counterAtIssue = (int) (Database::instance()->value(
            'SELECT counter FROM device_keys
              WHERE user_id = ? AND device_fingerprint = ? AND status = ? ORDER BY registered_at DESC LIMIT 1',
            [$userId, $deviceFingerprint, 'active'],
            0
        ) ?? 0);

        $challenge = bin2hex(random_bytes(32));
        $expiresAt = gmdate('Y-m-d H:i:s', time() + $policy['challenge_ttl']);
        Database::instance()->insert(
            'INSERT INTO security_challenges
                (id, challenge, user_id, device_id, device_fingerprint, session_id, action, request_hash, counter_at_issue, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $challenge, $userId, $device['id'], $deviceFingerprint, $sessionId, $action, $requestHash, $counterAtIssue, $expiresAt]
        );

        return [
            'challenge' => $challenge,
            'action' => $action,
            'expires_in' => $policy['challenge_ttl'],
            'counter_at_issue' => $counterAtIssue,
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Evidence verification (Phases 4–6) — the ONLY path to a decision row
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Verify challenge + signature + evidence and persist the assurance
     * decision. Returns the evidence row id (what the protected call
     * references via X-Security-Evidence) and the derived assurance.
     *
     * @param array{challenge:string, device_fingerprint:string, key_id:string,
     *              timestamp:int, counter:int, action:string, request_hash:string,
     *              evidence:array} $payload
     * @param string $signatureB64 base64 DER ECDSA-SHA256 signature over the
     *                             canonical (sorted-key) JSON of $payload
     * @return array{evidence_id:string, assurance:string}
     */
    public static function verifyEvidence(
        string $userId,
        string $sessionId,
        array $payload,
        string $signatureB64,
        string $ip
    ): array {
        $db = Database::instance();
        $policy = self::policy();

        // 0. Structural pre-checks (cheap failures before any crypto).
        $challenge = (string) ($payload['challenge'] ?? '');
        $fingerprint = (string) ($payload['device_fingerprint'] ?? '');
        $keyId = (string) ($payload['key_id'] ?? '');
        $timestamp = (int) ($payload['timestamp'] ?? 0);
        $counter = (int) ($payload['counter'] ?? 0);
        $action = (string) ($payload['action'] ?? '');
        $requestHash = (string) ($payload['request_hash'] ?? '');
        $evidence = is_array($payload['evidence'] ?? null) ? $payload['evidence'] : [];

        if ($challenge === '' || $fingerprint === '' || $keyId === '' || $action === '' || $requestHash === '') {
            return self::recordDecision($userId, null, null, $action ?: 'unknown', 'BLOCKED', false, 'malformed_payload', $payload, $ip);
        }
        if (json_encode($payload) === false || strlen((string) json_encode($payload)) > self::MAX_EVIDENCE_BYTES) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'evidence_too_large', $payload, $ip);
        }

        // 1. Challenge lookup — must be unexpired, unconsumed, user-owned.
        $ch = $db->row(
            'SELECT id, user_id, device_id, device_fingerprint, session_id, action, request_hash, counter_at_issue
               FROM security_challenges
              WHERE challenge = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)
              LIMIT 1',
            [$challenge]
        );
        if ($ch === null) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'challenge_invalid_or_expired', $payload, $ip);
        }
        if ((string) $ch['user_id'] !== $userId) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'challenge_user_mismatch', $payload, $ip);
        }
        if ((string) $ch['action'] !== $action) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'challenge_action_mismatch', $payload, $ip);
        }
        if ((string) $ch['device_fingerprint'] !== $fingerprint) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'challenge_device_mismatch', $payload, $ip);
        }
        // Session binding: when the challenge carries a session and the request
        // supplies one, they must agree; a challenge bound to session A cannot
        // be spent from session B.
        $chSession = (string) ($ch['session_id'] ?? '');
        if ($chSession !== '' && $sessionId !== '' && !hash_equals($chSession, $sessionId)) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'challenge_session_mismatch', $payload, $ip);
        }
        // Request-hash binding: the evidence must cover the exact request.
        if (!hash_equals((string) $ch['request_hash'], $requestHash)) {
            return self::recordDecision($userId, null, null, $action, 'BLOCKED', false, 'request_hash_mismatch', $payload, $ip);
        }

        // 2. Device key — server-stored public key, active status, user-owned.
        //    verified_at/registered_at feed the bootstrap cap + promotion.
        $key = $db->row(
            'SELECT id, user_id, device_fingerprint, public_key_pem, status, counter,
                    verified_at, registered_at, integrity_baseline_sha256, integrity_last_sha256
               FROM device_keys
              WHERE user_id = ? AND key_id = ? AND device_fingerprint = ?
              ORDER BY registered_at DESC LIMIT 1',
            [$userId, $keyId, $fingerprint]
        );
        if ($key === null) {
            return self::recordDecision($userId, null, (string) $ch['id'], $action, 'BLOCKED', false, 'device_key_unregistered', $payload, $ip);
        }
        if ((string) $key['status'] !== 'active') {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'device_key_revoked', $payload, $ip);
        }

        // 3. Timestamp freshness + monotonic counter (anti-replay).
        $now = time();
        if ($timestamp < $now - self::CLOCK_SKEW || $timestamp > $now + self::CLOCK_SKEW) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'timestamp_out_of_range', $payload, $ip);
        }
        if ($counter <= (int) $key['counter']) {
            // Replayed or reordered signature — reject transactionally below.
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'counter_replayed', $payload, $ip);
        }
        if ($counter - (int) $key['counter'] > 1000) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'counter_gap_suspicious', $payload, $ip);
        }

        // 4. Signature over the CANONICAL serialization (sorted keys, compact).
        $canonical = self::canonicalJson($payload);
        if (!self::verifyEcdsaP256($canonical, $signatureB64, (string) $key['public_key_pem'])) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'signature_invalid', $payload, $ip);
        }

        // 5. Evidence schema validation.
        if ((int) ($evidence['schema_version'] ?? 0) !== self::EVIDENCE_VERSION) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
        }

        // 5a. v2 field validation — types/allowed values only. Fields live at
        //     payload TOP LEVEL (next to schema_version), matching the client's
        //     canonical payload. Absent optional fields are tolerated (older
        //     patched clients cannot omit their way to trust: omitted integrity
        //     simply skips baseline anchoring and the policy layer below still
        //     applies).
        $integ = $payload['integrity'] ?? null;
        if ($integ !== null) {
            if (!is_array($integ)) {
                return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
            }
            foreach (['dex_sha256', 'libs_sha256', 'assets_sha256', 'runtime_sha256'] as $h) {
                $v = (string) ($integ[$h] ?? '');
                if ($v !== '' && !preg_match('/^[0-9a-f]{64}$/', $v)) {
                    return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
                }
            }
            $libs = $integ['libs'] ?? [];
            if (!is_array($libs) || count($libs) > 32) {
                return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
            }
        }
        $vs = $payload['vpn_state'] ?? null;
        if ($vs !== null && !in_array($vs, ['unknown', 'off', 'on', 'suspicious'], true)) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
        }
        $nn = $payload['integrity']['native_net'] ?? null;
        if ($nn !== null) {
            if (!is_array($nn) || count($nn) > 24) {
                return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
            }
        }
        $cv = $payload['config_version'] ?? null;
        if ($cv !== null && (!is_int($cv) || $cv < 0 || $cv > 2147483647)) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'evidence_schema_mismatch', $payload, $ip);
        }

        // 5b. Opportunistic SERVER-SIDE promotion of an unverified key
        //     (bootstrap path). Conditions are entirely server-observed —
        //     tenure, account status, device status, optional integrity
        //     verdict — so no client input can accelerate them.
        if (empty($key['verified_at']) && self::tryPromoteKey($key)) {
            $key['verified_at'] = gmdate('Y-m-d H:i:s');
        }

        // 5c. Server-anchored INTEGRITY BASELINE (migration 020). The measured
        //     runtime digest arrives inside the SIGNED payload; the server
        //     compares it against ITS stored baseline / optional pinned value.
        $measured = strtolower(trim((string) ($payload['integrity']['runtime_sha256'] ?? '')));
        $integrityState = 'absent';
        if (preg_match('/^[0-9a-f]{64}$/', $measured)) {
            $integrityState = 'ok';
            $pinned = self::pinnedIntegrityBaseline();
            if ($pinned !== null) {
                if (!hash_equals($pinned, $measured)) {
                    return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'integrity_mismatch', $payload, $ip, null, 'rejected');
                }
            } else {
                $baseline = (string) ($key['integrity_baseline_sha256'] ?? '');
                if ($baseline === '') {
                    // First-seen-wins ANCHORING (never attestation): the
                    // server records what THIS binding presented first so
                    // later changes are detectable. It is NOT proof of the
                    // official binary — a modified APK poisons its OWN
                    // baseline here, which is why anchoring never feeds
                    // promotion and never yields more than the evidence
                    // state it earns (integrity_state stays 'anchored').
                    $db->query(
                        'UPDATE device_keys SET integrity_baseline_sha256 = ? WHERE id = ?',
                        [$measured, $key['id']]
                    );
                    $integrityState = 'anchored';
                } elseif (!hash_equals($baseline, $measured)) {
                    // The binary changed under this device binding — the exact
                    // signal a re-signed/re-packed APK produces.
                    return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'integrity_mismatch', $payload, $ip, null, 'rejected');
                }
            }
            $db->query(
                'UPDATE device_keys SET integrity_last_sha256 = ?, integrity_last_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$measured, $key['id']]
            );
        }

        // 6. Consume the challenge + bump the counter TRANSACTIONALLY — two
        //    concurrent spends of one challenge can never both win.
        $consumed = false;
        $db->transaction(function (Database $tx) use (&$consumed, $ch, $key, $counter, $policy) {
            $claim = $tx->query(
                'UPDATE security_challenges SET consumed_at = UTC_TIMESTAMP(6)
                  WHERE id = ? AND consumed_at IS NULL',
                [$ch['id']]
            );
            if ($claim->rowCount() === 1) {
                $tx->query(
                    'UPDATE device_keys SET counter = GREATEST(counter, ?), last_used_at = UTC_TIMESTAMP(6) WHERE id = ?',
                    [$counter, $key['id']]
                );
                $consumed = true;
            }
        });
        if (!$consumed) {
            return self::recordDecision($userId, (string) $key['id'], (string) $ch['id'], $action, 'BLOCKED', false, 'challenge_reused', $payload, $ip);
        }

        // 7. Derive ASSURANCE from verified evidence + server-side state.
        //    Client booleans are inputs to this function — never the verdict.
        [$assurance, $detail] = self::deriveAssurance($evidence, $policy, $key, $payload['vpn_state'] ?? null);
        $passed = $assurance !== 'BLOCKED';

        $decision = self::recordDecision(
            $userId,
            (string) $key['id'],
            (string) $ch['id'],
            $action,
            $assurance,
            $passed,
            $passed ? null : 'assurance_blocked',
            $payload,
            $ip,
            $detail,
            $integrityState
        );

        try {
            (new SecurityService())->logEvent($userId, [
                'event_type' => $passed ? 'security_evidence_verified' : 'security_evidence_rejected',
                'detection_method' => "device-key challenge/response action={$action} assurance={$assurance}",
                'policy_action' => $passed ? 'log_only' : 'block_login',
                'risk_score' => $passed ? null : 50,
                'device_id' => (string) $ch['device_id'],
                'platform' => 'android',
                'ip_address' => $ip,
            ]);
        } catch (\Throwable) {
            // Telemetry must never break the flow.
        }

        return $decision;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Enforcement (Phase 7/14) — the single call protected endpoints make
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Tiered enforcement for a protected action (mirrors IntegrityService).
     * Tiers:
     *   log_only       → record only, never block (default; rollout-safe).
     *   enforce        → requires a live decision row with assurance
     *                    TRUSTED or DEGRADED (bootstrap-tolerant).
     *   enforce_strict → requires TRUSTED — i.e. a server-VERIFIED key.
     *                    A freshly registered (UNVERIFIED) key is capped at
     *                    DEGRADED and therefore cannot satisfy this tier.
     */
    public static function assertEvidenceAllowed(string $userId, string $action, ?string $evidenceId, string $ip): void
    {
        $policy = self::policy();
        $tier = $policy['actions'][$action] ?? 'log_only';
        if ($tier !== 'enforce' && $tier !== 'enforce_strict') {
            return;
        }

        $ok = false;
        $reason = 'no_evidence';
        if ($evidenceId !== null && $evidenceId !== '') {
            $row = Database::instance()->row(
                'SELECT id, assurance, integrity_state FROM security_evidence
                  WHERE id = ? AND user_id = ? AND action = ? AND passed = 1 AND expires_at > UTC_TIMESTAMP(6)
                  LIMIT 1',
                [$evidenceId, $userId, $action]
            );
            // Server-anchored integrity: a decision row whose binary measurement
            // was REJECTED against the stored baseline / pinned digest can never
            // authorize a protected action — independent of the tier.
            if ($row !== null && (string) ($row['integrity_state'] ?? '') === 'rejected') {
                $ok = false;
                $reason = 'integrity_rejected';
                $row = null;
            }
            if ($row !== null) {
                $accepted = $tier === 'enforce_strict'
                    ? [(string) $row['assurance']] === ['TRUSTED']
                    : in_array((string) $row['assurance'], ['TRUSTED', 'DEGRADED'], true);
                if ($accepted) {
                    $ok = true;
                } else {
                    $reason = $tier === 'enforce_strict'
                        ? 'key_not_verified_or_assurance_low'
                        : 'assurance_blocked';
                }
            } else {
                $reason = 'evidence_invalid_or_expired';
            }
        }

        if ($ok) {
            return;
        }

        try {
            (new SecurityService())->logEvent($userId, [
                'event_type' => 'security_evidence_enforcement_failed',
                'detection_method' => "Missing/invalid signed evidence for {$action} ({$reason})",
                'policy_action' => 'block_login',
                'risk_score' => 40,
                'platform' => 'android',
                'ip_address' => $ip,
            ]);
        } catch (\Throwable) {
            // ignore
        }

        throw new ApiException(403, 'This action requires a verified device security check. Please reopen the app and try again.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Assurance derivation (Phase 7)
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Inputs are the SIGNED evidence fields (the client cannot forge the
    // signature; it CAN falsify the values — so this is deliberately layered:
    // server-visible risk signals like revocation, challenge abuse and
    // reputation can independently push BLOCKED, and the policy tiers decide
    // whether the assurance gates anything).

    /**
     * @param array $key the device_keys row (carries verified_at/registered_at)
     * @param string|null $vpnStateOverride payload-level vpn_state (schema v2)
     * @return array{0:string,1:array} [assurance, detail]
     */
    private static function deriveAssurance(array $evidence, array $policy, array $key = [], ?string $vpnStateOverride = null): array
    {
        // The client's evidence field IS the sensor-flag map (flat: vpn, adb,
        // tampered, …). Accept a nested {'flags': …} form too for forward
        // compatibility, but never require it.
        $flags = is_array($evidence['flags'] ?? null) ? $evidence['flags'] : $evidence;

        // Values are true = risk present. Unknown/absent = not observed.
        $blocking = ['vpn', 'developer_options', 'adb', 'debugger', 'tampered', 'root', 'magisk', 'frida', 'xposed', 'emulator', 'mock_location'];
        $blockingHits = [];
        foreach ($blocking as $signal) {
            if (!empty($flags[$signal])) {
                $blockingHits[] = $signal;
            }
        }

        if ($blockingHits !== []) {
            return ['BLOCKED', ['blocking_signals' => $blockingHits]];
        }

        // ── VPN state model (schema v2) ──────────────────────────────────
        // Four-state aggregate from the native layer. "on" is BLOCKING
        // (existing VPN policy, unchanged). "suspicious" — the network
        // callback observed a VPN that the sensors now deny — degrades but
        // does not block (uncertain signal; existing policy untouched).
        $vpnState = $evidence['vpn_state'] ?? $vpnStateOverride;
        if ($vpnState === 'on') {
            return ['BLOCKED', ['blocking_signals' => ['vpn_state_on']]];
        }

        $warn = [];
        if ($vpnState === 'suspicious') { $warn[] = 'vpn_state_suspicious'; }
        if ($vpnState === 'unknown') { $warn[] = 'vpn_state_unknown'; }
        if (!empty($flags['proxy'])) { $warn[] = 'proxy'; }
        if (!empty($flags['overlay'])) { $warn[] = 'overlay'; }
        if (!empty($flags['screen_recording'])) { $warn[] = 'screen_recording'; }
        if (!empty($flags['test_only'])) { $warn[] = 'test_only'; }
        if (!empty($flags['signature_mismatch'])) { $warn[] = 'signature_mismatch'; }

        if ($policy['require_registered_key'] && empty($evidence['device_key_registered'])) {
            $warn[] = 'key_not_confirmed';
        }

        // ── BOOTSTRAP CAP (the core initial-device-trust rule) ──────────────
        // Signed evidence is SELF-ASSERTED: a patched APK can sign all-clean
        // flags. Therefore evidence can only LOWER assurance from the
        // server-side baseline — it can never establish TRUSTED by itself.
        // TRUSTED requires the SERVER to have promoted the key (verified_at
        // set by tryPromoteKey after server-observed tenure/conditions).
        $keyVerified = !empty($key['verified_at']);
        if (!$keyVerified) {
            $warn[] = 'key_unverified';
            return ['DEGRADED', ['warning_signals' => $warn, 'bootstrap' => 'unverified_key_capped_at_degraded']];
        }

        if ($warn !== []) {
            return ['DEGRADED', ['warning_signals' => $warn]];
        }

        return ['TRUSTED', ['verified' => 'signature + challenge + counter + verified key + policy']];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Server-side key promotion (bootstrap path — no client input)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attempt to promote an UNVERIFIED device key to verified after
     * SERVER-OBSERVED conditions hold:
     *   - key age ≥ warmup_hours (time the client cannot compress),
     *   - the account is active,
     *   - the device row is active,
     *   - optionally (policy) a live Play Integrity verdict exists for the
 *     user (server-verified APK layer, migration 017).
     *
     * Called opportunistically on evidence verification (lazy promotion) so
     * no scheduler is required. Returns true if this call promoted the key.
     */
    public static function tryPromoteKey(array $key): bool
    {
        if (!empty($key['verified_at']) || ($key['status'] ?? '') !== 'active') {
            return false;
        }

        $policy = self::policy();
        // DB timestamps are UTC (UTC_TIMESTAMP(6) everywhere) — parse them in
        // UTC explicitly; strtotime() would use the server's local TZ.
        $registeredAt = null;
        try {
            $registeredAt = (new \DateTimeImmutable(
                (string) ($key['registered_at'] ?? ''), new \DateTimeZone('UTC')
            ))->getTimestamp();
        } catch (\Exception) {
            return false;
        }
        if ((time() - $registeredAt) < $policy['warmup_hours'] * 3600) {
            return false;
        }

        $db = Database::instance();
        $profile = $db->row(
            'SELECT status, violation_count, strike_count FROM profiles WHERE id = ? LIMIT 1',
            [$key['user_id']]
        );
        if ($profile === null || (string) $profile['status'] !== 'active') {
            return false;
        }
        // Server-recorded violation history gates promotion: a key attached to
        // an account with active strikes stays UNVERIFIED (DEGRADED-capped).
        // This state is written by SecurityService::processViolation from
        // server-evaluated flows — the client cannot alter it.
        if ((int) $profile['violation_count'] > 0 || (int) $profile['strike_count'] > 0) {
            return false;
        }
        $device = $db->row(
            'SELECT status FROM devices WHERE user_id = ? AND device_fingerprint = ? LIMIT 1',
            [$key['user_id'], $key['device_fingerprint']]
        );
        if ($device === null || (string) $device['status'] !== 'active') {
            return false;
        }
        // Part 4: an unverified key with NO integrity history is never
        // promoted — trust requires observed binary continuity, which a
        // client cannot fabricate retroactively (anchored rows are written
        // only by verifyEvidence with a valid challenge/signature).
        if (!empty($policy['promotion_require_integrity_history'])) {
            $anchored = $db->value(
                'SELECT COUNT(*) FROM security_evidence
                  WHERE device_key_id = ? AND integrity_state IN (\'anchored\', \'ok\') AND created_at > DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 7 DAY)',
                [$key['id']]
            );
            if ((int) $anchored === 0) {
                return false;
            }
        }
        if ($policy['promotion_require_integrity']) {
            $verdict = $db->value(
                'SELECT id FROM play_integrity_verdicts
                  WHERE user_id = ? AND passed = 1 AND expires_at > UTC_TIMESTAMP(6)
                  ORDER BY created_at DESC LIMIT 1',
                [$key['user_id']]
            );
            if ($verdict === null) {
                return false;
            }
        }

        $db->query(
            "UPDATE device_keys SET verified_at = UTC_TIMESTAMP(6), verification_note = 'server_promoted (tenure+state)'
              WHERE id = ? AND verified_at IS NULL",
            [$key['id']]
        );
        try {
            (new SecurityService())->logEvent((string) $key['user_id'], [
                'event_type' => 'security_evidence_verified',
                'detection_method' => 'device key promoted to verified (server-side tenure + account/device state)',
                'policy_action' => 'log_only',
                'platform' => 'android',
            ]);
        } catch (\Throwable) {
            // Telemetry must never break the flow.
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Operator-pinned release digest from security_config
     * (device_evidence.integrity_pinned_sha256). Null = not pinned; the
     * server then uses first-seen anchoring per device key.
     */
    public static function pinnedIntegrityBaseline(): ?string
    {
        $policy = self::policy();
        $pinned = (string) ($policy['integrity_pinned_sha256'] ?? '');
        return preg_match('/^[0-9a-f]{64}$/', $pinned) ? $pinned : null;
    }

    /**
     * Canonical JSON: recursively sort object keys, minimal separators.
     * The client (JS/TS) produces the same form via a shared algorithm —
     * JSON.stringify of a key-sorted rebuild, no whitespace.
     */
    public static function canonicalJson(array $data): string
    {
        $enc = static function ($v) use (&$enc): string {
            if (is_array($v)) {
                $isList = array_keys($v) === range(0, count($v) - 1);
                if ($isList) {
                    return '[' . implode(',', array_map($enc, $v)) . ']';
                }
                $pairs = [];
                $keys = array_keys($v);
                sort($keys, SORT_STRING);
                foreach ($keys as $k) {
                    $pairs[] = json_encode((string) $k, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ':' . $enc($v[$k]);
                }
                return '{' . implode(',', $pairs) . '}';
            }
            if (is_int($v) || is_float($v)) {
                return (string) $v;
            }
            if (is_bool($v)) {
                return $v ? 'true' : 'false';
            }
            if ($v === null) {
                return 'null';
            }
            return json_encode((string) $v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        };
        return $enc($data);
    }

    /** Verify an ECDSA-SHA256 signature (DER, base64 or base64url) over $data. */
    public static function verifyEcdsaP256(string $data, string $signatureB64, string $publicKeyPem): bool
    {
        $raw = base64_decode(strtr($signatureB64, '-_', '+/'), true);
        if ($raw === false || $raw === '') {
            return false;
        }
        $key = openssl_pkey_get_public($publicKeyPem);
        if ($key === false) {
            return false;
        }
        $ok = openssl_verify($data, $raw, $key, OPENSSL_ALGO_SHA256) === 1;
        openssl_free_key($key);
        return $ok;
    }

    /** Validate the client-supplied SPKI PEM is a parseable EC public key. */
    private static function assertValidSpkiPem(string $pem): void
    {
        $key = openssl_pkey_get_public($pem);
        if ($key === false) {
            throw new ApiException(422, 'public_key_pem is not a valid public key');
        }
        $details = openssl_pkey_get_details($key);
        openssl_free_key($key);
        if ($details === false
            || ($details['type'] ?? null) !== OPENSSL_KEYTYPE_EC
            || (int) ($details['bits'] ?? 0) !== 256) {
            throw new ApiException(422, 'public_key_pem must be an EC P-256 public key');
        }
    }

    /**
     * Persist a decision row (both pass and fail paths) and return its id.
     *
     * @return array{evidence_id:string, assurance:string}
     */
    private static function recordDecision(
        string $userId,
        ?string $deviceKeyId,
        ?string $challengeId,
        string $action,
        string $assurance,
        bool $passed,
        ?string $reason,
        array $payload,
        string $ip,
        ?array $detail = null,
        string $integrityState = 'absent'
    ): array {
        $policy = self::policy();
        $id = Uuid::v4();
        try {
            Database::instance()->insert(
                'INSERT INTO security_evidence
                    (id, user_id, device_key_id, challenge_id, action, assurance, integrity_state, passed, reason, evidence_json, assurance_detail, ip_address, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))',
                [
                    $id,
                    $userId,
                    $deviceKeyId,
                    $challengeId,
                    $action,
                    $assurance,
                    $integrityState,
                    $passed ? 1 : 0,
                    $reason,
                    json_encode($payload, JSON_UNESCAPED_SLASHES) ?: null,
                    $detail !== null ? json_encode($detail, JSON_UNESCAPED_SLASHES) : null,
                    $ip,
                    $policy['evidence_ttl'],
                ]
            );
        } catch (\Throwable $e) {
            // A failed audit write must not leak verification results to the
            // caller as a pass — fall back to a hard reject id the protected
            // endpoint can never match.
            $id = '00000000-0000-0000-0000-000000000000';
            if ($passed) {
                $passed = false;
                $assurance = 'UNKNOWN';
            }
            unset($e);
        }
        return ['evidence_id' => $id, 'assurance' => $assurance, 'passed' => $passed];
    }
}
