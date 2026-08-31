<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Uuid;

/**
 * Generic data controller — handles the app's legacy chainable query contract.
 *
 * SECURITY:
 * - Table allowlist enforced
 * - Column names validated against identifier regex (prevents SQL injection)
 * - Sensitive tables require admin role
 * - Row-level owner scoping (RLS equivalent) for self-service + doctor-owned data
 * - Mass assignment prevented for sensitive columns
 * - All values use parameterized queries
 *
 * LEGACY QUERY CONTRACT:
 * - Embedded relations (`alias:table!fk(cols)` / `table(cols)`) are resolved
 *   with LEFT JOINs (many-to-one) and batched child queries (one-to-many).
 * - PostgREST filter syntax (`col=eq.val`, `col=not.is.null`, `or=(...)`) is parsed.
 * - `count=exact&head=true` returns `{ count: N }`.
 */
class DataController
{
    /** Tables readable by any authenticated user */
    private const PUBLIC_TABLES = [
        'academic_levels', 'app_branding', 'app_pages', 'categories',
        'content_protection_policies', 'course_templates', 'faculties',
        'feature_flags', 'support_settings', 'system_config', 'universities',
        'video_providers', 'video_provider_config',
    ];

    /** Tables readable only by admin/super_admin */
    private const ADMIN_TABLES = [
        'activation_codes', 'activation_codes_summary', 'activation_ledger_view',
        'analytics_events', 'audit_logs', 'code_batches',
        'content_protection_violations', 'course_lifecycle_logs', 'courses',
        'crash_logs', 'credit_daily_stats', 'credit_ledger_view',
        'credit_transactions', 'credits', 'credits_summary', 'device_stats',
        'devices', 'doctor_credit_summary', 'doctor_earnings_events',
        'doctor_earnings_transactions', 'doctor_payout_requests',
        'doctor_pricing_history', 'enrollments', 'fraud_flags',
        'lesson_materials', 'lesson_pdfs', 'lesson_progress', 'lessons',
        'maintenance_whitelist', 'notifications', 'platform_earnings_resets',
        'profiles', 'provider_audit_log', 'revenue_analytics', 'sections',
        'security_events', 'security_policies', 'security_vpn_whitelist',
        'trash_config', 'upload_audit_logs', 'upload_sessions',
        'video_assets', 'video_daily_health_reports', 'video_health_alerts',
        'video_uploads',
    ];

    /** All allowed tables (union of public + admin) */
    private const ALL_TABLES = [...self::PUBLIC_TABLES, ...self::ADMIN_TABLES];

    /** Tables that are read-only via this controller (INSERT/UPDATE/DELETE blocked) */
    private const READ_ONLY_TABLES = [
        'activation_codes_summary', 'activation_ledger_view',
        'credit_daily_stats', 'credit_ledger_view', 'credits_summary',
        'device_stats', 'doctor_credit_summary', 'revenue_analytics',
        'course_lifecycle_logs', 'audit_logs', 'upload_audit_logs',
        'provider_audit_log', 'analytics_events', 'crash_logs',
        'doctor_earnings_events', 'doctor_earnings_transactions',
        'doctor_payout_requests', 'doctor_pricing_history',
        'video_daily_health_reports', 'video_health_alerts',
    ];

    /** Columns that must never be set via the generic API (prevents mass assignment) */
    private const PROTECTED_COLUMNS = [
        'role', 'status', 'is_admin', 'is_super_admin', 'unlimited_devices',
        'access_token', 'password', 'encrypted_password', 'reset_token',
        'service_role', 'jwt_secret',
    ];

    /**
     * Row-level owner scope (RLS equivalent): non-admin users may only touch
     * rows where the given column equals their own user id.
     */
    private const SELF_SCOPE = [
        'profiles'                   => 'id',
        'notifications'              => 'user_id',
        'lesson_progress'            => 'student_id',
        'credits'                    => 'doctor_id',
        'credit_transactions'        => 'doctor_id',
        'devices'                    => 'user_id',
        'video_uploads'              => 'doctor_id',
        'video_assets'               => 'doctor_id',
        // Earnings tables: a doctor may read their own records; admins keep
        // full access (they bypass the scope in ownerScope/assertAccess).
        'doctor_earnings_events'     => 'doctor_id',
        'doctor_earnings_transactions' => 'doctor_id',
        'doctor_payout_requests'     => 'doctor_id',
        'doctor_pricing_history'     => 'doctor_id',
    ];

    /**
     * Doctor-owned course content (RLS equivalent): non-admin users may only
     * touch rows belonging to courses they own (`courses.doctor_id = me`).
     * All of these tables carry a direct `course_id` column.
     */
    private const COURSE_OWNER_SCOPE = [
        'courses', 'sections', 'lessons', 'lesson_materials',
    ];

    /**
     * enrollments: a student may touch their own rows; a doctor may touch rows
     * for courses they own (student management).
     */
    private const ENROLLMENT_SCOPE = 'enrollments';

    /** Valid MySQL identifier pattern — prevents SQL injection in column/table names */
    private const IDENTIFIER_REGEX = '/^[a-zA-Z_][a-zA-Z0-9_]*$/';

