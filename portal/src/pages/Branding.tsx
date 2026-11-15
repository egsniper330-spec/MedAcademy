import { useEffect, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { Button, Card, ErrorState, Input, PageHeader, Spinner, useToast } from '../components/ui';

const TEXT_FIELDS = [
  ['app_name', 'branding.appName', true],
  ['contact_email', 'branding.contactEmail', false],
  ['support_email', 'branding.supportEmail', false],
  ['contact_phone', 'branding.contactPhone', false],
  ['website_url', 'branding.website', false],
  ['logo_url', 'branding.logo', false],
  ['splash_logo_url', 'Splash logo URL', false],
  ['facebook_url', 'Facebook URL', false],
  ['instagram_url', 'Instagram URL', false],
  ['youtube_url', 'YouTube URL', false],
  ['telegram_url', 'Telegram URL', false],
  ['whatsapp_url', 'WhatsApp URL', false],
  ['twitter_url', 'X / Twitter URL', false],
  ['linkedin_url', 'LinkedIn URL', false],
] as const;

export default function Branding() {
  const { t } = useI18n();
  const { notify } = useToast();
  useDocumentTitle(t('branding.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ branding: Record<string, unknown> }>('/platform/branding', undefined, signal);
    return response.branding;
  }, []);

  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const [key] of TEXT_FIELDS) next[key] = String(data[key] ?? '');
    next.primary_color = String(data.primary_color ?? '#1565C0');
    next.secondary_color = String(data.secondary_color ?? '#0D47A1');
    setForm(next);
  }, [data]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.put('/platform/branding', form);
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
      <PageHeader title={t('branding.title')} subtitle={t('branding.subtitle')} />
      <form onSubmit={save}>
        <div className="two-column">
          <Card>
            <div className="card-head"><h2>{t('branding.identity')}</h2></div>
            <div className="stack">
              <Input label={t('branding.appName')} required value={form.app_name ?? ''} onChange={(e) => setForm({ ...form, app_name: e.target.value })} />
              <div className="color-row">
                <label className="field"><span>{t('branding.primary')}</span><input type="color" value={form.primary_color ?? '#1565C0'} onChange={(e) => setForm({ ...form, primary_color: e.target.value })} /></label>
                <label className="field"><span>{t('branding.secondary')}</span><input type="color" value={form.secondary_color ?? '#0D47A1'} onChange={(e) => setForm({ ...form, secondary_color: e.target.value })} /></label>
              </div>
              <Input label={t('branding.logo')} type="url" value={form.logo_url ?? ''} onChange={(e) => setForm({ ...form, logo_url: e.target.value })} />
              <Input label={t('branding.splash')} type="url" value={form.splash_logo_url ?? ''} onChange={(e) => setForm({ ...form, splash_logo_url: e.target.value })} />
            </div>
          </Card>
          <Card>
            <div className="card-head"><h2>{t('branding.contactLinks')}</h2></div>
            <div className="stack">
              {TEXT_FIELDS.filter(([key]) => !['app_name', 'logo_url', 'splash_logo_url'].includes(key)).map(([key, label]) => (
                <Input key={key} label={t(label)} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              ))}
            </div>
          </Card>
        </div>
        <div className="sticky-actions">
          <Button type="submit" variant="primary" icon={<Save size={16} />} loading={saving}>{t('common.save')}</Button>
        </div>
      </form>
    </>
  );
}
