<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Utils\Uuid;

/**
 * audit_logs writer. Mirrors the PG audit_action enum values used by the
 * RPCs (see schema enums — 100+ actions). The MySQL schema enforces the
 * same values via a CHECK constraint.
 */
final class AuditService
{
    /**
     * @param string $action one of the audit_action values
     * @param array<string,mixed> $details jsonb payload
     */
    public static function write(
        ?string $userId,
        string $action,
        array $details = [],
        ?string $ipAddress = null
    ): void {
        Database::instance()->insert(
            'INSERT INTO audit_logs (id, user_id, action, details, ip_address, created_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $userId, $action, json_encode($details, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $ipAddress]
        );
    }
}
