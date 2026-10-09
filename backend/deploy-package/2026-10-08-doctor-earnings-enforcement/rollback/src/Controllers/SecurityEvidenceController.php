<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\SecurityEvidenceService;

/**
 * SecurityEvidenceController — device-key + challenge + signed-evidence flow.
 *
 * POST /security/device-key            → register/rotate this device's Keystore
 *                                        PUBLIC key (bootstrap; private key never
 *                                        leaves the device).
 * POST /security/challenge             → single-use challenge bound to
 *                                        (user, device, session, action, request_hash).
 * POST /security/evidence              → verify signature + bindings + counter;
 *                                        persist the assurance decision and return
 *                                        { evidence_id, assurance, passed }.
 * POST /security/device-keys/{id}/revoke → admin revocation (server-side state).
 *
 * The client NEVER chooses the challenge, NEVER controls the assurance verdict,
 * and can never authorize action B with a challenge issued for action A. Every
 * binding is stored server-side (security_challenges) and verified here.
 *
 * NOTE: this is device-key possession evidence, NOT platform attestation. It
 * composes with /integrity/play (Play Integrity, migration 017), which remains
 * the APK-genuineness layer.
 */
final class SecurityEvidenceController
{
    public function registerKey(Request $request): array
    {
        $userId = (string) $request->user['id'];
        $body = $request->json();

        // A device key is bound to the SERVER's device record: the fingerprint
        // must belong to an existing device of this user. Bootstrap order is
        // login (device row created) → key registration.
        $fingerprint = trim((string) ($body['device_fingerprint'] ?? ''));
        $device = Database::instance()->row(
            'SELECT id FROM devices WHERE user_id = ? AND device_fingerprint = ? LIMIT 1',
            [$userId, $fingerprint]
        );
        if ($device === null) {
            throw new ApiException(403, 'Device not registered');
        }

        // Server-derived device_id takes precedence over anything client-supplied.
        $result = SecurityEvidenceService::registerDeviceKey(
            $userId,
            ['device_id' => (string) $device['id']] + $body
        );

        return [
            'success' => true,
            'key_id' => $result['key_id'],
            'status' => $result['status'],
            'rotated' => $result['rotated'],
        ];
    }

    public function challenge(Request $request): array
    {
        $userId = (string) $request->user['id'];
        $body = $request->json();

        return SecurityEvidenceService::issueChallenge(
            $userId,
            (string) ($body['action'] ?? ''),
            (string) ($body['device_fingerprint'] ?? ''),
            isset($request->user['device_id']) ? (string) $request->user['device_id'] : null,
            (string) ($body['request_hash'] ?? '')
        );
    }

    public function submit(Request $request): array
    {
        $userId = (string) $request->user['id'];
        $body = $request->json();

        $payload = is_array($body['payload'] ?? null) ? $body['payload'] : null;
        $signature = (string) ($body['signature'] ?? '');
        if ($payload === null || $signature === '') {
            throw new ApiException(422, 'payload and signature are required');
        }

        $sessionId = isset($request->user['device_id']) ? (string) $request->user['device_id'] : '';

        $decision = SecurityEvidenceService::verifyEvidence(
            $userId,
            $sessionId,
            $payload,
            $signature,
            $request->clientIp()
        );

        // HTTP contract: a rejected verification is still a 200 with
        // passed=false — the CLIENT chooses nothing here, and enforcement is
        // performed by the protected endpoint consulting the decision row.
        // (A 4xx would only tell a tamperer exactly which check to study.)
        return [
            'passed' => $decision['passed'],
            'evidence_id' => $decision['evidence_id'],
            'assurance' => $decision['assurance'],
        ];
    }

    public function revokeKey(Request $request): array
    {
        $keyRowId = (string) ($request->params['id'] ?? '');
        if ($keyRowId === '') {
            throw new ApiException(422, 'Missing device key id');
        }
        $actorId = (string) $request->user['id'];

        $key = Database::instance()->row('SELECT id, user_id FROM device_keys WHERE id = ? LIMIT 1', [$keyRowId]);
        if ($key === null) {
            throw new ApiException(404, 'Device key not found');
        }

        // Admins may revoke any key; users may revoke only their own.
        $role = (string) $request->user['role'];
        if (!in_array($role, ['admin', 'super_admin'], true) && (string) $key['user_id'] !== $actorId) {
            throw new ApiException(403, 'Forbidden');
        }

        SecurityEvidenceService::revokeDeviceKey($keyRowId, $actorId, (string) ($request->json()['reason'] ?? 'revoked'));

        return ['success' => true];
    }
}
