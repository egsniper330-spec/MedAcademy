<?php

declare(strict_types=1);

namespace MedAcademy\Storage;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;

/**
 * Filesystem storage for the PHP/MySQL application.
 *
 *   storage/public/   — public files (served through the public-file route or web server)
 *   storage/private/  — private files, served ONLY through signed URLs
 *                       generated here after the same authorisation checks
 *                       used by the PHP storage API.
 *
 * Buckets (from 00002_create_storage_buckets.sql):
 *   avatars, course-images, lesson-pdfs, lesson-materials, app-assets,
 *   video-chunks, course-covers, lesson-thumbnails
 */
final class StorageService
{
    private string $publicDir;
    private string $privateDir;

    public function __construct()
    {
        $this->publicDir = MEDACADEMY_BASE . '/' . Config::string('STORAGE_PUBLIC_DIR', 'storage/public');
        $this->privateDir = MEDACADEMY_BASE . '/' . Config::string('STORAGE_PRIVATE_DIR', 'storage/private');
    }

    public function bucketPath(string $bucket, string $path): string
    {
        $bucket = basename($bucket); // no traversal
        $path = ltrim($path, '/');
        if (str_contains($path, '..')) {
            throw new ApiException(400, 'Invalid path');
        }
        return $bucket . '/' . $path;
    }

    public function publicUrl(string $bucket, string $path): string
    {
        return rtrim(Config::string('APP_URL'), '/') . '/storage/public/' . $this->bucketPath($bucket, $path);
    }

    public function publicFilePath(string $bucket, string $path): string
    {
        return $this->publicDir . '/' . $this->bucketPath($bucket, $path);
    }

    /** Absolute public/private roots — used by the storage statistics scan. */
    public function publicDir(): string
    {
        return $this->publicDir;
    }

    public function privateDir(): string
    {
        return $this->privateDir;
    }

    /**
     * Move an uploaded temp file into storage.
     * Returns the object path relative to the bucket.
     */
    public function putFile(string $bucket, string $destPath, string $tmpPath, bool $public = false): string
    {
        $rel = $this->bucketPath($bucket, $destPath);
        $root = $public ? $this->publicDir : $this->privateDir;
        $full = $root . '/' . $rel;
        $dir = dirname($full);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new ApiException(500, 'Storage directory is not writable');
        }
        if (!move_uploaded_file($tmpPath, $full) && !rename($tmpPath, $full)) {
            throw new ApiException(500, 'Failed to store file');
        }
        return $rel;
    }

    public function delete(string $bucket, string $path, bool $public = false): void
    {
        $full = ($public ? $this->publicDir : $this->privateDir) . '/' . $this->bucketPath($bucket, $path);
        if (is_file($full)) {
            @unlink($full);
        }
    }

    /**
     * Time-limited signed URL for a private object. The signature is an HMAC
     * over path+expiry using a server-side secret; the URL is consumed by a
     * small PHP endpoint (see routes: GET /storage/signed) that validates it.
     */
    public function signedUrl(string $bucket, string $path, ?int $ttl = null): string
    {
        $ttl ??= Config::int('STORAGE_SIGNED_URL_TTL_SECONDS', 3600);
        $rel = $this->bucketPath($bucket, $path);
        $expires = time() + $ttl;
        $secret = Config::string('STORAGE_SIGNED_URL_SECRET', Config::string('JWT_SECRET'));
        $signature = hash_hmac('sha256', $rel . '|' . $expires, $secret);
        return rtrim(Config::string('APP_URL'), '/') . '/storage/signed?'
            . http_build_query(['bucket' => $bucket, 'path' => $rel, 'expires' => $expires, 'sig' => $signature]);
    }

    /**
     * Authorisation check — port of the get-signed-url Edge Function:
     *   lesson-materials: doctor/admin/super_admin OR ENROLLED (non-suspended)
     *                     student on a PUBLISHED lesson/course OR preview lesson
     *   lesson-pdfs:      any authenticated user
     *
     * $forDownload distinguishes the app's "save this file" action from merely
     * VIEWING it. A material the doctor set to `preview_only` may be viewed but
     * never delivered for download, and `download_enabled = false` blocks the
     * download for any permission level. (`hidden` / `disabled` are refused for
     * both.) The bytes still have to reach the device to be displayed, so the
     * enforceable boundary is the mint request that carries this intent — which
     * is exactly what the client sends when the student taps Download.
     */
    public function canAccess(string $userId, string $role, string $bucket, string $path, bool $forDownload = false): bool
    {
        if (in_array($role, ['doctor', 'admin', 'super_admin'], true)) {
            return true;
        }
        if ($bucket === 'lesson-pdfs') {
            return true;
        }
        if ($bucket === 'lesson-materials') {
            $row = Database::instance()->row(
                'SELECT lm.course_id, lm.permission, lm.download_enabled, lm.preview_enabled,
                        l.is_preview, l.status AS lesson_status,
                        c.status AS course_status
                   FROM lesson_materials lm
                   LEFT JOIN lessons l ON l.id = lm.lesson_id
                   LEFT JOIN courses c ON c.id = lm.course_id
                  WHERE lm.storage_path = ?
                  LIMIT 1',
                [$path]
            );
            if ($row === null) {
                return false;
            }
            // 1. A material the doctor switched off is never delivered — not to
            //    a viewer, not as a download. This is the per-material policy the
            //    lesson editor already exposes (allow / preview_only / hidden /
            //    disabled); before this check it was honoured ONLY in the UI, so
            //    any enrolled student who knew the storage path could fetch a
            //    hidden attachment directly through the storage API.
            $permission = (string) ($row['permission'] ?? 'allow');
            if (in_array($permission, ['hidden', 'disabled'], true)) {
                return false;
            }
            // 2. A free-preview lesson is open to any authenticated user
            //    (unchanged), but the material's own permission switch still
            //    applies to DOWNLOADS.
            if (!empty($row['is_preview'])) {
                return !($forDownload && ($permission === 'preview_only' || !$row['download_enabled']));
            }
            // 3. Unpublished content is never delivered to students — the same
            //    rule the playback OTP and the course-visibility scope enforce.
            //    (A NULL lesson/course row means the association is broken, so the
            //    material is not delivered either.)
            if (($row['course_status'] ?? null) !== 'published') {
                return false;
            }
            if (($row['lesson_status'] ?? null) !== 'published') {
                return false;
            }
            // 4. Enrollment must be ACTIVE: a SUSPENDED enrollment is not access
            //    (the doctor suspends a student per course, and the course
            //    disappears from their account — its materials must go with it).
            //    A legacy row without a status counts as active, so this never
            //    hides a legitimate enrollment.
            $enrolled = (bool) Database::instance()->value(
                "SELECT COUNT(*) FROM enrollments
                  WHERE student_id = ? AND course_id = ?
                    AND (`status` IS NULL OR `status` <> 'suspended')",
                [$userId, $row['course_id']],
                0
            );
            if (!$enrolled) {
                return false;
            }
            if ($forDownload && ($permission === 'preview_only' || !$row['download_enabled'])) {
                return false;
            }
            return true;
        }
        return false;
    }
}
