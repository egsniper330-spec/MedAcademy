<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\MaterialFileCleanupService;
use MedAcademy\Services\UploadIntegrityService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Uuid;
use Throwable;

/**
 * LessonMaterialController — the server-side lifecycle of ONE lesson attachment.
 *
 * ── WHY THESE ENDPOINTS EXIST ──────────────────────────────────────────────
 * Deleting and replacing an attachment used to be orchestrated entirely by the
 * app:
 *
 *   delete  → `storage.remove([path])` … then `DELETE /api/lesson_materials?id=…`
 *   replace → upload the new object … then `storage.remove([old])` … then PATCH
 *
 * Both sequences are wrong in ways the client cannot fix:
 *
 *   • the OLD FILE was removed BEFORE the database commit, so any failure in
 *     between left a material pointing at bytes that no longer existed
 *     ("download failed — file not found");
 *   • the generated, watermarked per-student copies were never touched at all,
 *     so they accumulated in private storage forever (and could still be served
 *     from the variant registry after the source changed);
 *   • `storage.remove` authorises by path alone, so the deletion half had a
 *     weaker notion of ownership than the row it was deleting.
 *
 * These handlers make the ROW the subject of the operation: ownership is decided
 * from the row (course → doctor), the row and its generated copies are committed
 * first, and only then are the files reclaimed by MaterialFileCleanupService.
 * A failed filesystem operation is recorded for retry instead of corrupting the
 * material.
 *
 * Uploads themselves stay on `POST /storage/upload` (unchanged contract, now
 * with integrity validation); a replacement is therefore: upload the new object
 * → call `/materials/{id}/replace` with that path.
 */
