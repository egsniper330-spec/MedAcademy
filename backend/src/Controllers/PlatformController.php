<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\FeatureFlagService;
use MedAcademy\Utils\Uuid;

/**
 * Platform control centre — Branding, CMS pages and Feature Flags.
 *
 * ─── Why this controller exists ──────────────────────────────────────────────
 * The three tables (`app_branding`, `app_pages`, `feature_flags`) and the
 * generic `/api/{table}` read path already existed, but nothing ever created a
 * row — so the Super Admin screens showed "Branding unavailable" / "No CMS
 * pages". The screens were not fake; they were reading an EMPTY table. These
 * endpoints make the dataset self-initializing and give writes a validated,
 * Super-Admin-only path:
 *
 *   GET  /platform/branding                 → branding row (created on demand)
 *   PUT  /platform/branding                 → SA: validated partial update
 *   GET  /platform/pages                    → CMS pages (created on demand)
 *   PUT  /platform/pages/{key}              → SA: title / content / published
 *   GET  /platform/feature-flags            → registry + live state
 *   PUT  /platform/feature-flags/{key}      → SA: toggle (registry-validated)
 *
 * ─── Safe content ────────────────────────────────────────────────────────────
 * Page bodies are PLAIN TEXT (no HTML, no script execution anywhere): the app
 * renders "## Heading" lines as headings and every other non-empty line as a
 * paragraph. An EMPTY body means "use the app's built-in default text", which is
 * why GET never invents legal copy — it only guarantees the rows exist so the
 * screen is editable instead of empty.
 *
 * ─── Reads ───────────────────────────────────────────────────────────────────
 * Reads require an authenticated session (the app is fully behind auth) and
 * never leak anything beyond the row itself. Writes are Super Admin only —
 * enforced at the router AND re-checked here.
 */
final class PlatformController
{
    /** Fixed row id the client has always addressed branding by. */
    public const BRANDING_ID = '00000000-0000-0000-0000-000000000001';

    /** Deterministic defaults for a brand-new platform. */
    public const BRANDING_DEFAULTS = [
        'app_name'        => 'MedAcademy',
        'primary_color'   => '#1565C0',
        'secondary_color' => '#0D47A1',
        'contact_email'   => 'support@medacademy.app',
        'support_email'   => 'support@medacademy.app',
        'logo_url'        => '',
        'splash_logo_url' => '',
        'contact_phone'   => '',
        'website_url'     => '',
        'facebook_url'    => '',
        'instagram_url'   => '',
        'youtube_url'     => '',
        'telegram_url'    => '',
        'whatsapp_url'    => '',
        'twitter_url'     => '',
        'linkedin_url'    => '',
        'contact_links'   => '[]',
    ];

    /**
     * Columns a Super Admin may write. Anything else is rejected, so neither
     * this path nor the generic data API can mass-assign (e.g. `id`).
     */
    public const BRANDING_COLUMNS = [
        'app_name', 'logo_url', 'splash_logo_url', 'primary_color', 'secondary_color',
        'contact_email', 'contact_phone', 'support_email', 'website_url',
        'facebook_url', 'instagram_url', 'youtube_url', 'telegram_url',
        'whatsapp_url', 'twitter_url', 'linkedin_url', 'contact_links',
    ];

    /**
     * Platform presets the Contact Links editor may use. Stored as stable
     * machine keys (never display text), so new link types can be added later
     * without touching stored rows.
     */
    public const CONTACT_LINK_PLATFORMS = [
        'whatsapp', 'telegram', 'facebook', 'instagram',
        'twitter', 'website', 'email', 'phone',
    ];

    /**
     * CMS pages that a real screen in the app renders. `builtin` marks pages
     * whose text ships inside the app (used whenever the stored body is empty).
     */
    public const PAGES = [
        'terms_conditions' => ['title' => 'Terms & Conditions', 'builtin' => true],
        'privacy_policy'   => ['title' => 'Privacy Policy', 'builtin' => true],
        'about_us'         => ['title' => 'About Us', 'builtin' => true],
        'contact_us'       => ['title' => 'Contact Us', 'builtin' => true,
            'description' => 'Intro text shown above the contact channels on the Contact Us screen. The channels themselves (email, phone, WhatsApp, Telegram, website) come from Platform → Branding.'],
    ];

