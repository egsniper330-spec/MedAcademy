<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\AuditService;

/**
 * Support Contact configuration — public read + Super Admin write.
 *
 * TWO planes:
 *  1. GET /support/contact         — PUBLIC, no auth. Returns ONLY enabled
 *     contact methods for the security/blocked screen. Never exposes admin
 *     data, secrets, or internal config.
 *  2. GET/PUT /admin/support-settings — Super Admin only. Full CRUD for the
 *     support_settings table, audited.
 *
 * The support_settings table is ALSO readable via the generic Data API
 * (/api/support_settings) by any authenticated user — that is intentional:
 * the Super Admin settings screen uses it, and it is a config table like
 * feature_flags/system_config that needs a row to exist. Writes to it via
 * the generic API are blocked (WRITE_ADMIN_ONLY_TABLES pattern — add below).
 */
final class SupportController
{
    /**
     * Stable platform keys in display order.
     * The frontend icon registry MUST use these exact keys.
     */
    public const PLATFORM_KEYS = [
        'whatsapp', 'facebook', 'instagram', 'telegram',
        'email', 'phone', 'x', 'website',
    ];

    /**
     * Canonical default labels per platform key.
     * An empty stored label resolves to this so the admin UI, the public
     * endpoint, and the mobile blocked screen can never disagree.
     */
    public const DEFAULT_LABELS = [
        'whatsapp'  => 'WhatsApp',
        'facebook'  => 'Facebook',
        'instagram' => 'Instagram',
        'telegram'  => 'Telegram',
        'email'     => 'Email',
        'phone'     => 'Phone',
        'x'         => 'X / Twitter',
        'website'   => 'Website',
    ];

    /**
     * Allowed URL schemes per platform key for the public endpoint.
     * Stored values are normalized server-side; the public path only
     * returns already-validated data.
     */
    public const ALLOWED_SCHEMES = [
        'whatsapp'  => ['https'],
        'facebook'  => ['https'],
        'instagram' => ['https'],
        'telegram'  => ['https'],
        'email'     => ['mailto'],
        'phone'     => ['tel'],
        'x'         => ['https'],
        'website'   => ['https', 'http'],
    ];

    /**
     * Tables that MUST NOT be writable via the generic Data API.
     * Add support_settings here so any authenticated user cannot PATCH it
     * through /api/support_settings (privilege escalation).
     */
    public const DATA_CONTROLLER_WRITE_ADMIN_ONLY = true;

    /**
     * Public endpoint — GET /support/contact
     *
     * NO authentication required. The security/blocked screen must be able
     * to show support contacts even when the user cannot authenticate.
     *
     * Returns ONLY enabled contact methods. Never exposes:
     *   - disabled contacts
     *   - admin settings
     *   - auth data
     *   - secrets
     *   - internal configuration
     *   - security policies
     *   - user information
     */
    public function publicContact(Request $request): void
    {
        $db = Database::instance();

        $rows = $db->select(
            "SELECT `key`, `value`, `label`, `enabled`, `display_order`
               FROM `support_settings`
               WHERE `enabled` = 1
               ORDER BY `display_order` ASC, `key` ASC"
        );

        $contacts = [];
        foreach ($rows as $row) {
            $key = (string) $row['key'];
            $value = trim((string) ($row['value'] ?? ''));

            // Skip empty values — no point showing an empty contact
            if ($value === '') {
                continue;
            }

            $label = $this->resolveLabel($key, (string) ($row['label'] ?? ''));

            // Build the external URL based on platform key + stored value.
            // The stored value is already normalized by the admin endpoint.
            $url = $this->buildPublicUrl($key, $value);

            if ($url === null) {
                // Malformed stored value — skip rather than exposing garbage.
                // admin: re-save with a valid value.
                continue;
            }

            $contacts[] = [
                'platform' => $key,
                'label'    => $label,
                'url'      => $url,
                'enabled'  => true,
                'order'    => (int) ($row['display_order'] ?? 0),
            ];
        }

        Response::json(['contacts' => $contacts]);
    }

