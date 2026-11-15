import { useMemo, useState } from 'react';
import { canManageAccount } from '../lib/permissions';
import { KeyRound, MonitorSmartphone, Search, ShieldAlert, Trash2, UserCog, UserX } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useAsync, useDebounced, useDocumentTitle } from '../lib/hooks';
import { downloadCsv, formatDate, formatNumber } from '../lib/format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Input, Modal, PageHeader,
  Select, Spinner, Table, useToast,
} from '../components/ui';

interface User {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  phone_e164: string | null;
  role: string;
  status: string;
  watermark_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface Device {
  id: string;
  device_name?: string | null;
  platform?: string | null;
  status?: string | null;
  trust_level?: string | null;
  last_active_at?: string | null;
  registered_at?: string | null;
}

interface UserDetail extends User {
  devices?: Device[];
  credits?: { allocated?: number; consumed?: number; remaining?: number } | null;
}

const ROLES = ['student', 'doctor', 'assistant', 'admin', 'super_admin'];
const STATUSES = ['active', 'suspended', 'blocked', 'trashed'];

export default function Users() {
  const { user: actor } = useAuth();
  const { t, lang } = useI18n();
  const { notify } = useToast();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<User | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState<{ action: 'role' | 'status' | 'block' | 'restore' | 'reset-devices' | 'password' | 'trash'; title: string; message: string } | null>(null);

  const isSuperAdmin = actor?.role === 'super_admin';
  useDocumentTitle(t('users.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ users: User[] }>('/admin/users', {
      search: debouncedSearch.trim(),
      role,
      status,
      limit: 500,
    }, signal);
    return response.users ?? [];
  }, [debouncedSearch, role, status]);

  const users = data ?? [];

  const openDetail = async (user: User) => {
    setSelected(user);
    setDetail(null);
    setDetailLoading(true);
    setNewRole(user.role);
    setNewStatus(user.status);
    setPassword('');
    try {
      const response = await api.get<{ user: UserDetail }>(`/admin/users/${user.id}`);
      setDetail(response.user);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelected(null);
    setDetail(null);
    setConfirm(null);
  };

  /** Admins may not touch administrator accounts; only Super Admin can. */
  const canManageTarget = (target: User | null) => Boolean(target) && canManageAccount(actor?.role, target!.role);

  const rolesForTarget = useMemo(() => {
    if (isSuperAdmin) return ROLES;
    return ['student', 'doctor', 'assistant'];
  }, [isSuperAdmin]);

  const execute = async () => {
    if (!confirm || !selected) return;
    setBusy(true);
    try {
      switch (confirm.action) {
        case 'role':
          await api.post(`/admin/users/${selected.id}/role`, { role: newRole });
          break;
        case 'status':
          await api.post(`/admin/users/${selected.id}/status`, { status: newStatus });
          break;
        case 'block':
          await api.post(`/admin/users/${selected.id}/block`, { reason: 'Blocked from staff portal' });
          break;
        case 'restore':
          await api.post(`/admin/users/${selected.id}/restore`);
          break;
        case 'reset-devices':
          await api.post(`/admin/users/${selected.id}/devices/reset`);
          break;
        case 'password':
          await api.post('/auth/admin/change-password', { target_user_id: selected.id, new_password: password });
          break;
        case 'trash':
          await api.post(`/users/${selected.id}/trash`, { reason: 'Moved to trash from staff portal' });
          break;
      }
      notify(t('common.success'));
      setConfirm(null);
      setPassword('');
      reload();
      await openDetail(selected);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={<Button icon={<Search size={16} />} onClick={() => downloadCsv('users.csv', users as unknown as Record<string, unknown>[])} disabled={users.length === 0}>{t('common.export')}</Button>}
      />

      <Card padded={false}>
        <div className="toolbar toolbar-wrap">
          <input className="toolbar-search" type="search" placeholder={t('users.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('common.role')}>
            <option value="">{t('common.role')}: {t('common.all')}</option>
            {ROLES.map((value) => <option key={value} value={value}>{t(`common.${value === 'super_admin' ? 'superAdmin' : value}`)}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {STATUSES.map((value) => <option key={value} value={value}>{t(`common.${value}`)}</option>)}
          </select>
        </div>

        {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : users.length === 0 ? <EmptyState title={t('common.noResults')} /> : (
          <Table className="users-table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.email')}</th>
                <th>{t('common.phone')}</th>
                <th>{t('common.role')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.joined')}</th>
                <th className="align-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={selected?.id === user.id ? 'selected-row' : ''}>
                  <td className="user-name">
                    <button type="button" className="button-link" onClick={() => void openDetail(user)}>{user.full_name ?? '—'}</button>
                    <div className="muted small">{user.watermark_id ?? user.id.slice(0, 8)}</div>
                  </td>
                  <td data-label={t('common.email')}>{user.email ?? '—'}</td>
                  <td data-label={t('common.phone')}>{user.phone_e164 ?? user.phone ?? '—'}</td>
                  <td data-label={t('common.role')}><Badge value={user.role} /></td>
                  <td data-label={t('common.status')}><Badge value={user.status} /></td>
                  <td data-label={t('common.joined')}>{formatDate(user.created_at, lang)}</td>
                  <td className="align-end user-actions">
                    <Button variant="ghost" icon={<UserCog size={15} />} onClick={() => void openDetail(user)}>{t('common.details')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={Boolean(selected)}
        onClose={closeDetail}
        title={detail?.full_name ?? selected?.full_name ?? t('users.detail')}
        wide
        footer={<Button onClick={closeDetail}>{t('common.close')}</Button>}
      >
        {detailLoading ? <Spinner /> : !detail ? <EmptyState title={t('common.error')} /> : (
          <div className="user-detail">
            <div className="detail-grid">
              <div><span>{t('common.email')}</span><strong>{detail.email ?? '—'}</strong></div>
              <div><span>{t('common.phone')}</span><strong>{detail.phone_e164 ?? detail.phone ?? '—'}</strong></div>
              <div><span>{t('common.role')}</span><Badge value={detail.role} /></div>
              <div><span>{t('common.status')}</span><Badge value={detail.status} /></div>
              <div><span>{t('common.joined')}</span><strong>{formatDate(detail.created_at, lang, true)}</strong></div>
              <div><span>{t('common.updated')}</span><strong>{formatDate(detail.updated_at, lang, true)}</strong></div>
            </div>

            {detail.credits && (
              <div className="mini-stats">
                <span>{t('credits.allocated')}: <strong>{formatNumber(detail.credits.allocated ?? 0, lang)}</strong></span>
                <span>{t('credits.consumed')}: <strong>{formatNumber(detail.credits.consumed ?? 0, lang)}</strong></span>
                <span>{t('credits.balance')}: <strong>{formatNumber(detail.credits.remaining ?? 0, lang)}</strong></span>
              </div>
            )}

            {!canManageTarget(detail) && (
              <div className="notice warning"><ShieldAlert size={17} />{t('users.adminOnly')}</div>
            )}

            <div className="detail-actions">
              <div className="inline-form">
                <Select label={t('common.role')} value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={!canManageTarget(detail)}>
                  {rolesForTarget.map((value) => <option key={value} value={value}>{t(`common.${value === 'super_admin' ? 'superAdmin' : value}`)}</option>)}
                </Select>
                <Button disabled={!canManageTarget(detail) || newRole === detail.role} onClick={() => setConfirm({
                  action: 'role',
                  title: t('users.changeRole'),
                  message: `${t('users.roleWarning')} ${detail.full_name}: ${detail.role} → ${newRole}`,
                })}>{t('users.changeRole')}</Button>
              </div>

              <div className="inline-form">
                <Select label={t('common.status')} value={newStatus} onChange={(e) => setNewStatus(e.target.value)} disabled={!canManageTarget(detail)}>
                  {STATUSES.map((value) => <option key={value} value={value}>{t(`common.${value}`)}</option>)}
                </Select>
                <Button disabled={!canManageTarget(detail) || newStatus === detail.status} onClick={() => setConfirm({
                  action: 'status',
                  title: t('users.changeStatus'),
                  message: `${detail.full_name}: ${detail.status} → ${newStatus}`,
                })}>{t('users.changeStatus')}</Button>
              </div>

              <div className="inline-form">
                <Input label={t('users.newPassword')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!canManageTarget(detail)} />
                <Button icon={<KeyRound size={16} />} disabled={!canManageTarget(detail) || password.length < 8} onClick={() => setConfirm({
                  action: 'password',
                  title: t('users.resetPassword'),
                  message: t('users.roleWarning'),
                })}>{t('users.resetPassword')}</Button>
              </div>

              <div className="button-row">
                <Button icon={<MonitorSmartphone size={16} />} disabled={!canManageTarget(detail)} onClick={() => setConfirm({
                  action: 'reset-devices',
                  title: t('users.resetDevices'),
                  message: `${t('users.roleWarning')} ${detail.full_name}`,
                })}>{t('users.resetDevices')}</Button>
                {detail.status === 'blocked' || detail.status === 'suspended' ? (
                  <Button icon={<UserX size={16} />} disabled={!canManageTarget(detail)} onClick={() => setConfirm({
                    action: 'restore', title: t('users.unblock'), message: `${t('users.unblock')} — ${detail.full_name}`,
                  })}>{t('users.unblock')}</Button>
                ) : (
                  <Button variant="danger" icon={<UserX size={16} />} disabled={!canManageTarget(detail)} onClick={() => setConfirm({
                    action: 'block', title: t('users.block'), message: `${t('users.deleteWarning')} ${detail.full_name}`,
                  })}>{t('users.block')}</Button>
                )}
                <Button variant="danger" icon={<Trash2 size={16} />} disabled={!canManageTarget(detail)} onClick={() => setConfirm({
                  action: 'trash', title: t('users.trash'), message: `${t('users.deleteWarning')} ${detail.full_name}`,
                })}>{t('users.trash')}</Button>
              </div>
            </div>

            <h3 className="section-title">{t('users.devices')} ({detail.devices?.length ?? 0})</h3>
            {!detail.devices || detail.devices.length === 0 ? <p className="muted">{t('common.empty')}</p> : (
              <ul className="device-list">
                {detail.devices.map((device) => (
                  <li key={device.id}>
                    <MonitorSmartphone size={16} />
                    <div>
                      <strong>{device.device_name ?? 'Device'}</strong>
                      <span className="muted small">{device.platform ?? '—'} · {device.trust_level ?? '—'} · {formatDate(device.last_active_at, lang, true)}</span>
                    </div>
                    <Badge value={device.status ?? 'inactive'} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={t('common.confirm')}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={execute}
      />
    </>
  );
}
