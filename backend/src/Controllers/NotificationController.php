<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Utils\Uuid;

final class NotificationController
{
    public function index(Request $request): array
    {
        return [
            'notifications' => Database::instance()->select(
                'SELECT id, title, body, notification_type, is_read, created_at
                   FROM notifications
                  WHERE user_id = ?
                  ORDER BY created_at DESC LIMIT 100',
                [$request->user['id']]
            ),
        ];
    }

    public function markRead(Request $request): array
    {
        $ids = $request->json()['ids'] ?? [];
        if (!is_array($ids) || $ids === []) {
            throw new ApiException(422, 'ids is required');
        }
        $userId = $request->user['id'];
        foreach ($ids as $id) {
            Database::instance()->query(
                'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
                [Uuid::normalize((string) $id), $userId]
            );
        }
        return ['success' => true];
    }
}
