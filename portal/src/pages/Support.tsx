import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import {
  Button, Card, ErrorState, Input, PageHeader, Spinner, Switch, useToast,
} from '../components/ui';

interface Setting { key: string; value: string; label: string; enabled: boolean; display_order: number }

const ORDER = ['whatsapp', 'facebook', 'instagram', 'telegram', 'email', 'phone', 'x', 'website'];

export default function Support() {
  const { t } = useI18n();
  const { notify } = useToast();
  useDocumentTitle(t('support.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ settings: Record<string, Setting> }>('/admin/support-settings', undefined, signal);
    return response.settings ?? {};
  }, []);

  const [settings, setSettings] = useState<Record<string, Setting>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, Setting> = {};
    for (const [key, value] of Object.entries(data)) {
      next[key] = { ...value, enabled: Boolean(value.enabled) };
    }
    setSettings(next);
  }, [data]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/admin/support-settings', { settings });
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const keys = Array.from(new Set([...ORDER.filter((key) => settings[key]), ...Object.keys(settings)]));

  return (
    <>
      <PageHeader
        title={t('support.title')}
        subtitle={t('support.subtitle')}
        actions={<Button variant="primary" icon={<Save size={16} />} loading={saving} onClick={save}>{t('common.save')}</Button>}
      />
      <Card padded={false}>
        <div className="support-list">
          {keys.map((key) => {
            const setting = settings[key];
            if (!setting) return null;
            return (
              <div key={key} className="support-row">
                <div className="support-platform">
                  <strong>{setting.label || key}</strong>
                  <code className="code">{key}</code>
                </div>
                <Input
                  label={t('support.value')}
                  value={setting.value}
                  onChange={(e) => setSettings({ ...settings, [key]: { ...setting, value: e.target.value } })}
                  placeholder={key === 'email' ? 'support@example.com' : key === 'phone' ? '+20...' : 'https://...'}
                />
                <Input
                  label={t('support.label')}
                  value={setting.label}
                  onChange={(e) => setSettings({ ...settings, [key]: { ...setting, label: e.target.value } })}
                />
                <div className="support-toggle">
                  <span className="muted small">{t('support.enabled')}</span>
                  <Switch checked={setting.enabled} label={key} onChange={(enabled) => setSettings({ ...settings, [key]: { ...setting, enabled } })} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
