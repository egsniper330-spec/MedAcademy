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

    /**
     * Maximum accepted age of the Google-signed token, in milliseconds.
     * Google mints the token at request time and the client forwards it within
     * seconds; 10 minutes is generous for a slow mobile connection while still
     * bounding how long a minted token can be held before it is presented.
     */
    private const MAX_TOKEN_AGE_MS = 600_000;

    /** Tolerated clock skew for a token that looks "from the future". */
    private const MAX_CLOCK_SKEW_MS = 60_000;

    /** Service-account access-token cache (OAuth tokens live ~1h). */
    private static ?array $accessTokenCache = null;

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
     *               device_verdicts:string[], require_device_integrity:bool,
     *               require_cert_match:bool, require_licensed:bool, verdict_ttl:int}
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
                'vdo_otp'       => 'log_only',
                'redeem'        => 'log_only',
                'device_bind'   => 'log_only',
                'financial'     => 'log_only',
                // Personalised lesson-PDF issuance: minting a copy is a
                // high-value operation (it is the only path that can emit a
                // student-identifiable document), so it is covered by the same
                // tiered policy as playback. Default log_only, as everywhere.
                'material_pdf'  => 'log_only',
            ], is_array($pi['actions'] ?? null) ? array_map('strval', $pi['actions']) : []),
            'app_verdicts'            => array_values(array_map('strval', $pi['app_verdicts'] ?? ['PLAY_RECOGNIZED'])),
            // Device verdict labels that satisfy the policy. MEETS_BASIC_INTEGRITY
            // is accepted by default so certified-but-out-of-date devices are not
            // locked out; an operator can narrow this to MEETS_DEVICE_INTEGRITY
            // (or STRONG) once telemetry shows the real distribution.
            'device_verdicts'         => array_values(array_map('strval', $pi['device_verdicts'] ?? [
                'MEETS_DEVICE_INTEGRITY',
                'MEETS_BASIC_INTEGRITY',
            ])),
            'require_device_integrity' => (bool) ($pi['require_device_integrity'] ?? true),
            'require_cert_match'      => (bool) ($pi['require_cert_match'] ?? true),
            // Licensing is OFF by default: this app is distributed through
            // Google Play AND direct install, so UNLICENSED is a legitimate
            // state here. Operators that gate on Play entitlement opt in.
            'require_licensed'        => (bool) ($pi['require_licensed'] ?? false),
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
            self::reject($userId, $ip, 'package_mismatch');
        }

        // 4. requestHash — token must cover THIS challenge (anti-replay).
        if (!hash_equals($requestHash, (string) ($details['requestHash'] ?? ''))) {
            self::reject($userId, $ip, 'request_hash_mismatch');
        }

        // 4b. FRESHNESS — the decoded payload must be recent. The single-use
        //     challenge already bounds the window, but the timestamp is the
        //     only field that proves WHEN Google minted the token, so a token
        //     minted at challenge time cannot be carried around until the TTL
        //     boundary. A missing/garbage timestamp fails closed.
        if (!self::tokenIsFresh($details)) {
            self::reject($userId, $ip, 'stale_or_undated_token');
        }

        // 5. App recognition + signing certificate (tampered/re-signed APK
        //    detection — the digest is reported BY GOOGLE, never by us).
        $appVerdict = (string) ($appInt['appRecognitionVerdict'] ?? '');
        if (!in_array($appVerdict, $policy['app_verdicts'], true)) {
            self::reject($userId, $ip, 'app_not_recognized:' . $appVerdict);
        }

        // 5a. certificateSha256Digest is BASE64URL in Google's payload; the
        //     pinned values in security_config are HEX. Normalise both sides
        //     (see normalizeCertDigest) — comparing the encodings directly is
        //     how a pinned cert silently rejected every genuine client.
        $cert = '';
        $certs = $appInt['certificateSha256Digest'] ?? [];
        if (is_string($certs)) {
            $certs = [$certs];
        }
        if (is_array($certs) && $certs !== []) {
            $cert = self::normalizeCertDigest((string) $certs[0]);
        }
        if ($policy['require_cert_match']) {
            $expected = self::expectedCertDigests();
            if ($expected !== [] && ($cert === '' || !in_array($cert, $expected, true))) {
                // A re-signed APK presents a different certificate digest —
                // exactly the signal the smali-tamper test exercised.
                self::reject($userId, $ip, 'certificate_mismatch');
            }
        }

        // 6. Device integrity (policy-tunable; the accepted labels live in
        //    policy.device_verdicts so operators can narrow them without a
        //    release).
        $device = is_array($devInt['deviceRecognitionVerdict'] ?? null)
            ? $devInt['deviceRecognitionVerdict']
            : [];
        if ($policy['require_device_integrity']) {
            if (array_intersect($policy['device_verdicts'], array_map('strval', $device)) === []) {
                self::reject($userId, $ip, 'device_verdict:' . implode(',', array_map('strval', $device)));
            }
        }

        // 6b. Play licensing entitlement — only when the operator opts in.
        //     PLACEHOLDER: this app also ships outside Google Play, so an
        //     UNLICENSED install is a legitimate state and must not be blocked
        //     by default.
        if ($policy['require_licensed']) {
            $acct = is_array($payload['accountDetails'] ?? null) ? $payload['accountDetails'] : [];
            if ((string) ($acct['appLicensingVerdict'] ?? '') !== 'LICENSED') {
                self::reject($userId, $ip, 'not_licensed');
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
                    implode(',', array_map('strval', $device)),
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

    /**
     * Record why verification failed, then throw the same 403 the caller would
     * have received. The client never learns more than "failed"; the operator
     * learns WHICH check failed, which is what makes staged rollout and
     * false-positive analysis possible without touching client code.
     */
    private static function reject(string $userId, string $ip, string $reason): void
    {
        try {
            (new SecurityService())->logEvent($userId, [
                'event_type'       => 'play_integrity_failed',
                'detection_method' => 'Play Integrity rejected server-side: ' . $reason,
                'policy_action'    => 'log_only',
                'risk_score'       => 40,
                'platform'         => 'android',
                'ip_address'       => $ip,
            ]);
        } catch (\Throwable) {
            // Telemetry must never change the outcome.
        }
        throw new ApiException(403, 'Integrity verification failed');
    }

    /**
     * The decoded token must carry a recent request timestamp.
     *
     * Google reports it as a STRING of epoch milliseconds. Absent, non-numeric
     * or out-of-window values are all failures: "we could not establish when
     * this was minted" is not a pass.
     */
    private static function tokenIsFresh(array $details): bool
    {
        $raw = $details['timestampMillis'] ?? null;
        if (!is_int($raw) && !is_string($raw)) {
            return false;
        }
        if (!is_numeric((string) $raw)) {
            return false;
        }
        $issuedMs = (int) $raw;
        $nowMs = (int) round(microtime(true) * 1000);
        $ageMs = $nowMs - $issuedMs;
        return $ageMs <= self::MAX_TOKEN_AGE_MS && $ageMs >= -self::MAX_CLOCK_SKEW_MS;
    }

    /**
     * Normalise a SHA-256 signing-certificate digest to lowercase hex.
     *
     * WHY: Play Integrity returns appIntegrity.certificateSha256Digest as
     * BASE64URL (43–44 chars), while security_config.expected_cert_sha256s
     * stores 64-character HEX. The previous comparison ran the base64url value
     * through a hex-shaped normaliser, so it could never equal a pinned hex
     * fingerprint: with a pin configured every genuine client was rejected, and
     * with no pin the check was a no-op. Accepting both encodings removes that
     * failure mode from the deployment.
     */
    public static function normalizeCertDigest(string $raw): string
    {
        $value = str_replace(':', '', trim($raw));
        if ($value === '') {
            return '';
        }
        if (preg_match('/^[0-9A-Fa-f]{64}$/', $value) === 1) {
            return strtolower($value);
        }
        $b64 = strtr($value, '-_', '+/');
        $remainder = strlen($b64) % 4;
        if ($remainder > 0) {
            $b64 .= str_repeat('=', 4 - $remainder);
        }
        $bin = base64_decode($b64, true);
        if ($bin !== false && strlen($bin) === 32) {
            return bin2hex($bin);
        }
        return '';
    }

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
                    // Accept a hex fingerprint OR a base64url digest in config:
                    // both normalise to the same lowercase hex here.
                    $d = self::normalizeCertDigest((string) $d);
                    if ($d !== '') {
                        $digests[] = $d;
                    }
                }
            }
            $legacy = self::normalizeCertDigest((string) ($row['expected_cert_sha256'] ?? ''));
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
            // Fail CLOSED either way, but distinguish the two operational cases:
            //   429/5xx/transport → Google-side transient (retryable, monitors
            //   the quota), 4xx → our request or this token is invalid
            //   (permanent, never retryable without a fresh token).
            $transient = $httpCode === 0 || $httpCode === 429 || $httpCode >= 500;
            error_log(sprintf(
                '[medacademy] play integrity decode failed http=%d transient=%s',
                $httpCode,
                $transient ? 'yes' : 'no'
            ));
            throw new ApiException(
                503,
                $transient ? 'Integrity verification unavailable' : 'Integrity verification failed'
            );
        }

        $data = json_decode((string) $response, true);
        $payloadJson = is_array($data) ? ($data['tokenPayloadExternal'] ?? null) : null;
        $payload = is_string($payloadJson) ? json_decode($payloadJson, true) : $payloadJson;
        if (!is_array($payload)) {
            throw new ApiException(403, 'Integrity verification failed');
        }
        return $payload;
    }

    /**
     * Service-account → OAuth2 access token for the Play Integrity API.
     *
     * Cached in-process until shortly before expiry (~55 min): every protected
     * operation used to mint a fresh JWT and spend a second OAuth round-trip, so
     * a burst of PDF downloads multiplied Google's token endpoint traffic and
     * our latency for no security benefit. A token is not a verdict — the
     * per-request authority is still the decoded Play Integrity payload.
     */
    private static function googleAccessToken(array $sa): ?string
    {
        $cacheKey = (string) ($sa['client_email'] ?? '') . '|' . (string) ($sa['private_key_id'] ?? '');
        $cached = self::$accessTokenCache;
        if (is_array($cached) && ($cached['key'] ?? '') === $cacheKey && (int) ($cached['expires_at'] ?? 0) > time()) {
            return (string) $cached['token'];
        }

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
        $token = is_array($data) ? ($data['access_token'] ?? null) : null;
        if (!is_string($token) || $token === '') {
            return null;
        }
        $ttl = is_array($data) && isset($data['expires_in']) ? (int) $data['expires_in'] : 3600;
        self::$accessTokenCache = [
            'key'        => $cacheKey,
            'token'      => $token,
            // 60s safety margin; never cache a token for longer than it lives.
            'expires_at' => time() + max(60, $ttl - 60),
        ];
        return $token;
    }
}
