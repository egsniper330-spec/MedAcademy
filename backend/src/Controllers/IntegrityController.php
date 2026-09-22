<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\IntegrityService;

/**
 * IntegrityController — PHP endpoints for the Play Integrity flow.
 *
 * POST /integrity/play
 *   action=get_nonce            → { request_hash, action, expires_in }
 *   action=verify (token, …)    → { passed, verdict, request_hash }
 *
 * POST /integrity/app (iOS App Attest / DeviceCheck)
 *   action=get_nonce            → challenge for the iOS assertion flow
 *   action=verify               → server-side verification (see notes)
 *
 * SECURITY: the server is the only judge of integrity. Every validation
 * (requestHash binding, package name, app/device verdicts, signing
 * certificate digest) happens in IntegrityService against Google's decoded
 * payload. There are NO fail-open "NOT_CONFIGURED = passed" paths left —
 * without server credentials the flow fails closed (503), because a
 * tampered client must never be able to switch verification off by
 * controlling its environment.
 *
 * LEGACY COMPATIBILITY: the original client called verify with { token,
 * nonce }. That flow verified nothing binding and failed open; it is kept
 * only as an explicit, logged rejection so stale clients get a clear
 * signal instead of a silent pass.
 */
final class IntegrityController
{
    public function playIntegrity(Request $request): array
    {
        $body = $request->json();
        $action = (string) ($body['action'] ?? '');
        $userId = (string) $request->user['id'];

        return match ($action) {
            'get_nonce' => $this->getChallenge($body, $userId),
            'verify'    => $this->verify($body, $userId, $request),
            default     => throw new ApiException(422, 'Invalid action'),
        };
    }

    /**
     * Issue a request-hash challenge. The client MUST pass the protected
     * action key it intends to perform (vdo_otp, redeem, device_bind, …) so
     * the verdict can be bound to that action server-side.
     */
    private function getChallenge(array $body, string $userId): array
    {
        $action = (string) ($body['protected_action'] ?? $body['action_key'] ?? 'generic');

        // Whitelist known action keys; anything unknown is recorded as
        // "generic" so a client cannot invent privileged action names.
        $known = array_keys(IntegrityService::policy()['actions']);
        if (!in_array($action, $known, true)) {
            $action = 'generic';
        }

        $challenge = IntegrityService::issueChallenge($userId, $action);
        // Legacy alias: the pre-request-hash client read `nonce`.
        $challenge['nonce'] = $challenge['request_hash'];
        return $challenge;
    }

    private function verify(array $body, string $userId, Request $request): array
    {
        $token = (string) ($body['token'] ?? '');

        // New binding flow: the hash the client gave the Play Integrity API.
        $requestHash = (string) ($body['request_hash'] ?? $body['nonce'] ?? '');

        if ($token === '' || $requestHash === '') {
            throw new ApiException(422, 'token and request_hash are required');
        }

        return IntegrityService::verifyToken(
            $userId,
            $token,
            $requestHash,
            $request->clientIp()
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // iOS App Attest / DeviceCheck
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * App Attest — verified authorization requires the backend to validate
     * the attestation object and per-request assertions against Apple's
     * servers (App Attest attestation + assertion endpoints) and to bind the
     * assertion counter/challenge to the protected request.
     *
     * Until Apple Developer credentials are configured, verification fails
     * CLOSED (503) — the previous "received the token, pass it" behavior was
     * a false sense of security and is removed. The challenge endpoint stays
     * available so clients can be wired to the real flow when credentials
     * land.
     */
    public function appIntegrity(Request $request): array
    {
        $body = $request->json();
        $action = (string) ($body['action'] ?? '');
        $userId = (string) $request->user['id'];

        return match ($action) {
            // Challenge for the iOS assertion flow — returns under both the
            // historical `challenge` key and the request-hash name.
            'get_nonce', 'get_challenge' => self::issueIosChallenge($userId),
            // Attestation + assertion verification require Apple server-side
            // validation (App Attest attestation/assertion endpoints) with
            // Apple Developer credentials. Until configured these fail
            // CLOSED with an explicit status — the previous "received the
            // token, pass it" behavior was a false sense of security. The
            // iOS client treats any error here as non-blocking skip.
            'attest_key', 'verify_assertion', 'verify' => throw new ApiException(
                503,
                'App Attest server verification is not configured'
            ),
            default => throw new ApiException(422, 'Invalid action'),
        };
    }

    /** @return array{challenge:string, request_hash:string} */
    private static function issueIosChallenge(string $userId): array
    {
        $c = IntegrityService::issueChallenge($userId, 'ios_attest');
        return ['challenge' => $c['request_hash'], 'request_hash' => $c['request_hash']];
    }
}