    public function __construct(
        private readonly FeatureFlagService $flags = new FeatureFlagService()
    ) {
    }

    // ── Branding ─────────────────────────────────────────────────────────────

    /** GET /platform/branding */
    public function branding(Request $request): array
    {
        return ['branding' => $this->ensureBranding()];
    }

    /** PUT /platform/branding — Super Admin only. */
    public function updateBranding(Request $request): array
    {
        $this->assertSuperAdmin($request);

        $body = $request->json();
        if (!is_array($body) || $body === []) {
            throw new ApiException(422, 'No branding fields supplied');
        }

        $updates = [];
        foreach ($body as $key => $value) {
            if (!in_array($key, self::BRANDING_COLUMNS, true)) {
                throw new ApiException(422, "Field '{$key}' is not editable", 'unknown_branding_field');
            }
            if ($key === 'contact_links') {
                // Structured list — validated below, stored as JSON. Never raw
                // HTML: the client renders plain text labels + a destination URL.
                $updates[$key] = (string) json_encode(
                    self::sanitizeContactLinks($value),
                    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                );
                continue;
            }
            if ($value !== null && !is_string($value) && !is_int($value) && !is_float($value)) {
                throw new ApiException(422, "Field '{$key}' must be a string", 'invalid_branding_value');
            }
            $updates[$key] = $value === null ? null : trim((string) $value);
        }

        $this->validateBranding($updates);
        $this->ensureBranding(); // guarantee the row exists before updating it

        $set = [];
        $params = [];
        foreach ($updates as $key => $value) {
            $set[] = "`{$key}` = ?";
            $params[] = $value;
        }
        $set[] = '`updated_by` = ?';
        $params[] = (string) ($request->user['id'] ?? '');
        $set[] = '`updated_at` = UTC_TIMESTAMP(6)';
        $params[] = self::BRANDING_ID;

        Database::instance()->query(
            'UPDATE `app_branding` SET ' . implode(', ', $set) . ' WHERE `id` = ?',
            $params
        );

        AuditService::write((string) ($request->user['id'] ?? ''), 'platform_settings_changed', [
            'setting' => 'branding',
            'fields'  => array_keys($updates),
        ]);

        return ['branding' => $this->ensureBranding()];
    }

    /** Length/charset guard-rails so branding can never break rendering. */
    private function validateBranding(array $updates): void
    {
        if (array_key_exists('app_name', $updates)) {
            $name = (string) $updates['app_name'];
            if ($name === '' || mb_strlen($name) > 60) {
                throw new ApiException(422, 'app_name must be 1–60 characters', 'invalid_branding_value');
            }
        }
        foreach (['contact_email', 'support_email'] as $emailKey) {
            if (array_key_exists($emailKey, $updates) && $updates[$emailKey] !== null && $updates[$emailKey] !== '') {
                if (!filter_var($updates[$emailKey], FILTER_VALIDATE_EMAIL)) {
                    throw new ApiException(422, "{$emailKey} must be a valid email address", 'invalid_branding_value');
                }
            }
        }
        foreach (['primary_color', 'secondary_color'] as $colorKey) {
            if (array_key_exists($colorKey, $updates) && $updates[$colorKey] !== null && $updates[$colorKey] !== '') {
                if (!preg_match('/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/', (string) $updates[$colorKey])) {
                    throw new ApiException(422, "{$colorKey} must be a hex colour like #1565C0", 'invalid_branding_value');
                }
            }
        }
        foreach (self::BRANDING_COLUMNS as $key) {
            if ($key === 'contact_links') {
                continue; // structured JSON list — validated by sanitizeContactLinks()
            }
            if (isset($updates[$key]) && is_string($updates[$key]) && mb_strlen($updates[$key]) > 500) {
                throw new ApiException(422, "{$key} is limited to 500 characters", 'invalid_branding_value');
            }
        }
        // URLs must be http(s) — never a javascript: or data: payload.
        foreach (['logo_url', 'splash_logo_url', 'website_url', 'facebook_url', 'instagram_url',
                  'youtube_url', 'telegram_url', 'whatsapp_url', 'twitter_url', 'linkedin_url'] as $urlKey) {
            if (isset($updates[$urlKey]) && $updates[$urlKey] !== null && $updates[$urlKey] !== '') {
                if (!preg_match('#^https?://#i', (string) $updates[$urlKey])) {
                    throw new ApiException(422, "{$urlKey} must start with http:// or https://", 'invalid_branding_value');
                }
            }
        }
    }

