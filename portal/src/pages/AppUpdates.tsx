import { useEffect, useState } from 'react';
import { Save, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import {
  Badge, Button, Card, ErrorState, Input, PageHeader, Select, Spinner, Switch, Textarea, useToast,
} from '../components/ui';

interface PlatformConfig {
  platform: string;
  enabled: boolean;
  exists?: boolean;
  latestVersion?: string;
  latestVersionCode?: number;
  minimumVersionCode?: number;
  updateMode?: string;
  updateUrl?: string;
  releaseNotes?: string | null;
}

export default function AppUpdates() {
  const { t } = useI18n();
  const { notify } = useToast();
  const [platform, setPlatform] = useState<'android' | 'ios'>('android');
  const [forms, setForms] = useState<Record<string, PlatformConfig>>({});
  const [saving, setSaving] = useState(false);
  useDocumentTitle(t('updates.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ platforms: PlatformConfig[] }>('/admin/app-updates', undefined, signal);
    return response.platforms ?? [];
  }, []);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, PlatformConfig> = {};
    for (const row of data) {
      next[row.platform] = {
        platform: row.platform,
        enabled: Boolean(row.enabled),
        exists: row.exists,
        latestVersion: row.latestVersion ?? '',
        latestVersionCode: row.latestVersionCode ?? 0,
        minimumVersionCode: row.minimumVersionCode ?? 0,
        updateMode: row.updateMode ?? 'FORCED',
        updateUrl: row.updateUrl ?? '',
        releaseNotes: row.releaseNotes ?? '',
      };
    }
    setForms(next);
  }, [data]);

  const current = forms[platform];

  const save = async () => {
    if (!current) return;
    setSaving(true);
    try {
      await api.put(`/admin/app-updates/${platform}`, {
        enabled: current.enabled,
        latestVersion: current.latestVersion,
        latestVersionCode: Number(current.latestVersionCode),
        minimumVersionCode: Number(current.minimumVersionCode),
        updateMode: current.updateMode,
        updateUrl: current.updateUrl,
        releaseNotes: current.releaseNotes,
      });
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

  return (
    <>
      <PageHeader title={t('updates.title')} subtitle={t('updates.subtitle')} />
      <div className="tabs" role="tablist">
        {(['android', 'ios'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={platform === value} className={platform === value ? 'active' : ''} onClick={() => setPlatform(value)}>
            {value === 'android' ? 'Android' : 'iOS'}
          </button>
        ))}
      </div>

      {!current ? <Card><p className="muted">This platform has no update configuration yet. Save a valid configuration to create it.</p></Card> : (
        <div className="two-column">
          <Card>
            <div className="card-head"><h2><Smartphone size={18} />{current.platform}</h2><Badge value={current.enabled ? 'enabled' : 'disabled'} /></div>
            <div className="stack">
              <label className="switch-row">
                <span><strong>{t('updates.enabled')}</strong><small className="muted">Below-minimum clients receive HTTP 426.</small></span>
                <Switch checked={current.enabled} label={t('updates.enabled')} onChange={(enabled) => setForms({ ...forms, [platform]: { ...current, enabled } })} />
              </label>
              <Input label={t('updates.latest')} value={current.latestVersion ?? ''} onChange={(e) => setForms({ ...forms, [platform]: { ...current, latestVersion: e.target.value } })} placeholder="2.0.1" />
              <Input label={t('updates.latestCode')} type="number" min={1} value={current.latestVersionCode ?? 0} onChange={(e) => setForms({ ...forms, [platform]: { ...current, latestVersionCode: Number(e.target.value) } })} />
              <Input label={t('updates.minimum')} type="number" min={1} value={current.minimumVersionCode ?? 0} onChange={(e) => setForms({ ...forms, [platform]: { ...current, minimumVersionCode: Number(e.target.value) } })} />
              <Select label={t('updates.mode')} value={current.updateMode ?? 'FORCED'} onChange={(e) => setForms({ ...forms, [platform]: { ...current, updateMode: e.target.value } })}>
                <option value="FORCED">FORCED</option>
                <option value="OPTIONAL">OPTIONAL</option>
              </Select>
            </div>
          </Card>
          <Card>
            <div className="card-head"><h2>{t('updates.releaseDetails')}</h2></div>
            <div className="stack">
              <Input label={t('updates.url')} type="url" value={current.updateUrl ?? ''} onChange={(e) => setForms({ ...forms, [platform]: { ...current, updateUrl: e.target.value } })} placeholder="https://..." />
              <Textarea label={t('updates.notes')} rows={10} value={current.releaseNotes ?? ''} onChange={(e) => setForms({ ...forms, [platform]: { ...current, releaseNotes: e.target.value } })} />
            </div>
          </Card>
        </div>
      )}

      <div className="sticky-actions">
        <Button variant="primary" icon={<Save size={16} />} loading={saving} disabled={!current} onClick={save}>{t('common.save')}</Button>
      </div>
    </>
  );
}
