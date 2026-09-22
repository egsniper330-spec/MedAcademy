<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * IntegrityService — server-side Play Integrity verification + enforcement.
 *
 * SECURITY MODEL
 * ──────────────
 * The Android client is UNTRUSTED. A modified APK can flip every client-side
 * detection (VPN, adb, root, tamper, …) to "clean". Therefore protected
 * backend operations must satisfy a SERVER-side policy before executing:
 *
 *   1. The client requests a challenge (action=get_nonce, action=<key>).
 *      The server generates a random 256-bit request_hash and stores it
 *      single-use with a 5-minute TTL, together with the action key.
 *   2. The client passes that string to the Play Integrity API (classic
 *      request). Google binds it into the signed payload as
 *      requestDetails.requestHash.
 *   3. The client sends { action:"verify", token, request_hash } and the
 *      backend decodes the token via Google's own API and validates
 *      EVERYTHING itself:
 *        - requestDetails.requestPackageName  (must equal our package)
 *        - requestDetails.requestHash         (must equal the issued hash)
 *        - appIntegrity.appRecognitionVerdict (PLAY_RECOGNIZED / policy)
 *        - appIntegrity.certificateSha256Digest (production signing cert)
 *        - deviceIntegrity.deviceRecognitionVerdict (policy)
 *   4. On pass, the verdict is persisted (play_integrity_verdicts) bound to
 *      (user_id, action, request_hash) with a short TTL. Protected endpoints
 *      call assertActionAllowed($userId, $action, $hashHeader) — the ONLY
 *      thing that decides whether the operation runs.
 *
 * Nothing the client can set (a cached "passed" flag, a fabricated header, a
 * stolen verdict row for another user/action) produces authorization: only
 * Google's decoded payload does. A tampered APK re-signed with a different
 * key fails the certificate check; a replayed token fails the requestHash
 * check; a stolen verdict fails the user/action binding; an old verdict
 * fails the TTL.
 */
final class IntegrityService
{
    /** Header the client sends on protected calls: the request_hash whose integrity verdict covers the call. */
    public const HEADER = 'x-integrity-hash';

    private const GOOGLE_API = 'https://playintegrity.googleapis.com';
    private const GOOGLE_OAUTH = 'https://oauth2.googleapis.com/token';

    /** @var array<string, mixed>|null in-process policy cache */
    private static ?array $policyCache = null;

    // ─────────────────────────────────────────────────────────────────────────
    // Policy
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Effective Play-Integrity policy, merged from:
     *   hard defaults  ←  security_config.extras.play_integrity (operator)
     *
     * Default per-action tier is "log_only" so no legitimate user is locked
     * out until an operator flips specific actions to "enforce".
     *
     * @return array{enabled:bool, actions:array<string,string>, app_verdicts:string[],
     *               require_device_integrity:bool, require_cert_match:bool, verdict_ttl:int}
     */
    public static function policy(): array
    {
        if (self::$policyCache !== null) {
            return self::$policyCache;
        }

        $enabled = false;
        $extra = [];
        try {
            $row = Database::instance()->row(
                'SELECT play_integrity_enabled, extras FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
            );
            if ($row !== null) {
                $enabled = (bool) $row['play_integrity_enabled'];
                $decoded = json_decode((string) ($row['extras'] ?? '{}'), true);
                if (is_array($decoded)) {
                    $extra = $decoded;
                }
            }
        } catch (\Throwable) {
            // DB hiccup → hard defaults below. Enforcement stays opt-in via
            // config; nothing client-supplied is trusted either way.
        }

        $pi = is_array($extra['play_integrity'] ?? null) ? $extra['play_integrity'] : [];

        self::$policyCache = [
            'enabled'                 => $enabled,
            // Known protected actions; unknown keys fall back to log_only.
            'actions'                 => array_merge([
                'vdo_otp'     => 'log_only',
                'redeem'      => 'log_only',
                'device_bind' => 'log_only',
                'financial'   => 'log_only',
            ], is_array($pi['actions'] ?? null) ? array_map('strval', $pi['actions']) : []),
            'app_verdicts'            => array_values(array_map('strval', $pi['app_verdicts'] ?? ['PLAY_RECOGNIZED'])),
            'require_device_integrity' => (bool) ($pi['require_device_integrity'] ?? true),
            'require_cert_match'      => (bool) ($pi['require_cert_match'] ?? true),
            'verdict_ttl'             => max(60, min(900, (int) ($pi['verdict_ttl_seconds'] ?? 300))),
        ];
        return self::$policyCache;
    }

