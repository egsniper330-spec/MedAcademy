<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

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

    /**
     * GET /storage/signed?bucket=..&path=..&expires=..&sig=..
     * Validates the HMAC signature and streams the file. Public route —
     * authorisation is the signature itself.
     */
    public function signedFile(Request $request): never
    {
        $bucket = (string) ($request->query('bucket', ''));
        $path = (string) ($request->query('path', ''));
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
        // The Supabase-compatible client sends multipart form fields (bucket,
        // path, file) — NOT a JSON body. Read from $_POST first, JSON fallback.
        $bucket = (string) ($_POST['bucket'] ?? $request->json()['bucket'] ?? '');
        $path = (string) ($_POST['path'] ?? $request->json()['path'] ?? $request->json()['file_name'] ?? '');
        if (!in_array($bucket, [...self::PUBLIC_BUCKETS, ...self::PRIVATE_BUCKETS], true)) {
            throw new ApiException(400, 'Invalid bucket');
        }

        $file = $request->file('file');
        if ($file === null || ($file['error'] ?? 1) !== UPLOAD_ERR_OK) {
            throw new ApiException(400, 'file is required');
        }

        // doctor/admin uploads only for content buckets
        $role = $request->user['role'];
        $contentBuckets = ['course-images', 'course-covers', 'lesson-thumbnails', 'lesson-materials', 'lesson-pdfs', 'video-chunks'];
        if (in_array($bucket, $contentBuckets, true) && !in_array($role, ['doctor', 'admin', 'super_admin'], true)) {
            throw new ApiException(403, 'Not authorized to upload to this bucket');
        }

        // Honour the client-supplied path (the caller stores it in the DB and
        // later fetches by it). Only fall back to a generated path when absent.
        $dest = trim($path);
        if ($dest === '') {
            $ext = pathinfo((string) ($_POST['file_name'] ?? $request->json()['file_name'] ?? ''), PATHINFO_EXTENSION);
            $dest = date('Y/m/d') . '/' . Uuid::v4() . ($ext !== '' ? '.' . $ext : '');
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
        $path = (string) ($request->json()['path'] ?? '');
        $public = in_array($bucket, self::PUBLIC_BUCKETS, true);
        $this->storage->delete($bucket, $path, $public);
        return ['success' => true];
    }

    private function normalisePath(string $input): string
    {
        $input = preg_replace('#^.*/object/(?:public|sign)/[^/]+/#', '', $input) ?? $input;
        $input = preg_replace('/\?.*$/', '', $input) ?? $input;
        return $input;
    }
}
