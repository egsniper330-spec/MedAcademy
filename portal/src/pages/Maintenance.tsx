import { useEffect, useState } from 'react';
import { AlertTriangle, Save, Wrench } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import {
  Button, Card, ConfirmDialog, ErrorState, PageHeader, Spinner, Switch, Textarea, useToast,
} from '../components/ui';

interface Config { enabled: boolean; message: string; retryAfter?: number; whitelist_count?: number }

export default function Maintenance() {
  const { t } = useI18n();
  const { notify } = useToast();
  useDocumentTitle(t('maintenance.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<Config>('/admin/maintenance', undefined, signal);
    return response;
  }, []);

  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setEnabled(Boolean(data.enabled));
      setMessage(data.message ?? '');
    }
  }, [data]);

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/admin/maintenance', { enabled, message });
      notify(`Maintenance mode ${enabled ? 'enabled' : 'disabled'}.`);
      setConfirm(false);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <>
      <PageHeader title={t('maintenance.title')} subtitle={t('maintenance.subtitle')} />
      <Card className={enabled ? 'danger-card' : ''}>
        <div className="maintenance-head">
          <div className={`status-orb ${enabled ? 'on' : ''}`}><Wrench size={22} /></div>
          <div>
            <h2>{enabled ? 'Maintenance mode is ON' : 'Platform is live'}</h2>
            <p className="muted">Non-exempt API traffic is {enabled ? 'currently paused' : 'flowing normally'}. Super Admins keep access.</p>
          </div>
          <Switch checked={enabled} label={t('maintenance.enabled')} onChange={setEnabled} />
        </div>

        {enabled && (
          <div className="notice warning"><AlertTriangle size={17} />{t('maintenance.warning')}</div>
        )}

        <div className="stack">
          <Textarea label={t('maintenance.message')} rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} hint={`${message.length}/500`} />
          <Button variant={enabled ? 'danger' : 'primary'} icon={<Save size={16} />} loading={saving} onClick={() => setConfirm(true)}>{t('common.save')}</Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirm}
        title={t('maintenance.title')}
        message={enabled ? t('maintenance.warning') : 'Disable maintenance mode and resume normal traffic?'}
        confirmLabel={t('common.confirm')}
        tone={enabled ? 'danger' : 'primary'}
        busy={saving}
        onCancel={() => setConfirm(false)}
        onConfirm={save}
      />
    </>
  );
}