    /** Idempotent: returns the branding row, creating it with defaults if needed. */
    private function ensureBranding(): array
    {
        $db = Database::instance();
        $row = $db->row('SELECT * FROM `app_branding` WHERE `id` = ?', [self::BRANDING_ID]);
        if ($row !== null) {
            return $this->normalizeBranding($row);
        }

        $columns = array_keys(self::BRANDING_DEFAULTS);
        $placeholders = implode(', ', array_fill(0, count($columns) + 1, '?'));
        $params = [self::BRANDING_ID];
        foreach ($columns as $column) {
            $params[] = self::BRANDING_DEFAULTS[$column];
        }
        $db->query(
            'INSERT IGNORE INTO `app_branding` (`id`, `' . implode('`, `', $columns) . '`) VALUES (' . $placeholders . ')',
            $params
        );

        $row = $db->row('SELECT * FROM `app_branding` WHERE `id` = ?', [self::BRANDING_ID]);
        return $this->normalizeBranding($row ?? array_merge(['id' => self::BRANDING_ID], self::BRANDING_DEFAULTS));
    }

    /**
     * Fill NULL/absent branding fields with the defaults so the client always
     * receives a complete, renderable object (never "unavailable").
     */
    private function normalizeBranding(array $row): array
    {
        $out = ['id' => (string) ($row['id'] ?? self::BRANDING_ID)];
        foreach (self::BRANDING_DEFAULTS as $key => $default) {
            $value = $row[$key] ?? null;
            $out[$key] = ($value === null || $value === '') ? $default : (string) $value;
        }
        $out['updated_at'] = $row['updated_at'] ?? null;
        $out['contact_links'] = self::decodeContactLinks($row['contact_links'] ?? null);
        return $out;
    }

    /**
     * Validate + normalise the Contact Us link list.
     *
     * Storage contract (mirrored by src/lib/branding.ts):
     *   `url` is the RAW destination the admin typed — an http(s) URL for web
     *   platforms, a BARE email address for `email`, a BARE phone number for
     *   `phone`. The client adds `mailto:`/`tel:` when opening, so no scheme
     *   ever comes from an admin and no `javascript:`/`data:` payload can be
     *   stored or rendered.
     */
    public static function sanitizeContactLinks(mixed $raw): array
    {
        if ($raw === null || $raw === '') {
            return [];
        }
        if (is_string($raw)) {
            $decoded = json_decode($raw, true);
            $raw = is_array($decoded) ? $decoded : [];
        }
        if (!is_array($raw)) {
            throw new ApiException(422, 'contact_links must be a list of links', 'invalid_branding_value');
        }
        if (count($raw) > 20) {
            throw new ApiException(422, 'contact_links is limited to 20 links', 'invalid_branding_value');
        }

        $out = [];
        foreach (array_values($raw) as $item) {
            if (!is_array($item)) {
                throw new ApiException(422, 'Each contact link must be an object', 'invalid_branding_value');
            }
            $platform = strtolower(trim((string) ($item['platform'] ?? '')));
            if (!in_array($platform, self::CONTACT_LINK_PLATFORMS, true)) {
                throw new ApiException(422, "Unsupported contact link platform '{$platform}'", 'invalid_branding_value');
            }
            $label = trim((string) ($item['label'] ?? ''));
            if ($label === '') {
                $label = ucfirst($platform);
            }
            if (mb_strlen($label) > 60) {
                throw new ApiException(422, 'A contact link label is limited to 60 characters', 'invalid_branding_value');
            }
            $url = trim((string) ($item['url'] ?? ''));
            if ($url === '') {
                throw new ApiException(422, "Contact link '{$label}' needs a destination", 'invalid_branding_value');
            }
            if (mb_strlen($url) > 500) {
                throw new ApiException(422, 'A contact link destination is limited to 500 characters', 'invalid_branding_value');
            }

            if ($platform === 'email') {
                $bare = (string) preg_replace('#^mailto:#i', '', $url);
                if (!filter_var($bare, FILTER_VALIDATE_EMAIL)) {
                    throw new ApiException(422, "Contact link '{$label}' must be a valid email address", 'invalid_branding_value');
                }
                $url = $bare;
            } elseif ($platform === 'phone') {
                $bare = (string) preg_replace('#^tel:#i', '', $url);
                if (!preg_match('/^\+?[0-9 ()\-]{6,20}$/', $bare)) {
                    throw new ApiException(422, "Contact link '{$label}' must be a valid phone number", 'invalid_branding_value');
                }
                $url = $bare;
            } elseif (!preg_match('#^https?://#i', $url)) {
                throw new ApiException(422, "Contact link '{$label}' must start with http:// or https://", 'invalid_branding_value');
            }

            $out[] = [
                'platform' => $platform,
                'label'    => $label,
                'url'      => $url,
                'enabled'  => !array_key_exists('enabled', $item) || (bool) $item['enabled'],
            ];
        }
        return $out;
    }