    /** Test/ops hook: reset the in-process policy cache after config changes. */
    public static function resetPolicyCache(): void
    {
        self::$policyCache = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Challenge issuance (binding part 1)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Issue a fresh request_hash challenge for a protected action.
     * The hash IS the value the client passes to the Play Integrity API and
     * later echoes in the X-Integrity-Hash header of the protected call.
     *
     * @return array{request_hash:string, action:string, expires_in:int}
     */
    public static function issueChallenge(string $userId, string $action): array
    {
        $requestHash = bin2hex(random_bytes(32)); // 256-bit → 64 hex chars
        $expiresAt = gmdate('Y-m-d H:i:s', time() + 300); // 5-minute window
        Database::instance()->query(
            'INSERT INTO play_integrity_nonces (id, request_hash, action, user_id, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $requestHash, $action, $userId, $expiresAt]
        );
        return ['request_hash' => $requestHash, 'action' => $action, 'expires_in' => 300];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token verification (the server is the ONLY judge)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Decode + validate a Play Integrity token against a just-issued
     * challenge. Persists the verdict row on success. Throws ApiException on
     * any validation failure — the client never receives a partial verdict.
     *
     * @return array{passed:true, verdict:string, request_hash:string}
     */
    public static function verifyToken(string $userId, string $token, string $requestHash, string $ip): array
    {
        $policy = self::policy();

        if ($token === '' || $requestHash === '') {
            throw new ApiException(422, 'token and request_hash are required');
        }

        $db = Database::instance();

        // 1. Challenge must exist, be unexpired, unconsumed and session-owned.
        //    The action it authorizes is read FROM THE STORED ROW — the client
        //    cannot mint a hash covering action B while the challenge was
        //    issued for action A.
        $row = $db->row(
            'SELECT id, user_id, action FROM play_integrity_nonces
              WHERE request_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6) LIMIT 1',
            [$requestHash]
        );
        if ($row === null || (string) $row['user_id'] !== $userId) {
            throw new ApiException(403, 'Integrity challenge invalid or expired');
        }
        $action = (string) ($row['action'] ?? '');
        if ($action === '') {
            // Legacy nonce row (issued before request-hash migration).
            throw new ApiException(403, 'Integrity challenge invalid or expired');
        }

        // 2. Credentials must be configured — verification FAILS CLOSED.
        //    A missing/invalid credential must never silently pass a tampered
        //    client (the legacy fail-open paths are deliberately removed).
        $packageName = Config::string('ANDROID_PACKAGE_NAME', 'com.medacademy.app');
        $saJson = Config::string('GOOGLE_SERVICE_ACCOUNT_JSON', '');
        if ($saJson === '') {
            throw new ApiException(503, 'Integrity verification is not configured');
        }

        $payload = self::decodeWithGoogle($token, $packageName);
        $details = is_array($payload['requestDetails'] ?? null) ? $payload['requestDetails'] : [];
        $appInt  = is_array($payload['appIntegrity'] ?? null) ? $payload['appIntegrity'] : [];
        $devInt  = is_array($payload['deviceIntegrity'] ?? null) ? $payload['deviceIntegrity'] : [];

        // 3. requestPackageName — the token must be minted for OUR app.
        if ((string) ($details['requestPackageName'] ?? '') !== $packageName) {
            throw new ApiException(403, 'Integrity verification failed');
        }

        // 4. requestHash — token must cover THIS challenge (anti-replay).
        if (!hash_equals($requestHash, (string) ($details['requestHash'] ?? ''))) {
            throw new ApiException(403, 'Integrity verification failed');
        }

        // 5. App recognition + signing certificate (tampered/re-signed APK
        //    detection — the digest is reported BY GOOGLE, never by us).
        $appVerdict = (string) ($appInt['appRecognitionVerdict'] ?? '');
        if (!in_array($appVerdict, $policy['app_verdicts'], true)) {
            throw new ApiException(403, 'Integrity verification failed');
        }

        $cert = '';
        $certs = $appInt['certificateSha256Digest'] ?? [];
        if (is_array($certs) && $certs !== []) {
            $cert = strtolower(str_replace(':', '', (string) $certs[0]));
        }
        if ($policy['require_cert_match']) {
            $expected = self::expectedCertDigests();
            if ($expected !== [] && !in_array($cert, $expected, true)) {
                // A re-signed APK presents a different certificate digest —
                // exactly the signal the smali-tamper test exercised.
                throw new ApiException(403, 'Integrity verification failed');
            }
        }

        // 6. Device integrity (policy-tunable; basic-integrity devices are
        //    accepted so legitimate low-end users are not locked out).
        if ($policy['require_device_integrity']) {
            $device = is_array($devInt['deviceRecognitionVerdict'] ?? null)
                ? $devInt['deviceRecognitionVerdict']
                : [];
            if (!in_array('MEETS_DEVICE_INTEGRITY', $device, true)
                && !in_array('MEETS_BASIC_INTEGRITY', $device, true)) {
                throw new ApiException(403, 'Integrity verification failed');
            }
        }

        // 7. Consume the challenge (single-use) and persist the verdict bound
        //    to (user, action, request_hash-as-stored-on-the-challenge).
        $db->query('UPDATE play_integrity_nonces SET consumed_at = UTC_TIMESTAMP(6) WHERE id = ?', [$row['id']]);
        $db->query('DELETE FROM play_integrity_verdicts WHERE request_hash = ?', [$requestHash]);
        $db->query(
            'INSERT INTO play_integrity_verdicts
                (id, user_id, request_hash, action, passed, verdict, cert_sha256, ip_address, created_at, expires_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))',
            [
                Uuid::v4(), $userId, $requestHash, $action,
                implode(';', array_filter([
                    $appVerdict,
                    implode(',', is_array($devInt['deviceRecognitionVerdict'] ?? null) ? $devInt['deviceRecognitionVerdict'] : []),
                    $cert !== '' ? $cert : 'no-cert',
                ])),
                $cert !== '' ? $cert : null,
                $ip,
                $policy['verdict_ttl'],
            ]
        );

        try {
            (new SecurityService())->logEvent($userId, [
                'event_type'       => 'play_integrity_passed',
                'detection_method' => "Play Integrity verified server-side: {$appVerdict}",
                'policy_action'    => 'log_only',
                'platform'         => 'android',
                'ip_address'       => $ip,
            ]);
        } catch (\Throwable) {
            // Telemetry must never break authorization.
        }

        return ['passed' => true, 'verdict' => $appVerdict, 'request_hash' => $requestHash];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Enforcement — the single call protected endpoints must make
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Tiered enforcement for a protected action.
     *
     * Behavior when verification is disabled (play_integrity_enabled=0) or the
     * action's tier is "log_only": nothing is required and the call proceeds.
     * When the tier is "enforce" AND verification is enabled: a live verdict
     * row (Google-produced, bound to this user + action + hash) must exist;
     * anything else → 403. A client that simply omits the header can never
     * satisfy "enforce" because only Google's decoded payload writes rows.
     */
    public static function assertActionAllowed(string $userId, string $action, ?string $hash, string $ip): void
    {
        $policy = self::policy();
        $tier = $policy['actions'][$action] ?? 'log_only';
        if ($tier !== 'enforce' || !$policy['enabled']) {
            return; // not enforced — nothing to check (no client input consulted)
        }

        $ok = false;
        $reason = 'no_verdict';

        if ($hash !== null && $hash !== '') {
            $row = Database::instance()->row(
                'SELECT id FROM play_integrity_verdicts
                  WHERE user_id = ? AND request_hash = ? AND action = ? AND passed = 1 AND expires_at > UTC_TIMESTAMP(6)
                  LIMIT 1',
                [$userId, $hash, $action]
            );
            if ($row !== null) {
                $ok = true;
            } else {
                $reason = 'verdict_invalid_or_expired';
            }
        }

        if ($ok) {
            return;
        }

        try {
            (new SecurityService())->logEvent($userId, [
                'event_type'       => 'play_integrity_failed',
                'detection_method' => "Missing/invalid integrity verdict for {$action} ({$reason})",
                'policy_action'    => 'block_login',
                'risk_score'       => 40,
                'platform'         => 'android',
                'ip_address'       => $ip,
            ]);
        } catch (\Throwable) {
            // ignore — the 403 below is the boundary, not the log
        }

        throw new ApiException(403, 'This action requires a verified app integrity check. Please reinstall the app from the official source.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    /** Production signing-cert digests from security_config.expected_cert_sha256s (+ legacy single column). */
    private static function expectedCertDigests(): array
    {
        try {
            $row = Database::instance()->row(
                'SELECT expected_cert_sha256s, expected_cert_sha256 FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
            );
            if ($row === null) {
                return [];
            }
            $digests = [];
            $list = json_decode((string) ($row['expected_cert_sha256s'] ?? '[]'), true);
            if (is_array($list)) {
                foreach ($list as $d) {
                    $d = strtolower(str_replace(':', '', trim((string) $d)));
                    if ($d !== '') {
                        $digests[] = $d;
                    }
                }
            }
            $legacy = strtolower(str_replace(':', '', trim((string) ($row['expected_cert_sha256'] ?? ''))));
            if ($legacy !== '') {
                $digests[] = $legacy;
            }
            return array_values(array_unique($digests));
        } catch (\Throwable) {
            return [];
        }
    }

    /** Decode the integrity token via Google's decodeIntegrityToken API (fail-closed). */
    private static function decodeWithGoogle(string $token, string $packageName): array
    {
        $sa = json_decode(Config::string('GOOGLE_SERVICE_ACCOUNT_JSON', ''), true);
        if (!is_array($sa) || empty($sa['client_email']) || empty($sa['private_key'])) {
            throw new ApiException(503, 'Integrity verification is not configured');
        }

        $accessToken = self::googleAccessToken($sa);
        if ($accessToken === null) {
            throw new ApiException(503, 'Integrity verification unavailable');
        }

        $ch = curl_init(self::GOOGLE_API . "/v1/{$packageName}:decodeIntegrityToken");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode(['integrity_token' => $token]),
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $accessToken,
                'Content-Type: application/json',
            ],
            CURLOPT_TIMEOUT        => 15,
        ]);
        $response = curl_exec($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200 || $response === false) {
            // Google-side outage → fail CLOSED for protected actions.
            throw new ApiException(503, 'Integrity verification unavailable');
        }

        $data = json_decode((string) $response, true);
        $payloadJson = is_array($data) ? ($data['tokenPayloadExternal'] ?? null) : null;
        $payload = is_string($payloadJson) ? json_decode($payloadJson, true) : $payloadJson;
        if (!is_array($payload)) {
            throw new ApiException(403, 'Integrity verification failed');
        }
        return $payload;
    }

