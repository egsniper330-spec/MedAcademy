import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Save, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { PublicUser } from '../lib/api';
import {
  Badge, Button, Card, ErrorState, Input, PageHeader, Spinner, useToast,
} from '../components/ui';

export default function Profile() {
  const { signOut, refreshUser } = useAuth();
  const { t } = useI18n();
  const { notify } = useToast();
  const navigate = useNavigate();
  useDocumentTitle(t('profile.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ user: PublicUser }>('/users/me', undefined, signal);
    return response.user;
  }, []);

  const [form, setForm] = useState({ full_name: '', contact_whatsapp: '', contact_telegram: '', contact_phone: '' });
  const [saving, setSaving] = useState(false);
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setForm({
        full_name: data.full_name ?? '',
        contact_whatsapp: data.contact_whatsapp ?? '',
        contact_telegram: data.contact_telegram ?? '',
        contact_phone: data.contact_phone ?? '',
      });
    }
  }, [data]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.patch('/users/me', form);
      await refreshUser();
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    if (passwords.next.length < 8) {
      setPasswordError('Use at least 8 characters.');
      return;
    }
    if (passwords.next !== passwords.confirm) {
      setPasswordError(t('profile.passwordMismatch'));
      return;
    }
    setPasswordBusy(true);
    try {
      await api.post('/auth/change-password', {
        current_password: passwords.current,
        new_password: passwords.next,
      });
      notify('Password changed. Please sign in again.');
      await signOut();
      navigate('/login', { replace: true });
    } catch (e) {
      setPasswordError(errorMessage(e));
    } finally {
      setPasswordBusy(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <>
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />
      <div className="two-column">
        <Card>
          <div className="card-head"><h2>{t('profile.fullName')}</h2><Badge value={data?.role} /></div>
          <form onSubmit={save} className="stack">
            <Input label={t('profile.fullName')} required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <Input label={t('common.email')} value={data?.email ?? ''} disabled hint={t('profile.emailHint')} />
            <Input label={t('profile.whatsapp')} value={form.contact_whatsapp} onChange={(e) => setForm({ ...form, contact_whatsapp: e.target.value })} />
            <Input label={t('profile.telegram')} value={form.contact_telegram} onChange={(e) => setForm({ ...form, contact_telegram: e.target.value })} />
            <Input label={t('profile.contactPhone')} value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
            <Button type="submit" variant="primary" icon={<Save size={16} />} loading={saving} disabled={!data}>{t('common.save')}</Button>
          </form>
        </Card>

        <Card>
          <div className="card-head"><h2>{t('profile.password')}</h2><ShieldCheck size={18} /></div>
          <form onSubmit={changePassword} className="stack">
            <Input label={t('profile.currentPassword')} type="password" autoComplete="current-password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} />
            <Input label={t('profile.newPassword')} type="password" autoComplete="new-password" required value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} />
            <Input label={t('profile.confirmPassword')} type="password" autoComplete="new-password" required value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
            {passwordError && <div className="inline-error">{passwordError}</div>}
            <p className="muted small">{t('profile.passwordHint')}</p>
            <Button type="submit" variant="primary" icon={<KeyRound size={16} />} loading={passwordBusy}>{t('profile.changePassword')}</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
