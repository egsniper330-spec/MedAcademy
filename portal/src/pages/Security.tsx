import { useState, type FormEvent } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import {
  Badge, Button, Card, ConfirmDialog, ErrorState, Input, Modal, PageHeader, Select,
  Spinner, Switch, Table, useToast,
} from '../components/ui';

interface Policy { id: string; detection_type: string; action: string; enabled: number | boolean; updated_at: string }
interface Whitelist { id: string; name: string; description: string | null; created_at: string }

const ACTIONS = ['log_only', 'warn_only', 'block_video', 'block_login'];
const MANDATORY = new Set(['developer_options', 'debug', 'tamper', 'play_integrity', 'vpn', 'proxy']);

export default function Security() {
  const { t } = useI18n();
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [remove, setRemove] = useState<Whitelist | null>(null);

  useDocumentTitle(t('security.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ policies: Policy[]; vpn_whitelist: Whitelist[] }>('/admin/security/policies', undefined, signal);
    return { policies: response.policies ?? [], whitelist: response.vpn_whitelist ?? [] };
  }, []);

  const updatePolicy = async (policy: Policy, patch: { enabled?: boolean; action?: string }) => {
    setBusy(policy.detection_type);
    try {
      await api.put(`/admin/security/policies/${policy.detection_type}`, patch);
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const addWhitelist = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post('/admin/security/vpn-whitelist', { name: name.trim(), description: description.trim() || undefined });
      notify(t('common.success'));
      setAddOpen(false);
      setName('');
      setDescription('');
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteWhitelist = async () => {
    if (!remove) return;
    setSaving(true);
    try {
      await api.del(`/admin/security/vpn-whitelist/${remove.id}`);
      notify('Removed.');
      setRemove(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title={t('security.title')} subtitle={t('security.subtitle')} />
      <Card padded={false}>
        <div className="card-head padded-head"><h2>{t('security.policy')}</h2><ShieldCheck size={18} /></div>
        <Table>
          <thead><tr><th>Detection</th><th>Action</th><th>{t('flags.enabled')}</th><th>{t('common.updated')}</th></tr></thead>
          <tbody>
            {data.policies.map((policy) => {
              const mandatory = MANDATORY.has(policy.detection_type);
              return (
                <tr key={policy.detection_type}>
                  <td><strong>{policy.detection_type.replace(/_/g, ' ')}</strong>{mandatory && <div><Badge tone="red">mandatory</Badge></div>}</td>
                  <td>
                    <Select
                      value={policy.action}
                      disabled={mandatory || busy === policy.detection_type}
                      onChange={(e) => void updatePolicy(policy, { action: e.target.value })}
                    >
                      {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                    </Select>
                  </td>
                  <td>
                    <Switch
                      checked={Boolean(Number(policy.enabled))}
                      disabled={mandatory || busy === policy.detection_type}
                      label={policy.detection_type}
                      onChange={(enabled) => void updatePolicy(policy, { enabled })}
                    />
                  </td>
                  <td className="small">{policy.updated_at ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <div className="card-head standalone">
        <h2>{t('security.vpnWhitelist')}</h2>
        <Button icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>Add VPN</Button>
      </div>
      <Card padded={false}>
        {data.whitelist.length === 0 ? <p className="muted padded-small">No whitelisted VPN providers.</p> : (
          <Table>
            <thead><tr><th>{t('common.name')}</th><th>Description</th><th>{t('common.joined')}</th><th /></tr></thead>
            <tbody>
              {data.whitelist.map((entry) => (
                <tr key={entry.id}>
                  <td><strong>{entry.name}</strong></td>
                  <td>{entry.description ?? '—'}</td>
                  <td className="small">{entry.created_at}</td>
                  <td className="align-end"><button type="button" className="icon-btn danger" aria-label={t('common.delete')} onClick={() => setRemove(entry)}><Trash2 size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add VPN provider"
        footer={(
          <>
            <Button onClick={() => setAddOpen(false)} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="vpn-form" loading={saving}>{t('common.create')}</Button>
          </>
        )}
      >
        <form id="vpn-form" onSubmit={addWhitelist} className="stack">
          <Input label={t('common.name')} required value={name} onChange={(e) => setName(e.target.value)} placeholder="NordVPN" autoFocus />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(remove)}
        title="Remove VPN whitelist entry"
        message={remove ? `Remove “${remove.name}”?` : ''}
        busy={saving}
        onCancel={() => setRemove(null)}
        onConfirm={deleteWhitelist}
      />
    </>
  );
}
