/**
 * notificationCopy.ts — language-aware copy for SERVER-generated notifications.
 *
 * WHY THIS EXISTS
 * Notifications are written by the PHP backend with English title/body strings
 * (e.g. DeviceController's security notices). The `notifications` table stores
 * text, not translation keys, and `profiles` has no language column, so the
 * server cannot know the recipient's current app language at insert time.
 *
 * The safe, backward-compatible fix is client-side: recognise the STABLE,
 * server-authored titles/body templates we own and render their localized
 * equivalents. Anything unrecognised (admin broadcasts, course announcements,
 * user-authored content) passes through untouched — we never machine-translate
 * arbitrary text or rename data.
 *
 * If a future schema adds a per-user language column, the backend can emit the
 * right language directly and this map becomes a fallback for old rows.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface NotificationLike {
  title?: string | null;
  body?: string | null;
}

export interface LocalizedNotification {
  title: string;
  body: string;
}

/**
 * "Device Blocked" carries an optional reason appended to the body by the
 * backend: `...administrator. Reason: <reason>`.
 */
const DEVICE_BLOCKED_BODY =
  /^A device on your account has been blocked by an administrator\.(?:\s*Reason:\s*(.+))?$/s;

/**
 * Render a server notification in the active language when we own its copy.
 * Unrecognised notifications pass through verbatim.
 */
export function localizeNotification(
  notification: NotificationLike,
  t: Translate,
): LocalizedNotification {
  const title = String(notification.title ?? '').trim();
  const body = String(notification.body ?? '').trim();

  if (title === 'Device Blocked' || DEVICE_BLOCKED_BODY.test(body)) {
    const reason = DEVICE_BLOCKED_BODY.exec(body)?.[1]?.trim();
    return {
      title: t('notif.deviceBlocked.title'),
      body: reason
        ? t('notif.deviceBlocked.bodyReason', { reason })
        : t('notif.deviceBlocked.body'),
    };
  }

  if (title === 'Device Reset') {
    return { title: t('notif.deviceReset.title'), body: t('notif.deviceReset.body') };
  }

  if (title === 'Device Logged Out') {
    return {
      title: t('notif.deviceLoggedOut.title'),
      body: t('notif.deviceLoggedOut.body'),
    };
  }

  if (title === 'All Devices Logged Out') {
    return {
      title: t('notif.allDevicesLoggedOut.title'),
      body: t('notif.allDevicesLoggedOut.body'),
    };
  }

  return { title, body };
}