    /**
     * MySQL JSON columns per table (derived from backend/database/schema.sql).
     * These are returned by PDO as raw strings; the frontend contract (PostgREST/
     * Supabase) delivers them as decoded JSON values, so we decode them here.
     */
    private const JSON_COLUMNS = [
        'users'                    => ['raw_app_meta_data', 'raw_user_meta_data'],
        'profiles'                 => ['suspension_device', 'delete_permissions'],
        'courses'                  => ['tags'],
        'video_uploads'            => ['file_analysis', 'provider_metadata'],
        'audit_logs'               => ['details', 'old_values', 'new_values'],
        'system_config'            => ['value'],
        'idempotency_keys'         => ['result'],
        'fraud_flags'              => ['details'],
        'course_templates'         => ['template_data'],
        'upload_audit_logs'        => ['details'],
        'video_health_scans'       => ['checks'],
        'video_health_alerts'      => ['metadata'],
        'video_provider_config'    => ['config'],
        'video_daily_health_reports'=> ['details'],
        'provider_registry'        => ['config', 'capabilities'],
        'provider_audit_log'       => ['metadata'],
        'subscription_timeline'    => ['event_data'],
        'bulk_import_jobs'         => ['rows', 'errors'],
        'security_events'          => ['metadata'],
        'deletion_records'         => ['verification', 'error_details'],
        'security_config'          => ['extras', 'expected_cert_sha256s'],
        'crash_logs'               => ['device_info'],
        'analytics_events'         => ['event_data'],
    ];

    /** @var array<string,string[]> per-request cache of table column lists */
    private array $columnCache = [];

    /**
     * Decode MySQL JSON columns into native PHP values (matches the PostgREST
     * contract: jsonb/text[] come back as arrays/objects, not strings).
     */
    private function decodeJsonRow(array $row, string $table): array
    {
        foreach (self::JSON_COLUMNS[$table] ?? [] as $col) {
            if (array_key_exists($col, $row) && is_string($row[$col]) && $row[$col] !== '') {
                $decoded = json_decode($row[$col], true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    $row[$col] = $decoded;
                }
            }
        }
        return $row;
    }

