<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

final class StorageController
{
    private const PUBLIC_BUCKETS = ['avatars', 'user-avatars', 'course-images', 'course-covers', 'lesson-thumbnails', 'video-thumbnails', 'app-assets'];
    private const PRIVATE_BUCKETS = ['lesson-pdfs', 'lesson-materials', 'video-chunks', 'video-uploads', 'temp-uploads', 'patch-uploads'];

    public function __construct(private readonly StorageService $storage = new StorageService())
    {
    }

    /** Return bucket metadata only; file contents and private paths remain protected. */
    public function buckets(Request $request): array
    {
        return array_map(
            static fn (string $name): array => [
                'id' => $name,
                'name' => $name,
                'public' => in_array($name, self::PUBLIC_BUCKETS, true),
            ],
            [...self::PUBLIC_BUCKETS, ...self::PRIVATE_BUCKETS]
        );
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

        $normalised = $this->normalisePath($path);
        if (!$this->storage->canAccess($request->user['id'], $request->user['role'], $bucket, $normalised)) {
            throw new ApiException(403, 'Access denied');
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
        Response::raw((string) file_get_contents($file), 200, $mime);
    }

    public function upload(Request $request): array
    {
        // The backend client sends multipart form fields (bucket, path, file).
        // Read from $_POST first, JSON fallback for non-browser callers.
        $bucket = (string) ($_POST['bucket'] ?? $request->json()['bucket'] ?? '');
        $path = (string) ($_POST['path'] ?? $request->json()['path'] ?? $request->json()['file_name'] ?? '');
        if (!in_array($bucket, [...self::PUBLIC_BUCKETS, ...self::PRIVATE_BUCKETS], true)) {
            throw new ApiException(400, 'Invalid bucket');
        }

        $file = $request->file('file');
        if ($file === null || ($file['error'] ?? 1) !== UPLOAD_ERR_OK) {
            throw new ApiException(400, 'file is required');
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

        $public = in_array($bucket, self::PUBLIC_BUCKETS, true);
        $this->storage->putFile($bucket, $dest, (string) $file['tmp_name'], $public);

        return [
            'path' => $dest,
            'url' => $public ? $this->storage->publicUrl($bucket, $dest) : $this->storage->signedUrl($bucket, $dest),
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
        $public = in_array($bucket, self::PUBLIC_BUCKETS, true);
        $this->storage->delete($bucket, $path, $public);
        return ['success' => true];
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

    private function normalisePath(string $input): string
    {
        $input = preg_replace('#^.*/object/(?:public|sign)/[^/]+/#', '', $input) ?? $input;
        $input = preg_replace('/\?.*$/', '', $input) ?? $input;
        return $input;
    }
}
