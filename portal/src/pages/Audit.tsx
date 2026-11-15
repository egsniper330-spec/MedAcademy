import { useState } from 'react';
import { Download, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDebounced, useDocumentTitle } from '../lib/hooks';
import { downloadCsv, formatDate } from '../lib/format';
import {
  Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner, Table,
} from '../components/ui';

interface AuditLog {
  id: string;
  user_id: string | null;
  actor_id: string | null;
  action: string;
  details: unknown;
  target_name: string | null;
  ip_address: string | null;
  log_status: string | null;
  created_at: string;
}

export default function Audit() {
  const { t, lang } = useI18n();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const debounced = useDebounced(search);
  const [selected, setSelected] = useState<AuditLog | null>(null);

  useDocumentTitle(t('audit.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ logs: AuditLog[] }>('/admin/audit-logs', {
      limit: 300,
      action: action.trim(),
    }, signal);
    return response.logs ?? [];
  }, [action]);

  const rows = (data ?? []).filter((log) => {
    if (!debounced.trim()) return true;
    const needle = debounced.toLowerCase();
    return `${log.action} ${log.target_name ?? ''} ${log.user_id ?? ''} ${log.actor_id ?? ''}`.toLowerCase().includes(needle);
  });

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
        actions={(
          <Button icon={<Download size={16} />} disabled={rows.length === 0} onClick={() => downloadCsv('audit-log.csv', rows as unknown as Record<string, unknown>[])}>
            {t('common.export')}
          </Button>
        )}
      />
      <Card padded={false}>
        <div className="toolbar toolbar-wrap">
          <input className="toolbar-search" type="search" placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <input className="toolbar-search" type="text" placeholder="Exact action (e.g. login)" value={action} onChange={(e) => setAction(e.target.value)} />
          <Search size={16} className="muted" />
        </div>
        {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? <EmptyState /> : (
          <Table>
            <thead>
              <tr>
                <th>{t('audit.action')}</th>
                <th>{t('audit.actor')}</th>
                <th>{t('audit.target')}</th>
                <th>{t('common.status')}</th>
                <th>{t('audit.when')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((log) => (
                <tr key={log.id}>
                  <td><code className="code">{log.action}</code></td>
                  <td className="mono small">{log.actor_id?.slice(0, 8) ?? '—'}</td>
                  <td>{log.target_name ?? log.user_id?.slice(0, 8) ?? '—'}</td>
                  <td><Badge tone={log.log_status === 'failure' ? 'red' : 'green'}>{log.log_status ?? 'success'}</Badge></td>
                  <td>{formatDate(log.created_at, lang, true)}</td>
                  <td className="align-end"><Button variant="ghost" onClick={() => setSelected(log)}>{t('common.details')}</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.action ?? ''} wide footer={<Button onClick={() => setSelected(null)}>{t('common.close')}</Button>}>
        {selected && (
          <div className="detail-grid">
            <div><span>{t('audit.when')}</span><strong>{formatDate(selected.created_at, lang, true)}</strong></div>
            <div><span>{t('audit.actor')}</span><strong className="mono small">{selected.actor_id ?? '—'}</strong></div>
            <div><span>{t('audit.target')}</span><strong>{selected.target_name ?? selected.user_id ?? '—'}</strong></div>
            <div><span>IP</span><strong className="mono small">{selected.ip_address ?? '—'}</strong></div>
            <div className="form-span-2">
              <span>Details</span>
              <pre className="json-block">{JSON.stringify(selected.details, null, 2)}</pre>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