final class LessonMaterialController
{
    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly UploadIntegrityService $integrity = new UploadIntegrityService(),
        private readonly MaterialFileCleanupService $cleanup = new MaterialFileCleanupService(),
    ) {
    }

    /**
     * POST /materials/{id}/delete
     *
     * Deletes the material row, its generated copies and the underlying source
     * object. Idempotent in the sense that a missing FILE never fails the call —
     * only a missing ROW does (404), because there is nothing left to authorise.
     */
    public function delete(Request $request): array
    {
        $materialId = $this->materialId($request);
        $material = $this->loadMaterial($materialId);
        $this->assertCanManage($request, $material);

        // Snapshot BEFORE the delete: `lesson_material_pdfs` rows cascade with
        // the material row, so afterwards the paths would be unrecoverable.
        $snapshot = $this->cleanup->snapshotMaterial($materialId);

        Database::instance()->transaction(function (Database $db) use ($materialId): void {
            try {
                $db->query('DELETE FROM lesson_material_pdfs WHERE material_id = ?', [$materialId]);
            } catch (Throwable) {
                // Migration 032 not applied — nothing to cascade.
            }
            $db->query('DELETE FROM lesson_materials WHERE id = ?', [$materialId]);
        });

        // Post-commit: bytes only. A failure here is queued for retry, never
        // resurrected as a failed delete.
        $files = $snapshot === null
            ? ['deleted' => 0, 'bytes' => 0, 'skipped' => 0, 'failed' => [], 'queued' => false]
            : $this->cleanup->retire([$snapshot], 'material_delete', (string) $request->user['id']);

        AuditService::write($request->user['id'], 'pdf_deleted', [
            'operation' => 'material_delete',
            'material_id' => $materialId,
            'lesson_id' => $material['lesson_id'] ?? null,
            'course_id' => $material['course_id'] ?? null,
            'file_name' => $material['file_name'] ?? null,
            'files_deleted' => $files['deleted'],
            'storage_bytes_freed' => $files['bytes'],
            'cleanup_queued' => $files['queued'],
            'log_status' => $files['failed'] === [] ? 'success' : 'partial',
        ]);

        return [
            'success' => true,
            'material_id' => $materialId,
            'files_deleted' => $files['deleted'],
            'storage_bytes_freed' => $files['bytes'],
            // TRUE means: the rows are gone, but the filesystem refused some
            // unlinks and they are queued for `storage-cleanup.php --retry`.
            'cleanup_queued' => $files['queued'],
        ];
    }

    /**
     * POST /materials/{id}/replace
     * Body: { storage_path (required), file_name, file_type }
     *
     * The new object must ALREADY be uploaded (POST /storage/upload). Order:
     *   1. verify the new object exists and is a real document (size + PDF),
     *   2. commit the row change (+ reset the source-hash cache),
     *   3. reclaim the previous source and its stale personalized copies.
     *
     * A failure at 1 or 2 leaves the old file and the old row exactly as they
     * were, so the material stays downloadable.
     */
    public function replace(Request $request): array
    {
        $materialId = $this->materialId($request);
        $material = $this->loadMaterial($materialId);
        $this->assertCanManage($request, $material);

        $body = $request->json();
        $newPath = trim((string) ($body['storage_path'] ?? ''));
        if ($newPath === '') {
            throw new ApiException(400, 'storage_path is required', 'missing_storage_path');
        }

        $oldPath = (string) ($material['storage_path'] ?? '');
        if ($newPath === $oldPath) {
            throw new ApiException(400, 'The new file is the same object as the current one.', 'same_path');
        }

        // The replacement must live under THIS course/lesson prefix. Without this
        // a caller could point a material at another course's object (the upload
        // route authorises writes by prefix, so this is the matching read gate).
        $courseId = (string) ($material['course_id'] ?? '');
        $lessonId = (string) ($material['lesson_id'] ?? '');
        if ($courseId === '' || $lessonId === '' || !str_starts_with($newPath, $courseId . '/' . $lessonId . '/')) {
            throw new ApiException(422, 'The uploaded file does not belong to this lesson.', 'path_out_of_scope');
        }
        if (str_contains($newPath, '..')) {
            throw new ApiException(400, 'Invalid path', 'path_out_of_scope');
        }
        if ($this->isPathUsedByAnotherMaterial($newPath, $materialId)) {
            throw new ApiException(422, 'That file is already attached to another material.', 'path_in_use');
        }

        $fileName = trim((string) ($body['file_name'] ?? ''));
        if ($fileName === '') {
            $fileName = basename($newPath);
        }
        $fileType = trim((string) ($body['file_type'] ?? '')) ?: (string) ($material['file_type'] ?? 'application/octet-stream');

        // Size and validity come from the STORED object, never from the request.
        $isPdf = strtolower((string) pathinfo($newPath, PATHINFO_EXTENSION)) === 'pdf'
            || stripos($fileType, 'pdf') !== false;
        $stored = $this->integrity->inspectStored(MaterialFileCleanupService::BUCKET, $newPath, $isPdf);

        // Personalized copies of the PREVIOUS source must not survive the swap.
        $snapshot = $this->cleanup->snapshotMaterial($materialId);

        $this->updateRow($materialId, $fileName, $newPath, $fileType, $stored['size']);

        // Only after the row committed may the old bytes go.
        $files = $snapshot === null
            ? ['deleted' => 0, 'bytes' => 0, 'skipped' => 0, 'failed' => [], 'queued' => false]
            : $this->cleanup->retire([$snapshot], 'material_replace', (string) $request->user['id']);

        AuditService::write($request->user['id'], 'pdf_uploaded', [
            'operation' => 'material_replace',
            'material_id' => $materialId,
            'lesson_id' => $material['lesson_id'] ?? null,
            'course_id' => $material['course_id'] ?? null,
            'file_name' => $fileName,
            'file_size' => $stored['size'],
            'sha256' => $stored['sha256'],
            'storage_bytes_freed' => $files['bytes'],
            'cleanup_queued' => $files['queued'],
            'log_status' => $files['failed'] === [] ? 'success' : 'partial',
        ]);

        // Return the FULL updated row: the app replaces its local material object
        // with this response, and it still needs permission / download_enabled /
        // lesson_id / order_index to render the row and its menu.
        $fresh = Database::instance()->row('SELECT * FROM lesson_materials WHERE id = ? LIMIT 1', [$materialId]) ?? [];

        return $fresh + [
            'success' => true,
            'material_id' => $materialId,
            'file_size' => $stored['size'],
            'sha256' => $stored['sha256'],
            'previous_files_reclaimed' => $files['deleted'],
            'cleanup_queued' => $files['queued'],
        ];
    }


    // ── Internals ────────────────────────────────────────────────────────────

    private function materialId(Request $request): string
    {
        $raw = trim((string) ($request->params['id'] ?? ''));
        if ($raw === '') {
            throw new ApiException(400, 'material id is required');
        }
        // Accepts a bare uuid or a normalized one; anything else cannot match a row.
        return Uuid::normalize($raw);
    }

    /** @return array<string,mixed> */
    private function loadMaterial(string $materialId): array
    {
        $row = Database::instance()->row(
            'SELECT id, lesson_id, course_id, file_name, file_type, file_size, storage_path
               FROM lesson_materials WHERE id = ? LIMIT 1',
            [$materialId]
        );
        if ($row === null) {
            throw new ApiException(404, 'Material not found', 'material_not_found');
        }
        return $row;
    }

    /**
     * Ownership is decided from the ROW: staff may manage any material, a doctor
     * only one belonging to a course they own. A student can never reach these
     * handlers (route role gate) and would fail here anyway.
     *
     * @param array<string,mixed> $material
     */
    private function assertCanManage(Request $request, array $material): void
    {
        $role = (string) ($request->user['role'] ?? '');
        if (in_array($role, ['admin', 'super_admin'], true)) {
            return;
        }
        if ($role !== 'doctor') {
            throw new ApiException(403, 'Access denied');
        }
        $userId = (string) ($request->user['id'] ?? '');
        $owns = (bool) Database::instance()->value(
            'SELECT COUNT(*) FROM courses WHERE id = ? AND doctor_id = ?',
            [(string) ($material['course_id'] ?? ''), $userId],
            0
        );
        if (!$owns) {
            throw new ApiException(403, 'Access denied');
        }
    }

    private function isPathUsedByAnotherMaterial(string $storagePath, string $excludingMaterialId): bool
    {
        return (bool) Database::instance()->value(
            'SELECT COUNT(*) FROM lesson_materials WHERE storage_path = ? AND id <> ?',
            [$storagePath, $excludingMaterialId],
            0
        );
    }

    /**
     * Persist the swap. The source-hash cache is cleared so the next delivery
     * re-digests the new bytes — a stale digest would keep serving variants
     * generated from the replaced document.
     */
    private function updateRow(string $materialId, string $fileName, string $storagePath, string $fileType, int $size): void
    {
        $base = 'UPDATE lesson_materials
                    SET file_name = ?, file_url = ?, storage_path = ?, file_type = ?, file_size = ?,
                        updated_at = UTC_TIMESTAMP(6)';
        $params = [$fileName, $storagePath, $storagePath, $fileType, $size];

        // Migration 035 may not be applied yet: try the full reset, then the
        // three-column form, then the plain update (same fallback chain the
        // delivery controller uses when READING these columns).
        $attempts = [
            $base . ', file_hash = NULL, file_hash_path = NULL, file_hash_size = NULL, file_hash_mtime = NULL WHERE id = ?',
            $base . ', file_hash = NULL, file_hash_path = NULL, file_hash_size = NULL WHERE id = ?',
            $base . ' WHERE id = ?',
        ];
        $last = null;
        foreach ($attempts as $sql) {
            try {
                Database::instance()->query($sql, [...$params, $materialId]);
                return;
            } catch (Throwable $e) {
                $last = $e;
            }
        }
        throw new ApiException(500, 'The material could not be updated.', 'schema', $last);
    }
}
