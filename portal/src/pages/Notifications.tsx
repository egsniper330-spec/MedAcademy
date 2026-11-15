import { Bell, CheckCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate } from '../lib/format';
import {
  Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, useToast,
} from '../components/ui';

interface Notification {
  id: string;
  title: string;
  body: string | null;
  notification_type: string | null;
  is_read: number | boolean;
  created_at: string;
}

export default function Notifications() {
  const { t, lang } = useI18n();
  const { notify } = useToast();
  useDocumentTitle(t('notifications.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ notifications: Notification[] }>('/notifications', undefined, signal);
    return response.notifications ?? [];
  }, []);

  const rows = data ?? [];
  const unread = rows.filter((row) => !Number(row.is_read)).map((row) => row.id);

  const mark = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await api.post('/notifications/read', { ids });
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
        actions={<Button icon={<CheckCheck size={16} />} disabled={unread.length === 0} onClick={() => void mark(unread)}>{t('notifications.markAll')}</Button>}
      />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? <Card><EmptyState title={t('common.empty')} /></Card> : (
        <div className="notification-list">
          {rows.map((notification) => {
            const isUnread = !Number(notification.is_read);
            return (
              <Card key={notification.id} className={`notification-card ${isUnread ? 'unread' : ''}`}>
                <div className="notification-icon"><Bell size={18} /></div>
                <div className="notification-body">
                  <div className="notification-head">
                    <strong>{notification.title}</strong>
                    {isUnread && <Badge tone="blue">{t('common.unread')}</Badge>}
                  </div>
                  {notification.body && <p>{notification.body}</p>}
                  <span className="muted small">{notification.notification_type ?? 'notification'} · {formatDate(notification.created_at, lang, true)}</span>
                </div>
                {isUnread && <Button variant="ghost" onClick={() => void mark([notification.id])}>{t('common.markRead')}</Button>}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
