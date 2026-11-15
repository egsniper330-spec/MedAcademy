import { useState } from 'react';
import { MonitorSmartphone, ShieldOff, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDebounced, useDocumentTitle } from '../lib/hooks';
import { formatDate } from '../lib/format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, Spinner, Table, useToast,
} from '../components/ui';

interface Device {
  id: string;
  user_id: string;
  device_name: string | null;
  platform: string | null;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  status: string | null;
  trust_level: string | null;
  last_active_at: string | null;
  registered_at: string | null;
}

export default function Devices() {
  const { t, lang } = useI18n();
  const { notify } = useToast();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [status, setStatus] = useState('');
  const [confirm, setConfirm] = useState<{ device: Device; action: 'block' | 'unblock' } | null>(null);
  const [busy, setBusy] = useState(false);

  useDocumentTitle(t('devices.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const rows = await api.get<Device[]>('/api/devices', {
      order: 'last_active_at.desc',
      limit: 300,
      ...(status ? { status: `eq.${status}` } : {}),
    }, signal);
    return Array.isArray(rows) ? rows : [];
  }, [status]);

  const rows = (data ?? []).filter((device) => {
    if (!debounced.trim()) return true;
    const needle = debounced.toLowerCase();
    return [device.device_name, device.platform, device.device_model, device.os_version, device.user_id]
      .some((value) => String(value ?? '').toLowerCase().includes(needle));
  });

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.post(`/security/devices/${confirm.device.id}/${confirm.action}`);
      notify(`Device ${confirm.action === 'block' ? 'blocked' : 'unblocked'}.`);
      setConfirm(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('devices.title')} subtitle={t('devices.subtitle')} />
      <Card padded={false}>
        <div className="toolbar toolbar-wrap">
          <input className="toolbar-search" type="search" placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
            <option value="">{t('common.status')}: {t('common.all')}</option>
            <option value="active">{t('common.active')}</option>
            <option value="blocked">{t('common.blocked')}</option>
          </select>
        </div>
        {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? <EmptyState /> : (
          <Table>
            <thead>
              <tr>
                <th>Device</th>
                <th>{t('devices.platform')}</th>
                <th>{t('devices.trust')}</th>
                <th>{t('common.status')}</th>
                <th>{t('devices.lastActive')}</th>
                <th className="align-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((device) => (
                <tr key={device.id}>
                  <td>
                    <div className="device-cell"><MonitorSmartphone size={16} /><div><strong>{device.device_name ?? 'Device'}</strong><span className="muted small">{device.device_model ?? device.user_id.slice(0, 8)}</span></div></div>
                  </td>
                  <td>{device.platform ?? '—'}{device.os_version ? ` · ${device.os_version}` : ''}</td>
                  <td><Badge tone={device.trust_level === 'trusted' ? 'green' : 'amber'}>{device.trust_level ?? 'unknown'}</Badge></td>
                  <td><Badge value={device.status ?? 'inactive'} /></td>
                  <td>{formatDate(device.last_active_at, lang, true)}</td>
                  <td className="align-end">
                    <Button
                      variant={device.status === 'blocked' ? 'secondary' : 'danger'}
                      icon={device.status === 'blocked' ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
                      onClick={() => setConfirm({ device, action: device.status === 'blocked' ? 'unblock' : 'block' })}
                    >
                      {device.status === 'blocked' ? t('devices.unblock') : t('devices.block')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm ? t(confirm.action === 'block' ? 'devices.block' : 'devices.unblock') : ''}
        message={confirm ? `${confirm.device.device_name ?? confirm.device.id}` : ''}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={run}
      />
    </>
  );
}