    /**
     * Normalize JSON-column writes for PDO/MySQL.
     *
     * The frontend contract accepts native arrays/objects, while PDO binds
     * scalar values. Encode structured values once here, and preserve strings
     * that are already valid JSON. This keeps MySQL json_valid() constraints
     * meaningful instead of weakening them or passing "Array" to PDO.
     */
    private function encodeJsonValue(string $table, string $column, mixed $value): mixed
    {
        if (!in_array($column, self::JSON_COLUMNS[$table] ?? [], true) || $value === null) {
            return $value;
        }

        if (is_string($value)) {
            json_decode($value, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                return $value;
            }
        }

        $encoded = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded === false) {
            throw new ApiException(422, "Invalid JSON value for {$table}.{$column}");
        }
        return $encoded;
    }

    /**
     * SELECT from table — GET /api/{table}?select=*&col=val&order=col.asc&limit=10
     */
    public function select(Request $request): void
    {
        $table = $this->extractTableFromPath($request);
        $this->assertAllowed($table, 'read');
        $this->assertAccess($table, $request);

        $db = Database::instance();
        $params = $request->queryParams();
        $userId = $request->user['id'] ?? null;

        $selectRaw = $params['select'] ?? '*';
        $parsed = $this->parseSelect($selectRaw, $table);

        // COUNT / HEAD support: `count=exact&head=true` → { count: N }
        if (isset($params['count']) && isset($params['head'])) {
            [$where, $bindings] = $this->buildWhere($table, $params, $request, $userId);
            $count = (int) $db->value(
                "SELECT COUNT(*) FROM `{$table}`" . ($where ? " WHERE {$where}" : ''),
                $bindings,
                0
            );
            Response::json(['count' => $count]);
            return;
        }

        // ---- Main query (plain columns + many-to-one joins) ----
        [$mainCols, $joins] = $this->buildMainSelect($table, $parsed);
        [$where, $bindings] = $this->buildWhere($table, $params, $request, $userId);

        // ── Internal id injection ─────────────────────────────────────────
        // The response tree is keyed by the main row's `id` (and one-to-many
        // children attach to it), so a select that omits `id` (e.g.
        // select=full_name) used to drop every row and return []. Query the
        // id internally (inside the SELECT projection — never appended after
        // the FROM clause, which would be parsed as a table reference) and
        // strip it from the response afterward, so the output still matches
        // exactly what the caller requested.
        $plainCols = $parsed['plain'] ?? [];
        $stripId = $plainCols !== []
            && !in_array('*', $plainCols, true)
            && !in_array('id', $plainCols, true);
        if ($stripId) {
            $mainCols .= ", `{$table}`.`id`";
        }

        $sql = "SELECT {$mainCols} FROM `{$table}`";
        if ($joins) $sql .= ' ' . implode(' ', $joins);
        if ($where) $sql .= " WHERE {$where}";

        // ORDER BY — prefix with table name when JOINs exist to avoid
        // ambiguity (MySQL error 1052). Validate the column exists on the
        // requested table; skip silently if it doesn't (MySQL error 1054).
        if (!empty($params['order'])) {
            $orderParts = explode('.', $params['order']);
            $orderCol = $this->sanitizeIdentifier($orderParts[0]);
            $this->assertValidIdentifier($orderCol, 'order column');
            $orderDir = ($orderParts[1] ?? 'asc') === 'desc' ? 'DESC' : 'ASC';
            // Check column exists on the main table (avoids 1054)
            $tableCols = $this->tableColumns($table);
            if (in_array($orderCol, $tableCols, true)) {
                // Prefix with table name to disambiguate when JOINs are present
                $sql .= " ORDER BY `{$table}`.`{$orderCol}` {$orderDir}";
            }
            // If column doesn't exist, skip ORDER BY silently (no 500)
        }

        // LIMIT / OFFSET — cast to int (prevents injection)
        if (isset($params['limit'])) {
            $sql .= " LIMIT " . max(0, (int) $params['limit']);
        }
        if (isset($params['offset'])) {
            $sql .= " OFFSET " . max(0, (int) $params['offset']);
        }

        $rows = array_map(fn(array $r) => $this->decodeJsonRow($r, $table), $db->select($sql, $bindings));

        // ---- One-to-many child queries (batched, ordered) ----
        $oneToMany = [];
        $this->collectOneToMany($parsed, $oneToMany, $table);

        $mainIds = array_column($rows, 'id');
        $tree = [];
        foreach ($rows as $idx => $row) {
            $mainId = $row['id'] ?? null;
            if ($mainId === null) continue;
            $tree[$mainId] = $row;
            foreach ($oneToMany as $rel) {
                $tree[$mainId][$rel['alias']] = [];
            }
        }

        // Fetch each one-to-many level (parents → children), bottom-up attach.
        // rels are collected depth-first; process deepest-first by attaching
        // children into their parents after fetching, level by level.
        $levelData = []; // relIndex => parentKey => [ childId => childRow ]
        $parentIds = $mainIds;
        $prevKeyCol = null;
        foreach ($oneToMany as $i => $rel) {
            if (empty($parentIds)) break;
            $childRows = $this->fetchChildren($db, $rel, $parentIds);
            $keyed = [];
            foreach ($childRows as $child) {
                $pid = $child[$rel['fkCol']] ?? null;
                if ($pid === null) continue;
                $keyed[$pid][$child['id']] = $child;
            }
            $levelData[$i] = $keyed;
            // next level parents = all children of this level
            $parentIds = array_values(array_filter(array_map(
                static fn ($group) => array_keys($group),
                $keyed
            ), static fn ($ids) => !empty($ids)));
            $parentIds = $parentIds ? array_merge(...$parentIds) : [];
        }

        // Attach bottom-up so nested children land in the right parents.
        foreach (array_reverse(array_keys($oneToMany), true) as $i) {
            $rel = $oneToMany[$i];
            if ($i === 0 || $rel['depth'] === 1) {
                foreach ($tree as $mainId => &$mainRow) {
                    if (isset($levelData[$i][$mainId])) {
                        $mainRow[$rel['alias']] = array_values($levelData[$i][$mainId]);
                    }
                }
                unset($mainRow);
            } else {
                // attach to parent level's rows (iterate by reference so the
                // nested children propagate into the parent's array)
                foreach ($levelData[$rel['parentRelIndex']] as &$parents) {
                    foreach ($parents as &$parentRow) {
                        $childId = $parentRow['id'] ?? null;
                        if ($childId !== null) {
                            // Always expose the relation as an array — even when
                            // the parent has no children (Supabase returns [] for
                            // an empty one-to-many, never undefined).
                            $parentRow[$rel['alias']] = isset($levelData[$i][$childId])
                                ? array_values($levelData[$i][$childId])
                                : [];
                        }
                    }
                    unset($parentRow);
                }
                unset($parents);
            }
        }

        $result = array_values($tree);

        // Strip the internally injected id so the response reflects exactly
        // the caller's requested select (Supabase contract: only the requested
        // columns are returned).
        if ($stripId) {
            foreach ($result as &$row) {
                unset($row['id']);
            }
            unset($row);
        }

        // Many-to-one relation reshaping (aliased flat columns → nested objects)
        $manyToOne = [];
        $this->collectManyToOne($parsed, $manyToOne);
        if ($manyToOne) {
            foreach ($result as &$row) {
                foreach ($manyToOne as $i => $rel) {
                    $prefix = "__r{$i}__";
                    $nested = [];
                    $any = false;
                    foreach ($row as $k => $v) {
                        if (str_starts_with($k, $prefix)) {
                            $col = substr($k, strlen($prefix));
                            // Decode JSON columns coming from the joined table
                            if (in_array($col, self::JSON_COLUMNS[$rel['table']] ?? [], true)
                                && is_string($v) && $v !== '') {
                                $decoded = json_decode($v, true);
                                if (json_last_error() === JSON_ERROR_NONE) $v = $decoded;
                            }
                            $nested[$col] = $v;
                            if ($v !== null) $any = true;
                            unset($row[$k]);
                        }
                    }
                    $row[$rel['alias']] = $any ? $nested : null;
                }
            }
            unset($row);
        }

        Response::json($result);
    }

    /**
     * INSERT into table — POST /api/{table}
     */
    public function insert(Request $request): void
    {
        $table = $this->extractTableFromPath($request);
        $this->assertAllowed($table, 'write');
        $this->assertNotReadOnly($table);
        $this->assertAccess($table, $request);

        $body = $request->json();
        if (!$body) throw new ApiException(422, 'Request body is required');

        // Support single row or array of rows
        $rows = array_is_list($body) ? $body : [$body];
        $db = Database::instance();
        $inserted = [];

        foreach ($rows as $row) {
            if (!is_array($row)) throw new ApiException(422, 'Each row must be an object');

            // Remove protected columns (mass assignment prevention)
            $row = $this->filterProtectedColumns($row, $table);

            // RLS-equivalent owner enforcement on INSERT
            $row = $this->enforceOwnerOnWrite($table, $row, $request);

            foreach ($row as $column => $value) {
                $row[$column] = $this->encodeJsonValue($table, $column, $value);
            }

            $onConflict = $request->queryParams()['on_conflict'] ?? null;
            $hasOnConflict = is_string($onConflict) && $onConflict !== '';

            // Ensure a PK id exists so insert().select() callers receive the
            // real row back (Supabase returns the representation on insert).
            // All allowed tables use `id` CHAR(36) as PK. SKIPPED for
            // on_conflict upserts: a fresh row gets its id from the DB default
            // and an existing row must keep its own id (never overwrite a PK
            // through the ON DUPLICATE KEY UPDATE clause).
            if (!$hasOnConflict && !array_key_exists('id', $row)) {
                $row['id'] = Uuid::v4();
            }

            $cols = array_keys($row);
            foreach ($cols as $col) {
                $this->assertValidIdentifier($this->sanitizeIdentifier($col), 'column');
            }
            $colNames = implode(', ', array_map(fn($c) => "`{$c}`", $cols));
            $placeholders = implode(', ', array_fill(0, count($cols), '?'));
            $sql = "INSERT INTO `{$table}` ({$colNames}) VALUES ({$placeholders})";
            $bind = array_values($row);

            // on_conflict=col1,col2 → upsert (INSERT ... ON DUPLICATE KEY UPDATE)
            if ($hasOnConflict) {
                $dupCols = array_map('trim', explode(',', $onConflict));
                $updateParts = [];
                foreach ($cols as $c) {
                    if (in_array($c, $dupCols, true)) continue; // conflict keys keep their value
                    if ($c === 'id') continue; // never reassign the PK via upsert
                    $updateParts[] = "`{$c}` = VALUES(`{$c}`)";
                }
                if ($updateParts) {
                    $sql .= " ON DUPLICATE KEY UPDATE " . implode(', ', $updateParts);
                }
            }

            $db->query($sql, $bind);

            // Return the ACTUAL row (with DB defaults like created_at) so
            // callers chaining .select()/.single() get a usable object.
            $saved = null;
            if (array_key_exists('id', $row)) {
                $saved = $db->row("SELECT * FROM `{$table}` WHERE `id` = ?", [$row['id']]);
                if ($saved) $saved = $this->decodeJsonRow($saved, $table);
            } elseif ($hasOnConflict) {
                // Upsert — re-select by the conflict columns (works for both a
                // freshly inserted row and a pre-existing row).
                $dupCols = array_map('trim', explode(',', $onConflict));
                $where = [];
                $selBind = [];
                foreach ($dupCols as $dc) {
                    $dc = $this->sanitizeIdentifier($dc);
                    if (array_key_exists($dc, $row)) {
                        $where[] = "`{$dc}` = ?";
                        $selBind[] = $row[$dc];
                    }
                }
                if ($where) {
                    $saved = $db->row(
                        "SELECT * FROM `{$table}` WHERE " . implode(' AND ', $where) . " LIMIT 1",
                        $selBind
                    );
                    if ($saved) $saved = $this->decodeJsonRow($saved, $table);
                }
            }
            $inserted[] = $saved ?? $row;
        }

        Response::json(array_is_list($body) ? $inserted : $inserted[0], 201);
    }

    /**
     * UPDATE table — PATCH /api/{table}?col=val
     */
    public function update(Request $request): void
    {
        $table = $this->extractTableFromPath($request);
        $this->assertAllowed($table, 'write');
        $this->assertNotReadOnly($table);
        $this->assertAccess($table, $request);

        $body = $request->json();
        if (!$body || !is_array($body)) throw new ApiException(422, 'Request body with update fields required');

        // Remove protected columns (mass assignment prevention)
        $body = $this->filterProtectedColumns($body, $table);

        foreach ($body as $column => $value) {
            $body[$column] = $this->encodeJsonValue($table, $column, $value);
        }

        $userId = $request->user['id'] ?? null;
        [$where, $whereBindings] = $this->buildWhere($table, $request->queryParams(), $request, $userId);

        if (!$where) throw new ApiException(422, 'WHERE conditions required (use query params)');

        $setClauses = [];
        $setBindings = [];
        foreach ($body as $col => $val) {
            $col = $this->sanitizeIdentifier($col);
            $this->assertValidIdentifier($col, 'column');
            $setClauses[] = "`{$col}` = ?";
            $setBindings[] = $val;
        }

        // Bindings order: SET values first (they correspond to SET ?),
        // then WHERE values (they correspond to WHERE ?).
        $bindings = array_merge($setBindings, $whereBindings);

        $sql = "UPDATE `{$table}` SET " . implode(', ', $setClauses) . " WHERE {$where}";
        $db = Database::instance();
        $db->query($sql, $bindings);

        // `.update(...).select()` — return the affected rows in Supabase shape
        $selectRaw = $request->queryParams()['select'] ?? null;
        if ($selectRaw) {
            $params = $request->queryParams();
            $params['select'] = $selectRaw;
            $selWhere = $params;
            unset($selWhere['order'], $selWhere['limit'], $selWhere['offset'], $selWhere['select']);
            [$w2, $b2] = $this->buildWhere($table, $selWhere, $request, $userId);
            $limit = isset($params['limit']) ? ' LIMIT ' . max(0, (int) $params['limit']) : '';
            $rows = $db->select("SELECT * FROM `{$table}`" . ($w2 ? " WHERE {$w2}" : '') . $limit, $b2);
            $rows = array_map(fn(array $r) => $this->decodeJsonRow($r, $table), $rows);
            Response::json($rows);
            return;
        }

        Response::json(['success' => true]);
    }

    /**
     * DELETE from table — DELETE /api/{table}?col=val
     */
    public function delete(Request $request): void
    {
        $table = $this->extractTableFromPath($request);
        $this->assertAllowed($table, 'write');
        $this->assertNotReadOnly($table);
        $this->assertAccess($table, $request);

        $userId = $request->user['id'] ?? null;
        [$where, $bindings] = $this->buildWhere($table, $request->queryParams(), $request, $userId);

        if (!$where) throw new ApiException(422, 'WHERE conditions required');

        $db = Database::instance();

        // Library delete protection: never allow removing a video_assets row
        // that lessons still reference — that would silently break courses.
        // The frontend guard (deleteVideoAsset) checks this first and shows a
        // friendly dialog; this is the server-side safety net for direct calls.
        if ($table === 'video_assets') {
            $used = (int) $db->value(
                "SELECT COUNT(*) FROM lessons
                  WHERE video_asset_id IN (SELECT id FROM `video_assets` WHERE {$where})",
                $bindings,
                0
            );
            if ($used > 0) {
                throw new ApiException(
                    409,
                    "Cannot delete: this video is used by {$used} lesson(s). Remove it from those lessons first."
                );
            }
        }

        $sql = "DELETE FROM `{$table}` WHERE {$where}";
        $db->query($sql, $bindings);
        Response::json(['success' => true]);
    }

    // ── RLS-equivalent access control ────────────────────────────────────────

    /**
     * Table-level access gate. Admin tables remain admin-only UNLESS the table
     * participates in row-level scoping (self-service / doctor-owner / published).
     */
    private function assertAccess(string $table, Request $request): void
    {
        if (in_array($table, self::PUBLIC_TABLES, true)) return;
        $role = $request->user['role'] ?? '';
        if (in_array($role, ['admin', 'super_admin'], true)) return;
        if (in_array($table, self::ADMIN_TABLES, true)) {
            // Row-level scoped tables are reachable by non-admins (with owner
            // filtering applied downstream); everything else stays admin-only.
            $scoped = self::SELF_SCOPE
                + array_fill_keys(self::COURSE_OWNER_SCOPE, null)
                + [self::ENROLLMENT_SCOPE => null];
            if (!array_key_exists($table, $scoped)) {
                throw new ApiException(403, "Table '{$table}' requires admin access");
            }
        }
    }

    /**
     * Return the RLS-equivalent WHERE fragment (+ bindings) that constrains a
     * non-admin user to their own data. Returns ['', []] for admins/public.
     */
    private function ownerScope(string $table, Request $request): array
    {
        $role = $request->user['role'] ?? '';
        if (in_array($role, ['admin', 'super_admin'], true)) return ['', []];
        $userId = $request->user['id'] ?? '';
        if ($userId === '') return ['', []];

        if (isset(self::SELF_SCOPE[$table])) {
            $col = self::SELF_SCOPE[$table];
            return ["`{$table}`.`{$col}` = ?", [$userId]];
        }
        if (in_array($table, self::COURSE_OWNER_SCOPE, true)) {
            if ($table === 'courses') {
                // owner OR published (students browse published; doctors see own)
                return ["(`courses`.`doctor_id` = ? OR `courses`.`status` = 'published')", [$userId]];
            }
            // sections/lessons/lesson_materials all carry course_id
            return [
                "EXISTS (SELECT 1 FROM `courses` c WHERE c.id = `{$table}`.`course_id` AND c.doctor_id = ?)",
                [$userId],
            ];
        }
        if ($table === self::ENROLLMENT_SCOPE) {
            return [
                "(`enrollments`.`student_id` = ? OR EXISTS (SELECT 1 FROM `courses` c WHERE c.id = `enrollments`.`course_id` AND c.doctor_id = ?))",
                [$userId, $userId],
            ];
        }
        return ['', []];
    }

    /**
     * Enforce owner constraints on INSERT for non-admin users:
     *  - self-scope tables: force the owner column to the caller's own id
     *  - course-owner tables: reject rows whose course_id the user does not own
     */
    private function enforceOwnerOnWrite(string $table, array $row, Request $request): array
    {
        $role = $request->user['role'] ?? '';
        if (in_array($role, ['admin', 'super_admin'], true)) return $row;
        $userId = $request->user['id'] ?? '';
        if ($userId === '') return $row;

        if (isset(self::SELF_SCOPE[$table])) {
            $col = self::SELF_SCOPE[$table];
            $row[$col] = $userId; // cannot impersonate another owner
            return $row;
        }
        if (in_array($table, self::COURSE_OWNER_SCOPE, true)) {
            $courseId = $row['course_id'] ?? null;
            if ($courseId === null) {
                throw new ApiException(403, "Missing 'course_id' for table '{$table}'");
            }
            $owned = Database::instance()->value(
                'SELECT id FROM `courses` WHERE id = ? AND doctor_id = ? LIMIT 1',
                [$courseId, $userId],
                null
            );
            if ($owned === null) {
                throw new ApiException(403, "You do not own course '{$courseId}'");
            }
            return $row;
        }
        if ($table === self::ENROLLMENT_SCOPE) {
            $courseId = $row['course_id'] ?? null;
            $studentId = $row['student_id'] ?? null;
            $ownsCourse = $courseId !== null && Database::instance()->value(
                'SELECT id FROM `courses` WHERE id = ? AND doctor_id = ? LIMIT 1',
                [$courseId, $userId],
                null
            ) !== null;
            if ($studentId === $userId || $ownsCourse) return $row;
            throw new ApiException(403, 'You may only enroll yourself or students in your own courses');
        }
        return $row;
    }

    // ── WHERE builder (PostgREST filter syntax) ─────────────────────────────

    /**
     * @return array{0: string, 1: array} [whereSql, bindings]
     */
    private function buildWhere(string $table, array $params, Request $request, ?string $userId): array
    {
        $where = [];
        $bindings = [];
        $self = $this;
        $prefix = static fn(string $col): string => "`{$table}`.`{$col}`";

        foreach ($params as $key => $value) {
            if (in_array($key, ['select', 'order', 'limit', 'offset', 'range', 'count', 'head', 'on_conflict'], true)) continue;

            if ($key === 'or' && is_string($value)) {
                // or=(col.eq.val,col.gt.val) — simple OR group
                $orBody = $value;
                if (str_starts_with($orBody, '(') && str_ends_with($orBody, ')')) {
                    $orBody = substr($orBody, 1, -1);
                }
                $orClauses = [];
                foreach (explode(',', $orBody) as $clause) {
                    $clause = trim($clause);
                    if (preg_match('/^(.+?)\.(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.(.+)$/', $clause, $m)) {
                        $col = $self->sanitizeIdentifier($m[1]);
                        $self->assertValidIdentifier($col, 'column');
                        $neg = $m[2] !== '';
                        $op = $m[3];
                        $val = $m[4];
                        [$sql, $b] = $self->filterClause($prefix($col), $op, $val, $neg);
                        $orClauses[] = $sql;
                        $bindings = array_merge($bindings, $b);
                    }
                }
                if ($orClauses) $where[] = '(' . implode(' OR ', $orClauses) . ')';
                continue;
            }

            $col = $key;
            $op = 'eq';
            $neg = false;
            $val = $value;
            // PostgREST filter syntax on the VALUE: `col=op.value` (one dot),
            // e.g. `archived_at=is.null`, `id=eq.<uuid>`, `status=neq.archived`.
            // The column is the query key; only the operator+value live in the value.
            if (is_string($value) && preg_match('/^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains)\.(.+)$/', $value, $m)) {
                $neg = $m[1] !== '';
                $op = $m[2];
                $val = $m[3];
            }

            $col = $this->sanitizeIdentifier($col);
            $this->assertValidIdentifier($col, 'column');
            [$sql, $b] = $this->filterClause($prefix($col), $op, $val, $neg);
            $where[] = $sql;
            $bindings = array_merge($bindings, $b);
        }

        // RLS-equivalent owner scope (ANDed with caller filters)
        [$scopeSql, $scopeBindings] = $this->ownerScope($table, $request);
        if ($scopeSql !== '') {
            $where[] = $scopeSql;
            $bindings = array_merge($bindings, $scopeBindings);
        }

        return [implode(' AND ', $where), $bindings];
    }

    /**
     * @return array{0: string, 1: array} [sqlFragment, bindings]
     */
    private function filterClause(string $qualifiedCol, string $op, string $val, bool $neg): array
    {
        $sql = match ($op) {
            'neq'     => "{$qualifiedCol} != ?",
            'gt'      => "{$qualifiedCol} > ?",
            'gte'     => "{$qualifiedCol} >= ?",
            'lt'      => "{$qualifiedCol} < ?",
            'lte'     => "{$qualifiedCol} <= ?",
            'like'    => "{$qualifiedCol} LIKE ?",
            'ilike'   => "{$qualifiedCol} LIKE ?",
            'in'      => null, // handled below
            'is'      => null, // handled below
            'contains'=> "JSON_CONTAINS({$qualifiedCol}, ?)",
            default   => "{$qualifiedCol} = ?",
        };

        if ($op === 'in') {
            // Strip PostgREST grouping parens: `in.(a,b,c)`
            if (is_string($val)) {
                $val = trim($val);
                if (str_starts_with($val, '(') && str_ends_with($val, ')')) {
                    $val = substr($val, 1, -1);
                }
            }
            $vals = is_array($val) ? $val : array_map('trim', explode(',', $val));
            $placeholders = implode(',', array_fill(0, count($vals), '?'));
            $sql = "{$qualifiedCol} IN ({$placeholders})";
            $binds = array_values($vals);
        } elseif ($op === 'is') {
            $sql = strtolower($val) === 'null'
                ? "{$qualifiedCol} IS NULL"
                : "{$qualifiedCol} IS NOT NULL";
            $binds = [];
        } else {
            $binds = [$val];
        }

        if ($neg) $sql = "NOT ({$sql})";
        return [$sql, $binds];
    }

    // ── Embedded relation parsing ───────────────────────────────────────────

    /**
     * Parse a PostgREST select string into [plainCols[], manyToOne[], oneToMany[]].
     *
     * manyToOne rel: { alias, table, fkCol, cols[] }
     * oneToMany rel: { alias, table, fkCol, cols[], depth, parentRelIndex }
     */
    private function parseSelect(string $select, string $rootTable): array
    {
        $result = ['plain' => [], 'manyToOne' => [], 'oneToMany' => []];
        $this->parseLevel($select, $result, null, 0, $rootTable);
        return $result;
    }

    private function parseLevel(string $select, array &$result, ?int $parentRelIndex, int $depth, string $parentTable): void
    {
        foreach ($this->splitTopLevel($select) as $part) {
            $part = trim($part);
            if ($part === '' || $part === '*') {
                if ($part === '*') $result['plain'][] = '*';
                continue;
            }
            $open = strpos($part, '(');
            if ($open === false) {
                $result['plain'][] = $part;
                continue;
            }
            if (!str_ends_with($part, ')')) {
                throw new ApiException(422, "Malformed select part: '{$part}'");
            }
            $name = trim(substr($part, 0, $open));
            $inner = substr($part, $open + 1, -1);

            $fkName = null;
            if (str_contains($name, ':')) {
                [$alias, $tableSpec] = explode(':', $name, 2);
                if (str_contains($tableSpec, '!')) {
                    [$table, $fkName] = explode('!', $tableSpec, 2);
                } else {
                    $table = $tableSpec;
                }
                $alias = trim($alias);
                $table = trim($table);
                $fkCol = $fkName !== null
                    ? $this->fkColumnFromConstraint($fkName, $parentTable)
                    : $alias . '_id';
                $rel = [
                    'alias' => $alias,
                    'table' => $table,
                    'fkCol' => $fkCol,
                    'inner' => $inner,
                    'kind'  => 'manyToOne',
                ];
                $rel['cols'] = $this->resolveCols($table, $inner);
                $result['manyToOne'][count($result['manyToOne']) ] = $rel;
            } else {
                $table = trim($name);
                $alias = $table;
                $fkCol = $this->singularize($parentTable) . '_id';
                $rel = [
                    'alias' => $alias,
                    'table' => $table,
                    'fkCol' => $fkCol,
                    'inner' => $inner,
                    'kind'  => 'oneToMany',
                    'depth' => $depth,
                    'parentRelIndex' => $parentRelIndex,
                ];
                $rel['cols'] = $this->resolveCols($table, $inner);
                $result['oneToMany'][] = $rel;
                // nested oneToMany rels inside this child are discovered via collectOneToMany
            }
        }
    }

    /** Split on top-level commas (paren-depth aware) */
    private function splitTopLevel(string $select): array
    {
        $parts = [];
        $buf = '';
        $depth = 0;
        $len = strlen($select);
        for ($i = 0; $i < $len; $i++) {
            $c = $select[$i];
            if ($c === '(') $depth++;
            elseif ($c === ')') $depth--;
            if ($c === ',' && $depth === 0) {
                $parts[] = $buf;
                $buf = '';
                continue;
            }
            $buf .= $c;
        }
        if (trim($buf) !== '') $parts[] = $buf;
        return $parts;
    }

    private function fkColumnFromConstraint(string $fkName, string $parentTable): string
    {
        $col = preg_replace('/_fkey$/', '', $fkName) ?? $fkName;
        // strip leading "{parentTable}_" if present
        $prefix = $parentTable . '_';
        if (str_starts_with($col, $prefix)) {
            $col = substr($col, strlen($prefix));
        }
        return $col;
    }

    private function singularize(string $table): string
    {
        if (str_ends_with($table, 'ies')) return substr($table, 0, -3) . 'y';
        if (str_ends_with($table, 's')) return substr($table, 0, -1);
        return $table;
    }

    /** Resolve a relation's inner column list ('*' → information_schema lookup) */
    private function resolveCols(string $table, string $inner): array
    {
        $this->assertAllowed($table, 'read');
        $cols = [];
        foreach ($this->splitTopLevel($inner) as $part) {
            $part = trim($part);
            if ($part === '') continue;
            if ($part === '*') {
                $all = $this->tableColumns($table);
                foreach ($all as $c) $cols[$c] = $c;
                continue;
            }
            if (str_contains($part, '(')) continue; // nested rel — handled separately
            $c = $this->sanitizeIdentifier($part);
            $this->assertValidIdentifier($c, 'select column');
            $cols[$c] = $c;
        }
        return $cols === [] ? ['id'] : array_values($cols);
    }

    private function tableColumns(string $table): array
    {
        if (isset($this->columnCache[$table])) return $this->columnCache[$table];
        $db = Database::instance();
        $rows = $db->select(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            [$table]
        );
        $cols = array_map(static fn($r) => (string) $r['COLUMN_NAME'], $rows);
        $this->columnCache[$table] = $cols;
        return $cols;
    }

    /**
     * Build main SELECT projection + many-to-one JOINs.
     * @return array{0: string, 1: string[]} [projectionSql, joins[]]
     */
    private function buildMainSelect(string $table, array $parsed): array
    {
        $joins = [];
        $projections = [];
        $mainAll = false;

        foreach ($parsed['plain'] as $p) {
            if ($p === '*') {
                $mainAll = true;
            } else {
                $c = $this->sanitizeIdentifier($p);
                $this->assertValidIdentifier($c, 'select column');
                $projections[] = "`{$table}`.`{$c}`";
            }
        }

        // one-to-many child rels contribute nothing to the main projection
        $i = 0;
        foreach ($parsed['manyToOne'] as $rel) {
            $alias = "__r{$i}";
            $this->assertAllowed($rel['table'], 'read');
            $joins[] = "LEFT JOIN `{$rel['table']}` AS `{$alias}` ON `{$alias}`.`id` = `{$table}`.`{$rel['fkCol']}`";
            foreach ($rel['cols'] as $col) {
                $projections[] = "`{$alias}`.`{$col}` AS `{$alias}__{$col}`";
            }
            $i++;
        }

        if ($mainAll || $projections === []) {
            $projectionSql = "`{$table}`.*";
            if ($projections) $projectionSql .= ', ' . implode(', ', $projections);
        } else {
            $projectionSql = implode(', ', $projections);
        }

        return [$projectionSql, $joins];
    }

    /** Depth-first collect one-to-many rels (with their nested children). */
    private function collectOneToMany(array $parsed, array &$out, string $parentTable, int $depth = 1, ?int $parentRelIndex = null): void
    {
        foreach ($parsed['oneToMany'] as $rel) {
            $rel['depth'] = $depth;
            $rel['parentRelIndex'] = $parentRelIndex;
            $out[] = $rel;
            // nested oneToMany inside this child
            $childParsed = ['plain' => [], 'manyToOne' => [], 'oneToMany' => []];
            $this->parseLevel($rel['inner'], $childParsed, count($out) - 1, $depth + 1, $rel['table']);
            $this->collectOneToMany($childParsed, $out, $rel['table'], $depth + 1, count($out) - 1);
        }
    }

    private function collectManyToOne(array $parsed, array &$out): void
    {
        foreach ($parsed['manyToOne'] as $i => $rel) {
            $out[$i] = $rel;
        }
    }

    /** Fetch child rows for a one-to-many rel, ordered by order_index + created_at if available. */
    private function fetchChildren(Database $db, array $rel, array $parentIds): array
    {
        if ($parentIds === []) return [];
        $this->assertAllowed($rel['table'], 'read');
        $placeholders = implode(',', array_fill(0, count($parentIds), '?'));
        $cols = implode(', ', array_map(static fn($c) => "`{$c}`", $rel['cols']));
        $sql = "SELECT {$cols} FROM `{$rel['table']}` WHERE `{$rel['fkCol']}` IN ({$placeholders})";
        if (in_array('order_index', $rel['cols'], true)) {
            $orderBy = " ORDER BY `order_index` ASC";
            // Only add created_at if the table has that column
            $childCols = $this->tableColumns($rel['table']);
            if (in_array('created_at', $childCols, true)) {
                $orderBy .= ", `created_at` ASC";
            }
            $sql .= $orderBy;
        }
        return array_map(fn(array $r) => $this->decodeJsonRow($r, $rel['table']), $db->select($sql, $parentIds));
    }

    // ── Existing helpers ────────────────────────────────────────────────────

    private function extractTableFromPath(Request $request): string
    {
        $path = $request->path();
        if (preg_match('#/(?:api/)?([a-z_]+)#', $path, $m)) {
            return $m[1];
        }
        throw new ApiException(422, 'Could not determine table name from path');
    }

    private function assertAllowed(string $table, string $op): void
    {
        if (!in_array($table, self::ALL_TABLES, true)) {
            throw new ApiException(403, "Table '{$table}' is not allowed");
        }
    }

    private function assertNotReadOnly(string $table): void
    {
        if (in_array($table, self::READ_ONLY_TABLES, true)) {
            throw new ApiException(403, "Table '{$table}' is read-only");
        }
    }

    private function assertValidIdentifier(string $identifier, string $context): void
    {
        if (!preg_match(self::IDENTIFIER_REGEX, $identifier)) {
            throw new ApiException(422, "Invalid {$context}: '{$identifier}'");
        }
    }

    private function sanitizeIdentifier(string $input): string
    {
        return str_replace(['`', '"', "'", ' '], '', $input);
    }

    private function filterProtectedColumns(array $row, string $table = ''): array
    {
        $protected = self::PROTECTED_COLUMNS;
        // The 'status' column is protected globally to prevent profile privilege
        // escalation, but it is legitimately changeable on other tables (e.g.
        // lessons draft/published workflow). Allow it when the target table is
        // not profiles.
        if ($table !== 'profiles') {
            $protected = array_diff($protected, ['status']);
        }
        foreach ($protected as $col) {
            unset($row[$col]);
        }
        return $row;
    }
}