    /**
     * Decode stored contact_links for the read path. NEVER throws: a malformed
     * stored value degrades to an empty list instead of breaking the screen.
     */
    public static function decodeContactLinks(mixed $raw): array
    {
        try {
            return self::sanitizeContactLinks($raw);
        } catch (ApiException) {
            return [];
        }
    }

    // ── CMS pages ────────────────────────────────────────────────────────────

    /** GET /platform/pages */
    public function pages(Request $request): array
    {
        return ['pages' => $this->ensurePages()];
    }

    /** PUT /platform/pages/{key} — Super Admin only. */
    public function updatePage(Request $request): array
    {
        $this->assertSuperAdmin($request);

        $key = (string) ($request->params['key'] ?? '');
        if (!isset(self::PAGES[$key])) {
            throw new ApiException(422, "Unknown CMS page '{$key}'", 'unknown_cms_page');
        }

        $this->ensurePages();
        $row = Database::instance()->row('SELECT * FROM `app_pages` WHERE `key` = ?', [$key]);
        if ($row === null) {
            throw new ApiException(404, "CMS page '{$key}' not found");
        }

        $body = $request->json();
        $set = [];
        $params = [];

        if (array_key_exists('title', $body)) {
            $title = trim((string) $body['title']);
            if ($title === '' || mb_strlen($title) > 255) {
                throw new ApiException(422, 'title must be 1–255 characters', 'invalid_cms_value');
            }
            $set[] = '`title` = ?';
            $params[] = $title;
        }
        if (array_key_exists('content', $body)) {
            $content = (string) $body['content'];
            if (mb_strlen($content) > 20000) {
                throw new ApiException(422, 'content is limited to 20000 characters', 'invalid_cms_value');
            }
            $set[] = '`content` = ?';
            $params[] = $content;
        }
        if (array_key_exists('published', $body)) {
            $set[] = '`published` = ?';
            $params[] = filter_var($body['published'], FILTER_VALIDATE_BOOLEAN) ? 1 : 0;
        }

        if ($set === []) {
            throw new ApiException(422, 'No editable fields supplied');
        }

        $set[] = '`updated_by` = ?';
        $params[] = (string) ($request->user['id'] ?? '');
        $set[] = '`updated_at` = UTC_TIMESTAMP(6)';
        $params[] = (string) $row['id'];

        Database::instance()->query(
            'UPDATE `app_pages` SET ' . implode(', ', $set) . ' WHERE `id` = ?',
            $params
        );

        AuditService::write((string) ($request->user['id'] ?? ''), 'platform_settings_changed', [
            'setting' => 'cms_page',
            'key'     => $key,
            'fields'  => array_keys($body),
        ]);

        return ['pages' => $this->ensurePages()];
    }

