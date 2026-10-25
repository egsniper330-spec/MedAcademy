<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\UploadIntegrityService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

final class StorageController
{
    private const PUBLIC_BUCKETS = ['avatars', 'user-avatars', 'course-images', 'course-covers', 'lesson-thumbnails', 'video-thumbnails', 'app-assets'];
    private const PRIVATE_BUCKETS = ['lesson-pdfs', 'lesson-materials', 'video-chunks', 'video-uploads', 'temp-uploads', 'patch-uploads'];

    /**
     * Executable / script / server-side types that must never be stored as a
     * lesson attachment (see assertUploadAllowed). Documents, archives, media
     * and images are all allowed — this is a denylist, not an allowlist.
     */
    private const BLOCKED_UPLOAD_EXTENSIONS = [
        'php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phar', 'pht',
        'cgi', 'pl', 'py', 'rb', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'com', 'ps1', 'psm1',
        'exe', 'msi', 'dll', 'so', 'dylib', 'jar', 'war', 'scr', 'vbs', 'vbe', 'wsf', 'hta',
        'jsp', 'jspx', 'asp', 'aspx', 'ashx', 'htaccess', 'htpasswd', 'pem', 'key',
    ];

    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly UploadIntegrityService $integrity = new UploadIntegrityService(),
    ) {
    }

    /** Return bucket metadata only; file contents and private paths remain protected. */
    public function buckets(Request $request): array
    {
        return array_map(
            static fn (string $name): array => [
                'id' => $name, 'name' => $name,
                'public' => in_array($name, self::PUBLIC_BUCKETS, true),
            ],
            [...self::PUBLIC_BUCKETS, ...self::PRIVATE_BUCKETS]
        );
    }

    // ── Real storage statistics (Admin/Super Admin diagnostics) ─────────────
    // Every number below is MEASURED at request time from the PHP app's own
    // filesystem or the MySQL database — nothing is hardcoded, nothing is
    // derived from database row counts pretending to be file sizes.

    /** Aggregate a directory recursively. Bounded, app-owned paths only. */
    private static function dirSize(string $dir): int
    {
        if (!is_dir($dir)) {
            return 0;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS | \FilesystemIterator::CURRENT_AS_FILEINFO),
            \RecursiveIteratorIterator::LEAVES_ONLY
        );
        $total = 0;
        foreach ($it as $info) {
            if ($info->isFile() && is_readable($info->getPathname())) {
                $total += $info->getSize();
            }
        }
        return $total;
    }

    /**
     * GET /storage/stats — what the Storage Monitor renders.
     *
     * A section is present ONLY when it could actually be measured; failures
     * carry a structured reason so the UI can show "unavailable" with a real
     * cause instead of a fake zero. No credentials, no server paths beyond a
     * short measured-root label.
     */
    public function stats(Request $request): array
    {
        $publicDir = $this->storage->publicDir();
        $privateDir = $this->storage->privateDir();

        // ── Hosting disk (the volume the application is deployed on) ──
        $disk = null;
        $reason = null;
        try {
            $total = @disk_total_space($publicDir);
            $free = @disk_free_space($publicDir);
            if (is_float($total) && $total > 0 && is_float($free) && $free >= 0) {
                $disk = [
                    'total_bytes' => (int) $total,
                    'free_bytes' => (int) $free,
                    'used_bytes' => (int) ($total - $free),
                    'used_pct' => round((($total - $free) / $total) * 100, 1),
                ];
            } else {
                $reason = 'filesystem_measurement_unavailable';
            }
        } catch (\Throwable) {
            $reason = 'filesystem_measurement_unavailable';
        }

        // ── Application-owned upload directories (physical files) ──
        $buckets = [];
        $uploadsTotal = 0;
        foreach ([
            'avatars' => $publicDir . '/avatars',
            'user-avatars' => $publicDir . '/user-avatars',
            'course-images' => $publicDir . '/course-images',
            'course-covers' => $publicDir . '/course-covers',
            'lesson-thumbnails' => $publicDir . '/lesson-thumbnails',
            'video-thumbnails' => $publicDir . '/video-thumbnails',
            'app-assets' => $publicDir . '/app-assets',
            'lesson-pdfs' => $privateDir . '/lesson-pdfs',
            'lesson-materials' => $privateDir . '/lesson-materials',
            'video-chunks' => $privateDir . '/video-chunks',
            'video-uploads' => $privateDir . '/video-uploads',
            'temp-uploads' => $privateDir . '/temp-uploads',
            'patch-uploads' => $privateDir . '/patch-uploads',
        ] as $name => $dir) {
            if (!is_dir($dir)) {
                $buckets[] = ['name' => $name, 'bytes' => 0, 'files' => 0];
                continue;
            }
            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS | \FilesystemIterator::CURRENT_AS_FILEINFO),
                \RecursiveIteratorIterator::LEAVES_ONLY
            );
            $bytes = 0;
            $files = 0;
            foreach ($it as $info) {
                if ($info->isFile() && is_readable($info->getPathname())) {
                    $bytes += $info->getSize();
                    $files++;
                }
            }
            $buckets[] = ['name' => $name, 'bytes' => $bytes, 'files' => $files];
            $uploadsTotal += $bytes;
        }

        // ── Database size (information_schema — same connection, same perms) ──
        $db = null;
        $dbReason = null;
        try {
            $row = Database::instance()->row(
                "SELECT COUNT(*) AS table_count, COALESCE(SUM(data_length + index_length), 0) AS total_bytes
                   FROM information_schema.TABLES WHERE table_schema = DATABASE()",
                [],
                ['table_count' => 0, 'total_bytes' => 0]
            );
            if (is_array($row) && isset($row['total_bytes'])) {
                $largest = Database::instance()->select(
                    "SELECT table_name AS name, (data_length + index_length) AS bytes
                       FROM information_schema.TABLES WHERE table_schema = DATABASE()
                       ORDER BY (data_length + index_length) DESC LIMIT 5"
                );
                $db = [
                    'total_bytes' => (int) $row['total_bytes'],
                    'table_count' => (int) ($row['table_count'] ?? 0),
                    'largest_tables' => array_map(
                        static fn (array $t): array => ['name' => (string) $t['name'], 'bytes' => (int) $t['bytes']],
                        $largest
                    ),
                ];
            } else {
                $dbReason = 'database_measurement_unavailable';
            }
        } catch (\Throwable) {
            $dbReason = 'database_measurement_unavailable';
        }

        return [
            'disk' => $disk,
            'disk_unavailable_reason' => $reason,
            'measured_root_label' => 'hosting deployment volume (the disk this app is deployed on — NOT the user hosting-plan quota)',
            'uploads' => [
                'total_bytes' => $uploadsTotal,
                'buckets' => $buckets,
                'public_dir_label' => 'storage/public',
                'private_dir_label' => 'storage/private',
            ],
            'database' => $db,
            'database_unavailable_reason' => $dbReason,
            'checked_at' => gmdate('c'),
        ];
    }

    public function signedUrl(Request $request): array
    {
        $bucket = (string) ($request->json()['bucket'] ?? '');
        $path = (string) ($request->json()['path'] ?? '');
        $expiresIn = min((int) ($request->json()['expires_in'] ?? 3600), 43200);

        if (!in_array($bucket, self::PRIVATE_BUCKETS, true)) {
            throw new ApiException(400, 'bucket must be one of: ' . implode(', ', self::PRIVATE_BUCKETS));
        }
        if ($path === '') {
            throw new ApiException(400, 'path is required');
        }

        // `download: true` is what the app sends when the student taps the
        // Download action (as opposed to opening the material in the viewer).
        // It lets a material the doctor marked `preview_only`, or one with
        // download_enabled = false, still be VIEWED while its download is
        // refused — server-side, not just by hiding a button.
        $forDownload = filter_var($request->json()['download'] ?? false, FILTER_VALIDATE_BOOLEAN);

        $normalised = $this->normalisePath($path);
        // The legacy `lesson-pdfs` bucket (the superseded `lesson_pdfs` table) is
        // staff-only: those objects cannot be personalized, so a student who
        // signed one would receive an unwatermarked PDF. Refused with the same
        // code as a lesson-material PDF so the app can say something useful.
        if ($bucket === 'lesson-pdfs' && !in_array((string) $request->user['role'], ['doctor', 'admin', 'super_admin'], true)) {
            throw new ApiException(
                403,
                'Lecture notes are delivered as personalized lesson materials. Ask your instructor to upload them as material.',
                'material_delivery_required'
            );
        }
        if (!$this->storage->canAccess($request->user['id'], $request->user['role'], $bucket, $normalised, $forDownload)) {
            throw new ApiException(403, 'Access denied');
        }
        // A lesson-material PDF is delivered ONLY by MaterialDeliveryController:
        // every student copy must be personalized, and that endpoint re-checks
        // enrollment at stream time. A storage signature can do neither, so it
        // is refused here rather than handing out a raw path to the original.
        if ($this->isLessonMaterialPdf($bucket, $normalised)) {
            throw new ApiException(
                403,
                'Lesson PDFs are delivered as personalized copies. Open the material from the lesson screen.',
                'material_delivery_required'
            );
        }
        return ['signed_url' => $this->storage->signedUrl($bucket, $normalised, $expiresIn)];
    }

    /** Stream a public object after validating its bucket and path. */
    public function publicFile(Request $request): never
    {
        $bucket = (string) ($request->params['bucket'] ?? '');
        $path = $this->normalisePath(rawurldecode((string) ($request->params['path'] ?? '')));
        if (!in_array($bucket, self::PUBLIC_BUCKETS, true) || $path === '') {
            Response::error('Public file not found', 404, 'not_found');
        }
        $file = $this->storage->publicFilePath($bucket, $path);
        if (!is_file($file)) {
            Response::error('Public file not found', 404, 'not_found');
        }
        $mime = mime_content_type($file) ?: 'application/octet-stream';
        Response::raw((string) file_get_contents($file), 200, $mime, ['Cache-Control' => 'public, max-age=31536000, immutable']);
    }

    /**
     * GET /storage/signed?bucket=..&path=..&expires=..&sig=..
     * Validates the HMAC signature and streams the file. Public route —
     * authorisation is the signature itself.
     */
    public function signedFile(Request $request): never
    {
        $bucket = (string) ($request->query('bucket', ''));
        $path = $this->normalisePath((string) ($request->query('path', '')));
        if (!in_array($bucket, self::PRIVATE_BUCKETS, true) || $path === '' || str_contains($path, '..')) {
            Response::error('File not found', 404, 'not_found');
        }
        // Enforced at REDEMPTION too, not just when minting: a link issued
        // before this rule existed (or cached by a client) must not hand a
        // student the unwatermarked original for the rest of its TTL.
        if ($this->isLessonMaterialPdf($bucket, $path)) {
            Response::error(
                'Lesson PDFs are delivered as personalized copies. Reopen the material.',
                403,
                'material_delivery_required'
            );
        }

        $expires = (int) $request->query('expires', 0);
        $sig = (string) ($request->query('sig', ''));

        $secret = Config::string('STORAGE_SIGNED_URL_SECRET', Config::string('JWT_SECRET'));
        $expected = hash_hmac('sha256', $path . '|' . $expires, $secret);
        if (!hash_equals($expected, $sig)) {
            Response::error('Invalid signature', 403);
        }
        if ($expires < time()) {
            Response::error('Link expired', 410);
        }

        $file = MEDACADEMY_BASE . '/' . Config::string('STORAGE_PRIVATE_DIR', 'storage/private') . '/' . $path;
        if (!is_file($file)) {
            Response::error('File not found', 404);
        }
        $mime = mime_content_type($file) ?: 'application/octet-stream';
        // CONTENT DELIVERY HARDENING (documents): a lesson attachment is user-
        // supplied content served from the API's own origin. Rendering it inline
        // is what turns an uploaded .html/.svg into stored XSS against that
        // origin. Document buckets are therefore ALWAYS delivered as an
        // attachment with sniffing disabled; the app saves the bytes and hands
        // them to the OS viewer, so nothing about in-app opening changes.
        $headers = ['X-Content-Type-Options' => 'nosniff'];
        if (in_array($bucket, ['lesson-materials', 'lesson-pdfs', 'temp-uploads', 'patch-uploads'], true)) {
            $name = basename($path) !== '' ? basename($path) : 'download';
            $headers['Content-Disposition'] = 'attachment; filename="' . rawurlencode($name) . '"';
        }
        Response::raw((string) file_get_contents($file), 200, $mime, $headers);
    }

    public function upload(Request $request): array
    {
        // PHP silently empties $_POST and $_FILES when the multipart body exceeds
        // post_max_size, so distinguish that hosting-limit case from a missing file.
        if ($request->postBodyExceededLimit()) {
            throw new ApiException(413, 'Upload exceeds the server request limit. Reduce the file size or ask the host to raise post_max_size.');
        }

        // The backend client sends multipart form fields (bucket, path, file).
        // Read from $_POST first, JSON fallback for non-browser callers.
        $bucket = (string) ($_POST['bucket'] ?? $request->json()['bucket'] ?? '');
        $path = (string) ($_POST['path'] ?? $request->json()['path'] ?? $request->json()['file_name'] ?? '');
        if (!in_array($bucket, [...self::PUBLIC_BUCKETS, ...self::PRIVATE_BUCKETS], true)) {
            throw new ApiException(400, 'Invalid bucket');
        }

        $file = $request->file('file');
        if ($file === null) {
            throw new ApiException(400, 'file is required', 'upload_missing');
        }

        // Only fall back to a generated path when absent. Generated uploads
        // are scoped under the authenticated user and remain non-public unless
        // the caller explicitly selected an existing content path.
        $dest = trim($path);
        if ($dest === '') {
            $ext = pathinfo((string) ($_POST['file_name'] ?? $request->json()['file_name'] ?? ''), PATHINFO_EXTENSION);
            $dest = 'users/' . $request->user['id'] . '/' . date('Y/m/d') . '/' . Uuid::v4() . ($ext !== '' ? '.' . $ext : '');
        }

        // Storage ownership is derived from the authenticated user and the
        // existing course/profile rows; client-supplied IDs are only selectors.
        $role = (string) $request->user['role'];
        if (!$this->canWritePath((string) $request->user['id'], $role, $bucket, $dest)) {
            throw new ApiException(403, 'Not authorized to upload to this storage path');
        }

        // CONTENT POLICY (server-side): the lesson-attachment buckets advertise
        // "PDF, PPTX, DOCX, XLSX, ZIP, images, audio, and more — up to 100 MB
        // each", and until now that was enforced ONLY by the picker in the app.
        // Validate the size and the file type here so a crafted request cannot
        // park an arbitrarily large blob or an executable/script in a bucket the
        // app later serves back. Chunked VIDEO uploads (video-chunks /
        // video-uploads / temp-uploads) are deliberately exempt from the size cap
        // — they are assembled by the video pipeline, not delivered to students.
        $this->assertUploadAllowed($bucket, $file, $dest);

        // ── INTEGRITY: validate what actually arrived, then store it atomically ──
        // Previously this handler went straight from `UPLOAD_ERR_OK` to
        // `putFile()`: a successful transfer of ZERO bytes (which is what a
        // client that never read the local file sends) passed every check, was
        // moved into storage as a 0-byte object, and answered 200. The app then
        // created the material row on top of it. See UploadIntegrityService for
        // the full incident write-up; `validate()` now rejects an empty or
        // truncated body and verifies PDFs with the same parser delivery uses,
        // and `persist()` re-measures the stored object before we answer.
        $validated = $this->integrity->validate($file, $dest, $bucket);
        $public = in_array($bucket, self::PUBLIC_BUCKETS, true);
        $stored = $this->integrity->persist($validated['tmp'], $validated['size'], $bucket, $dest, $public);

        // The response now carries the MEASURED size and digest, so no caller has
        // to trust (or persist) a client-declared `file_size` any more.
        return [
            'path' => $stored['path'],
            'url' => $public
                ? $this->storage->publicUrl($bucket, $stored['path'])
                : $this->storage->signedUrl($bucket, $stored['path']),
            'size' => $stored['size'],
            'sha256' => $stored['sha256'],
            'op' => $this->integrity->opId(),
        ];
    }

    public function delete(Request $request): array
    {
        $bucket = (string) ($request->json()['bucket'] ?? '');
        $path = $this->normalisePath((string) ($request->json()['path'] ?? ''));
        if (!in_array($bucket, [...self::PUBLIC_BUCKETS, ...self::PRIVATE_BUCKETS], true) || $path === '') {
            throw new ApiException(400, 'bucket and path are required');
        }
        $role = (string) $request->user['role'];
        if (!$this->canWritePath((string) $request->user['id'], $role, $bucket, $path)) {
            throw new ApiException(403, 'Not authorized to delete this storage path');
        }
        // NOTE: this generic object delete stays permissive on purpose. Builds
        // that shipped before POST /materials/{id}/delete still remove the object
        // here and then delete the row through the data API; refusing a
        // referenced path would break "delete material" for every installed
        // client. The replacement flow (server-side, row first) is what new
        // builds use, and anything an older build leaves behind is reclaimed by
        // `storage-cleanup.php --orphans` (nothing is ever left half-deleted).
        $public = in_array($bucket, self::PUBLIC_BUCKETS, true);
        $this->storage->delete($bucket, $path, $public);
        return ['success' => true];
    }

    /**
     * Server-side content policy for the lesson-attachment buckets.
     *
     *  • SIZE — capped at LESSON_MATERIAL_MAX_BYTES (default 100 MB, the figure
     *    the upload UI already advertises). A request bigger than this is
     *    rejected before anything touches the filesystem.
     *  • TYPE — a denylist of executable / script / server-side types that must
     *    never be stored in a bucket the app serves back. The list is a denylist
     *    (not an allowlist) so the documented "and more" of ordinary documents,
     *    archives, media and images all keep working.
     */
    private function assertUploadAllowed(string $bucket, array $file, string $dest): void
    {
        if (!in_array($bucket, ['lesson-materials', 'lesson-pdfs'], true)) {
            return;
        }

        $max = Config::int('LESSON_MATERIAL_MAX_BYTES', 100 * 1024 * 1024);
        $size = (int) ($file['size'] ?? 0);
        // "$file['size']" is what PHP actually received; when it is unavailable
        // fall back to the temp file on disk so the cap cannot be bypassed.
        if ($size <= 0 && isset($file['tmp_name']) && is_file((string) $file['tmp_name'])) {
            $size = (int) filesize((string) $file['tmp_name']);
        }
        if ($size > $max) {
            throw new ApiException(413, 'File is too large. Maximum size is ' . (int) round($max / 1048576) . ' MB.');
        }

        $ext = strtolower((string) pathinfo($dest, PATHINFO_EXTENSION));
        if ($ext === '' && isset($file['name'])) {
            $ext = strtolower((string) pathinfo((string) $file['name'], PATHINFO_EXTENSION));
        }
        if ($ext === '') {
            return; // extension-less documents are harmless; size already checked
        }
        if (in_array($ext, self::BLOCKED_UPLOAD_EXTENSIONS, true)) {
            throw new ApiException(415, '.' . $ext . ' files cannot be attached to a lesson.');
        }
    }

    private function canWritePath(string $userId, string $role, string $bucket, string $path): bool
    {
        if (in_array($role, ['admin', 'super_admin'], true)) {
            return true;
        }
        if (!in_array($role, ['doctor', 'student'], true)) {
            return false;
        }

        $segments = explode('/', trim($this->normalisePath($path), '/'));
        if ($bucket === 'avatars' || $bucket === 'user-avatars') {
            $candidatePaths = [$segments[0] ?? '', $segments[1] ?? ''];
            foreach ($candidatePaths as $candidate) {
                $candidateId = (string) preg_replace('/\\.[^.]+$/', '', $candidate);
                if ($candidateId !== '' && hash_equals($userId, $candidateId)) {
                    return true;
                }
            }
            return false;
        }

        if (in_array($bucket, ['course-images', 'course-covers'], true)) {
            $courseId = $segments[0] ?? '';
            return $courseId !== '' && (bool) Database::instance()->value(
                'SELECT COUNT(*) FROM courses WHERE id = ? AND doctor_id = ?',
                [$courseId, $userId],
                0
            );
        }

        if (in_array($bucket, ['lesson-thumbnails', 'lesson-materials', 'lesson-pdfs'], true)) {
            $courseId = $segments[0] ?? '';
            $lessonId = $segments[1] ?? '';
            return $courseId !== '' && $lessonId !== '' && (bool) Database::instance()->value(
                'SELECT COUNT(*) FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = ? AND l.course_id = ? AND c.doctor_id = ?',
                [$lessonId, $courseId, $userId],
                0
            );
        }

        return false;
    }

    /**
     * True when the object is a PDF in the `lesson-materials` bucket — the only
     * documents that must always be personalized.
     *
     * The extension is checked first (uploads always keep one); the database is
     * consulted only when there is none, so this stays cheap on the hot path.
     */
    private function isLessonMaterialPdf(string $bucket, string $path): bool
    {
        if ($bucket !== 'lesson-materials') {
            return false;
        }
        if (strtolower((string) pathinfo($path, PATHINFO_EXTENSION)) === 'pdf') {
            return true;
        }
        try {
            $type = (string) Database::instance()->value(
                'SELECT file_type FROM lesson_materials WHERE storage_path = ? LIMIT 1',
                [$path],
                ''
            );
        } catch (\Throwable) {
            // Unknown type: do not block a non-PDF attachment because a query
            // failed; the extension check above already covered real PDFs.
            return false;
        }
        return stripos($type, 'pdf') !== false;
    }

    private function normalisePath(string $input): string
    {
        $input = preg_replace('#^.*/object/(?:public|sign)/[^/]+/#', '', $input) ?? $input;
        $input = preg_replace('/\?.*$/', '', $input) ?? $input;
        return $input;
    }
}
