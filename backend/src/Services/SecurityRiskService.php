<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;

/**
 * SecurityRiskService — server-side device-risk evaluation (Part 3/40).
 *
 * The client's security verdict is NEVER trusted as authorization. This
 * service provides the backend's OWN view of a device's risk, derived from
 * evidence the client has already reported through the authenticated
 * /security/events pipeline (security_events table — the client cannot
 * write to it as an anonymous attacker; rows require a valid session, and
 * admin review UIs already exist for them).
 *
 * What it does:
 *   - Aggregates the most recent high-risk security_events for a user
 *     (frida/xposed/magisk/tamper/root/vpn class events) inside a short
 *     lookback window.
 *   - Compares a configurable threshold.
 *
 * What it deliberately does NOT do:
 *   - It does not block on ANY single client-reported row (a malicious
 *     client can send forged "clean" rows, and a buggy client can send a
 *     false positive). Risk evidence raises the temperature; the operator
 *     decides per protected action whether this gate blocks (enforce) or
 *     only records (log_only).
 *
 * Operator policy (no code change needed to tune):
 *   security_config.extras.client_risk = {
 *     "enabled": false,                 // master switch (default OFF)
 *     "lookback_minutes": 60,
 *     "risk_threshold": 40,
 *     "actions": { "vdo_otp": "log_only", "redeem": "log_only" }
 *   }
 *   The default is OFF/log_only everywhere: zero behavioral change until an
 *   operator flips tiers after reviewing their fleet's event data.
 */
final class SecurityRiskService
{
    /** event_type fragments that count as high-risk evidence. */
    private const HIGH_RISK_TYPES = [
        'frida', 'xposed', 'magisk', 'tamper', 'root', 'vpn',
        'ssl_pinning', 'hooking', 'emulator', 'app_integrity',
    ];

    private ?array $policy = null;

    private function policy(): array
    {
        if ($this->policy !== null) {
            return $this->policy;
        }
        $defaults = [
            'enabled'          => false,
            'lookback_minutes' => 60,
            'risk_threshold'   => 40,
            'actions'          => [],
        ];
        try {
            $row = Database::instance()->row(
                'SELECT extras FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
            );
            $extras = $row !== null ? json_decode((string) $row['extras'], true) : null;
            $cr = is_array($extras) ? ($extras['client_risk'] ?? null) : null;
            $this->policy = is_array($cr) ? array_merge($defaults, $cr) : $defaults;
        } catch (\Throwable) {
            $this->policy = $defaults; // table missing / DB issue → policy OFF
        }
        return $this->policy;
    }

    /**
     * Effective per-action tier: 'log_only' (default) or 'enforce'.
     */
    public function tierFor(string $action): string
    {
        $p = $this->policy();
        $actions = is_array($p['actions'] ?? null) ? $p['actions'] : [];
        $tier = (string) ($actions[$action] ?? 'log_only');
        return $tier === 'enforce' ? 'enforce' : 'log_only';
    }

    /**
     * Server-side risk score for a user inside the lookback window.
     * Sum of risk_score of recent high-risk events, capped at 100.
     */
    public function riskFor(string $userId): int
    {
        $p = $this->policy();
        $minutes = max(1, (int) ($p['lookback_minutes'] ?? 60));
        $types = self::HIGH_RISK_TYPES;
        try {
            $rows = Database::instance()->select(
                'SELECT risk_score, event_type FROM security_events
                  WHERE user_id = ?
                    AND created_at > UTC_TIMESTAMP(6) - INTERVAL ' . $minutes . ' MINUTE
                  ORDER BY created_at DESC
                  LIMIT 200',
                [$userId]
            );
            $sum = 0;
            foreach ($rows ?? [] as $r) {
                $t = strtolower((string) $r['event_type']);
                foreach ($types as $frag) {
                    if (str_contains($t, $frag)) {
                        $sum += max(0, (int) $r['risk_score']);
                        break;
                    }
                }
                if ($sum >= 100) {
                    break;
                }
            }
            return min(100, $sum);
        } catch (\Throwable) {
            return 0; // evidence unavailable → no risk contribution
        }
    }

    /**
     * Gate for protected actions. Throws 403 only when the operator has set
     * the action's tier to "enforce" AND the aggregated risk breaches the
     * threshold. Always returns the computed risk for logging callers.
     *
     * @return array{risk:int, tier:string, blocked:bool}
     */
    public function assertRiskAllowed(string $userId, string $action): array
    {
        $p = $this->policy();
        $tier = $this->tierFor($action);
        if (!$p['enabled'] || $tier !== 'enforce') {
            return ['risk' => 0, 'tier' => 'log_only', 'blocked' => false];
        }
        $risk = $this->riskFor($userId);
        $threshold = (int) ($p['risk_threshold'] ?? 40);
        $blocked = $risk >= $threshold;
        if ($blocked) {
            throw new \MedAcademy\Http\ApiException(
                403,
                'This action is temporarily unavailable on your device. Contact support if you believe this is an error.'
            );
        }
        return ['risk' => $risk, 'tier' => 'enforce', 'blocked' => false];
    }
}