    /** Service-account → OAuth2 access token for the Play Integrity API. */
    private static function googleAccessToken(array $sa): ?string
    {
        $b64 = static function (string $d): string {
            return rtrim(strtr(base64_encode($d), '+/', '-_'), '=');
        };
        $now = time();
        $header = $b64(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
        $claims = $b64(json_encode([
            'iss'   => $sa['client_email'],
            'scope' => 'https://www.googleapis.com/auth/playintegrity',
            'aud'   => self::GOOGLE_OAUTH,
            'exp'   => $now + 3600,
            'iat'   => $now,
        ]));
        $signingInput = "{$header}.{$claims}";

        $key = openssl_pkey_get_private($sa['private_key']);
        if ($key === false) {
            return null;
        }
        $signature = '';
        openssl_sign($signingInput, $signature, $key, OPENSSL_ALGO_SHA256);
        openssl_pkey_free($key);
        $jwt = "{$signingInput}." . $b64($signature);

        $ch = curl_init(self::GOOGLE_OAUTH);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => http_build_query([
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion'  => $jwt,
            ]),
            CURLOPT_TIMEOUT        => 10,
        ]);
        $response = curl_exec($ch);
        curl_close($ch);

        $data = json_decode((string) $response, true);
        return is_array($data) ? ($data['access_token'] ?? null) : null;
    }
}