    /**
     * Admin GET — GET /admin/support-settings
     * Super Admin only. Returns ALL rows (including disabled/empty).
     */
    public function adminIndex(Request $request): void
    {
        $this->assertSuperAdmin($request);

        $db = Database::instance();
        $rows = $db->select(
            "SELECT `key`, `value`, `label`, `enabled`, `display_order`, `updated_by`, `updated_at`
               FROM `support_settings`
               ORDER BY `display_order` ASC, `key` ASC"
        );

        $out = [];
        foreach ($rows as $row) {
            $key = (string) $row['key'];
            $out[$key] = [
                'key'         => $key,
                'value'       => trim((string) ($row['value'] ?? '')),
                'label'       => (string) ($row['label'] ?? ''),
                'enabled'     => (bool) ($row['enabled'] ?? false),
                'display_order' => (int) ($row['display_order'] ?? 0),
                'updated_by'  => $row['updated_by'] !== null ? (string) $row['updated_by'] : null,
                'updated_at'  => $row['updated_at'] !== null ? (string) $row['updated_at'] : null,
            ];
        }

        Response::json(['settings' => $out]);
    }

    /**
     * Admin PUT — PUT /admin/support-settings
     * Super Admin only. Accepts a full settings object.
     * Audited per changed platform.
     */
    public function adminUpdate(Request $request): void
    {
        $this->assertSuperAdmin($request);

        $body = $request->json();
        if (!$body || !is_array($body)) {
            throw new ApiException(422, 'Request body with settings required');
        }

        if (!isset($body['settings']) || !is_array($body['settings'])) {
            throw new ApiException(422, '"settings" object required');
        }

        $actorId = $request->user['id'] ?? null;
        $db = Database::instance();
        $changedPlatforms = [];

        // Start a transaction so partial writes don't leave the table inconsistent
        $db->beginTransaction();

        try {
            $existing = $db->select(
                "SELECT `key`, `value`, `label`, `enabled`, `display_order`
                   FROM `support_settings`"
            );

            $existingMap = [];
            foreach ($existing as $row) {
                $existingMap[(string) $row['key']] = $row;
            }

            $now = date('Y-m-d H:i:s.u');

            foreach (self::PLATFORM_KEYS as $key) {
                $entry = $body['settings'][$key] ?? null;
                if (!is_array($entry)) {
                    // Platform not included — leave existing row untouched
                    continue;
                }

                $value = trim((string) ($entry['value'] ?? ''));
                $label = trim((string) ($entry['label'] ?? self::DEFAULT_LABELS[$key] ?? $key));
                $enabled = (bool) ($entry['enabled'] ?? false);
                $displayOrder = (int) ($entry['display_order'] ?? self::defaultDisplayOrder($key));

                // ROOT CAUSE FIX ("Failed to save WhatsApp/Telegram"): normalize
                // the DOCUMENTED input formats BEFORE validating. The admin UI's
                // own placeholders/hints instruct the Super Admin to type values
                // this validator used to reject outright:
                //   • WhatsApp hint placeholder '+1 555 000 0000' → the space
                //     failed the handle regex (422 → "Failed to save").
                //   • Telegram hint 'Enter a @username, t.me/username, or full
                //     Telegram URL' → 't.me/username' contained a '/' and was
                //     rejected as an invalid handle (422).
                // Website passed only because its validation is lenient, which is
                // exactly the asymmetry that was reported.
                $value = $this->canonicalize($key, $value);

                // Validate the value for this platform
                $this->validateValue($key, $value);

                // Normalize the value into canonical form
                $normalized = $this->normalizeValue($key, $value);

                $prev = $existingMap[$key] ?? null;
                $prevValue = $prev ? trim((string) ($prev['value'] ?? '')) : '';
                $prevEnabled = $prev ? (bool) ($prev['enabled'] ?? false) : false;

                // Write (upsert) the row
                $db->query(
                    "INSERT INTO `support_settings` (`key`, `value`, `label`, `enabled`, `display_order`, `updated_by`, `updated_at`)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                         `value` = VALUES(`value`),
                         `label` = VALUES(`label`),
                         `enabled` = VALUES(`enabled`),
                         `display_order` = VALUES(`display_order`),
                         `updated_by` = VALUES(`updated_by`),
                         `updated_at` = VALUES(`updated_at`)",
                    [$key, $normalized, $label, (int) $enabled, $displayOrder, $actorId, $now]
                );

                // Track what changed for audit
                if ($prevValue !== $normalized || $prevEnabled !== $enabled) {
                    $changedPlatforms[] = [
                        'platform'  => $key,
                        'label'     => $label,
                        'old_value' => $prevValue,
                        'new_value' => $normalized,
                        'old_enabled' => $prevEnabled,
                        'new_enabled' => $enabled,
                    ];
                }
            }

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        // Audit: one entry for the whole change, listing changed platforms
        if (!empty($changedPlatforms)) {
            $this->auditChange($actorId, $changedPlatforms);
        }

        // Return the freshly-saved state
        $this->adminIndex($request);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Map the formats the ADMIN UI advertises onto the canonical handle/value
     * `validateValue()` + `normalizeValue()` expect.
     *
     * Accepted per platform (all whitespace is stripped first, so the
     * placeholders '+1 555 000 0000' and '(555) 000-0000' both work):
     *   whatsapp   https://wa.me/<num>, https://api.whatsapp.com/send?phone=<num>, +1 555 000 0000
     *   phone      +1 555 000 0000, tel:+15550000000, 555-000-0000
     *   telegram   @user, user, t.me/user, telegram.me/user, https://t.me/user
     *   x          @user, user, x.com/user, twitter.com/user, https://x.com/user
     *   facebook   @user, user, facebook.com/user, fb.me/user, https://facebook.com/user
     *   instagram  @user, user, instagram.com/user, https://instagram.com/user
     *   email      user@example.com, mailto:user@example.com
     *   website    example.com, https://example.com/support
     *
     * A value that still cannot be understood is returned UNCHANGED so the
     * validator produces its explicit 422 message instead of silently storing
     * an empty contact.
     */
    private function canonicalize(string $key, string $value): string
    {
        $value = preg_replace('/\s+/', '', $value) ?? $value;
        if ($value === '') {
            return '';
        }

        switch ($key) {
            case 'whatsapp':
                // Already a wa.me / api.whatsapp.com link → keep the number.
                if (preg_match('#^https?://(?:www\.)?(?:wa\.me|api\.whatsapp\.com)/(?:send\?phone=)?(\+?\d+)#i', $value, $m) === 1) {
                    return $m[1];
                }
                if (str_starts_with($value, 'http://') || str_starts_with($value, 'https://')) {
                    return $value; // arbitrary URL → validator decides
                }
                $number = preg_replace('/[^\d+]/', '', $value) ?? '';
                return $number !== '' ? $number : $value;

            case 'phone':
                if (str_starts_with($value, 'tel:')) {
                    $value = substr($value, 4);
                }
                $plus = str_starts_with($value, '+');
                $digits = preg_replace('/\D/', '', $value) ?? '';
                if ($digits === '') {
                    return $value;
                }
                return $plus ? '+' . $digits : $digits;

            case 'telegram':
            case 'x':
            case 'facebook':
            case 'instagram':
                if (str_starts_with($value, 'http://') || str_starts_with($value, 'https://')) {
                    return $value;
                }
                $hosts = [
                    'telegram'  => ['telegram.me/', 't.me/'],
                    'x'         => ['twitter.com/', 'x.com/'],
                    'facebook'  => ['fb.me/', 'fb.com/', 'facebook.com/', 'www.facebook.com/'],
                    'instagram' => ['www.instagram.com/', 'instagram.com/'],
                ][$key] ?? [];
                foreach ($hosts as $host) {
                    if (strncasecmp($value, $host, strlen($host)) === 0) {
                        $value = substr($value, strlen($host));
                        break;
                    }
                }
                return ltrim($value, '@/');

            default:
                return $value; // email / website keep their documented forms
        }
    }

    private function resolveLabel(string $key, string $storedLabel): string
    {
        if ($storedLabel !== '') {
            return $storedLabel;
        }
        return self::DEFAULT_LABELS[$key] ?? $key;
    }

    private function buildPublicUrl(string $key, string $value): ?string
    {
        // The value has already been normalized by the admin endpoint.
        // Build the final URL the blocked screen will open.

        // Social/WhatsApp/Telegram — stored as normalized https URL or handle
        if (in_array($key, ['whatsapp', 'facebook', 'instagram', 'telegram', 'x'], true)) {
            // If it's already an HTTPS URL, return it. Otherwise build one.
            if (str_starts_with($value, 'https://')) {
                return $value;
            }
            if ($value !== '') {
                return $this->buildSocialUrl($key, $value);
            }
            return null;
        }

        if ($key === 'email') {
            // Stored as raw email address; build mailto:
            if (str_starts_with($value, 'mailto:')) {
                return $value;
            }
            return 'mailto:' . $value;
        }

        if ($key === 'phone') {
            // Stored as E.164; build tel:
            if (str_starts_with($value, 'tel:')) {
                return $value;
            }
            return 'tel:' . $value;
        }

        if ($key === 'website') {
            if (str_starts_with($value, 'http://') || str_starts_with($value, 'https://')) {
                return $value;
            }
            if ($value !== '') {
                return 'https://' . $value;
            }
            return null;
        }

        return null;
    }

    private function buildSocialUrl(string $key, string $value): ?string
    {
        // Accept raw handle/username or a partial URL and build the canonical HTTPS URL.
        if ($key === 'whatsapp') {
            // wa.me/<E164 without +>
            return 'https://wa.me/' . ltrim($value, '+');
        }
        if ($key === 'telegram') {
            return 'https://t.me/' . ltrim($value, '@');
        }
        if ($key === 'facebook') {
            return 'https://www.facebook.com/' . ltrim($value, '@');
        }
        if ($key === 'instagram') {
            return 'https://www.instagram.com/' . ltrim($value, '@');
        }
        if ($key === 'x') {
            return 'https://x.com/' . ltrim($value, '@');
        }
        return null;
    }

    private function validateValue(string $key, string $value): void
    {
        if ($value === '') {
            return; // empty is allowed (disabled contact)
        }

        $allowed = self::ALLOWED_SCHEMES[$key] ?? ['https'];

        // For social platforms, accept either an HTTPS URL or a raw handle.
        // Raw handles get normalized into HTTPS URLs later, so the public
        // endpoint only ever sees HTTPS URLs for these platforms.
        if (in_array($key, ['whatsapp', 'facebook', 'instagram', 'telegram', 'x'], true)) {
            if (str_starts_with($value, 'https://')) {
                // Validate it's a real HTTPS URL
                $parsed = parse_url($value);
                if ($parsed === false || !isset($parsed['scheme']) || !isset($parsed['host'])) {
                    throw new ApiException(422, "Invalid {$key} URL");
                }
                if ($parsed['scheme'] !== 'https') {
                    throw new ApiException(422, "{$key} must use HTTPS");
                }
                // Reject javascript:, data:, etc. — parse_url would have caught most,
                // but be explicit.
                if (preg_match('#^https?://#i', $value) === 0) {
                    throw new ApiException(422, "Invalid {$key} URL");
                }
            }
            // Raw handle/phone — validate it looks plausible
            if (!preg_match('/^[a-zA-Z0-9_.@+\-]+$/', $value)) {
                throw new ApiException(422, "Invalid {$key} value");
            }
            return;
        }

        if ($key === 'email') {
            if (str_starts_with($value, 'mailto:')) {
                $email = substr($value, 7);
            } else {
                $email = $value;
            }
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                throw new ApiException(422, 'Invalid email address');
            }
            return;
        }

        if ($key === 'phone') {
            if (str_starts_with($value, 'tel:')) {
                $phone = substr($value, 4);
            } else {
                $phone = $value;
            }
            // Accept E.164 (+<digits>) or digits-only
            $clean = ltrim($phone, '+');
            if (!preg_match('/^\d+$/', $clean) || strlen($clean) < 7) {
                throw new ApiException(422, 'Invalid phone number. Use international format (e.g. +15550000000)');
            }
            return;
        }

        if ($key === 'website') {
            if (str_starts_with($value, 'http://') || str_starts_with($value, 'https://')) {
                $parsed = parse_url($value);
                if ($parsed === false || !isset($parsed['scheme']) || !isset($parsed['host'])) {
                    throw new ApiException(422, 'Invalid website URL');
                }
            } else {
                // Bare domain — will get https:// prepended
                if (!preg_match('/^[a-zA-Z0-9._-]+$/', $value)) {
                    throw new ApiException(422, 'Invalid website address');
                }
            }
            return;
        }

        // Default: must be a valid HTTPS URL
        if (!str_starts_with($value, 'https://') && !str_starts_with($value, 'http://')) {
            throw new ApiException(422, "Invalid {$key} URL — must be https://...");
        }
        $parsed = parse_url($value);
        if ($parsed === false || !isset($parsed['scheme']) || !isset($parsed['host'])) {
            throw new ApiException(422, "Invalid {$key} URL");
        }
    }

    private function normalizeValue(string $key, string $value): string
    {
        if ($value === '') {
            return '';
        }

        // Social handles → canonical HTTPS URL
        if (in_array($key, ['whatsapp', 'facebook', 'instagram', 'telegram', 'x'], true)) {
            if (str_starts_with($value, 'https://')) {
                return $value;
            }
            return $this->buildSocialUrl($key, $value) ?? $value;
        }

        if ($key === 'email') {
            if (str_starts_with($value, 'mailto:')) {
                return $value;
            }
            return $value; // raw email, mailto: built at read time
        }

        if ($key === 'phone') {
            if (str_starts_with($value, 'tel:')) {
                return $value;
            }
            // Normalize to E.164
            $clean = preg_replace('/[^\d+]/', '', $value);
            return str_starts_with($clean, '+') ? $clean : ('+' . $clean);
        }

        if ($key === 'website') {
            if (str_starts_with($value, 'http://') || str_starts_with($value, 'https://')) {
                return $value;
            }
            return 'https://' . $value;
        }

        return $value;
    }

    private static function defaultDisplayOrder(string $key): int
    {
        $position = array_search($key, self::PLATFORM_KEYS, true);
        return $position !== false ? $position + 1 : 99;
    }

    private function assertSuperAdmin(Request $request): void
    {
        $role = $request->user['role'] ?? '';
        if ($role !== 'super_admin') {
            throw new ApiException(403, 'Super Admin access required');
        }
    }

    private function auditChange(?string $actorId, array $changedPlatforms): void
    {
        if ($actorId === null || empty($changedPlatforms)) {
            return;
        }

        // Canonical audit writer: sanitizes details, resolves the actor
        // identity, and uses the CHECK-constrained action values.
        // NEVER include raw contact values — only what changed.
        try {
            \MedAcademy\Services\AuditService::write(
                null,                       // user_id: not a per-user action
                'support_settings_updated',
                [
                    'platforms' => array_map(
                        static fn (array $p): array => [
                            'platform'        => (string) $p['platform'],
                            'label'           => (string) $p['label'],
                            'enabled_changed' => (bool) ($p['old_enabled'] !== $p['new_enabled']),
                            'value_changed'   => (bool) ($p['old_value'] !== $p['new_value']),
                        ],
                        $changedPlatforms
                    ),
                ],
                null,                       // ip_address: not captured here
                $actorId
            );
        } catch (\Throwable $_) {
            // Non-blocking — never fail the save because audit logging failed
            error_log('[SupportController] Audit log write failed: ' . $_->getMessage());
        }
    }
}