    /** Idempotent: guarantees one row per PAGES key, then returns them. */
    private function ensurePages(): array
    {
        $db = Database::instance();
        $rows = $db->select('SELECT * FROM `app_pages`');
        $byKey = [];
        foreach ($rows as $row) {
            $byKey[(string) ($row['key'] ?? '')] = $row;
        }

        foreach (self::PAGES as $key => $meta) {
            if (isset($byKey[$key])) {
                continue;
            }
            // content stays empty on purpose: an empty body means "use the
            // app's built-in text", so seeding can never replace legal copy
            // with a placeholder.
            $db->query(
                'INSERT IGNORE INTO `app_pages` (`id`, `key`, `title`, `content`, `published`, `updated_at`)
                 VALUES (?, ?, ?, ?, 1, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $key, (string) $meta['title'], '']
            );
        }

        $rows = $db->select('SELECT * FROM `app_pages`');
        $out = [];
        foreach ($rows as $row) {
            $key = (string) ($row['key'] ?? '');
            if (!isset(self::PAGES[$key])) {
                continue; // only registry pages are exposed — no arbitrary content
            }
            $out[] = [
                'id'        => (string) ($row['id'] ?? ''),
                'key'       => $key,
                'title'     => (string) ($row['title'] ?? self::PAGES[$key]['title']),
                'content'   => (string) ($row['content'] ?? ''),
                'published' => (bool) ($row['published'] ?? true),
                // true → the app renders its bundled text because content is empty
                'using_builtin' => trim((string) ($row['content'] ?? '')) === '',
                'updated_at' => $row['updated_at'] ?? null,
            ];
        }
        usort($out, static fn (array $a, array $b): int => strcmp($a['key'], $b['key']));
        return $out;
    }

    // ── Feature flags ────────────────────────────────────────────────────────

    /** GET /platform/feature-flags[?user_id=…] — per-user view for the console. */
    public function featureFlags(Request $request): array
    {
        $userId = (string) ($request->query('user_id', '') ?? '');
        return ['flags' => $userId !== ''
            ? $this->flags->snapshotForUser($userId)
            : $this->flags->snapshot()];
    }

    /** PUT /platform/feature-flags/{key} — Super Admin only. */
    public function updateFeatureFlag(Request $request): array
    {
        $this->assertSuperAdmin($request);

        $key = (string) ($request->params['key'] ?? '');
        $body = $request->json();
        if (!array_key_exists('enabled', $body)) {
            throw new ApiException(422, 'Field "enabled" (boolean) is required');
        }

        $flag = $this->flags->setEnabled(
            $key,
            filter_var($body['enabled'], FILTER_VALIDATE_BOOLEAN),
            (string) ($request->user['id'] ?? '')
        );

        return ['flag' => $flag, 'flags' => $this->flags->snapshot()];
    }

    /** Writes are Super Admin only — the router enforces it and so do we. */
    private function assertSuperAdmin(Request $request): void
    {
        if (($request->user['role'] ?? '') !== 'super_admin') {
            throw new ApiException(403, 'Only Super Admin can change platform settings');
        }
    }

    // ── Per-user feature-flag overrides (Super Admin console) ────────────

    /**
     * PUT /platform/feature-flags/{key}/user/{userId} — body { mode } ∈
     * inherit|enabled|disabled. Audited; Super Admin only (router + here).
     */
    public function updateFeatureFlagForUser(Request $request): array
    {
        $this->assertSuperAdmin($request);

        $key = (string) ($request->params['key'] ?? '');
        $userId = \MedAcademy\Utils\Uuid::normalize((string) ($request->params['userId'] ?? ''));
        $mode = trim((string) ($request->json()['mode'] ?? ''));

        if ($userId === '') {
            throw new ApiException(422, 'userId is required');
        }

        $this->flags->setOverride($key, $userId, $mode);

        AuditService::write((string) ($request->user['id'] ?? ''), 'feature_flag_override_updated', [
            'key'      => $key,
            'user_id'  => $userId,
            'mode'     => $mode,
        ]);

        return ['flags' => $this->flags->snapshotForUser($userId)];
    }
}
