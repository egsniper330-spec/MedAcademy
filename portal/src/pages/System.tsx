import { useState } from 'react';
import { Activity, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate } from '../lib/format';
import {
  Badge, Button, Card, ErrorState, PageHeader, Spinner, useToast,
} from '../components/ui';

interface CheckResult {
  id: string;
  name: string;
  category: string;
  status: string;
  checks?: Record<string, string>;
  message?: string;
  latencyMs?: number;
  recommendedAction?: string;
}
interface Report {
  generatedAt: string;
  results: CheckResult[];
  summary: Record<string, number>;
}

export default function System() {
  const { t, lang } = useI18n();
  const { notify } = useToast();
  const [refreshing, setRefreshing] = useState<string | null>(null);
  useDocumentTitle(t('system.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<Report>('/admin/system/diagnostics', undefined, signal);
    return response;
  }, []);

  const refreshOne = async (id: string) => {
    setRefreshing(id);
    try {
      await api.get(`/admin/system/diagnostics/${id}`);
      notify(t('common.success'));
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setRefreshing(null);
      reload();
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const failing = Object.entries(data.summary).filter(([key, value]) => key !== 'healthy' && Number(value) > 0);

  return (
    <>
      <PageHeader
        title={t('system.title')}
        subtitle={t('system.subtitle')}
        actions={<Button icon={<RefreshCw size={16} />} onClick={reload}>{t('system.run')}</Button>}
      />

      <div className="system-summary">
        <div className={failing.length === 0 ? 'healthy' : 'failing'}>
          {failing.length === 0 ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
          <div>
            <strong>{failing.length === 0 ? t('system.allHealthy') : t('system.attention')}</strong>
            <span className="muted small">{t('system.generated')} {formatDate(data.generatedAt, lang, true)}</span>
          </div>
        </div>
        {Object.entries(data.summary).filter(([, value]) => Number(value) > 0).map(([key, value]) => (
          <Badge key={key} tone={key === 'healthy' ? 'green' : key === 'warning' ? 'amber' : 'red'}>{key}: {value}</Badge>
        ))}
      </div>

      <div className="system-grid">
        {data.results.map((result) => (
          <Card key={result.id} className="system-card">
            <div className="system-card-head">
              <div className="system-icon"><Activity size={17} /></div>
              <div>
                <strong>{result.name}</strong>
                <span className="muted small">{result.category}{result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ''}</span>
              </div>
              <Badge value={result.status} tone={result.status === 'healthy' ? 'green' : result.status === 'warning' ? 'amber' : 'red'} />
            </div>
            {result.message && <p className="small">{result.message}</p>}
            {result.checks && (
              <ul className="check-list">
                {Object.entries(result.checks).map(([name, value]) => (
                  <li key={name}><span>{name.replace(/_/g, ' ')}</span><Badge tone={value === 'passed' ? 'green' : value.includes('not') ? 'slate' : 'red'}>{value}</Badge></li>
                ))}
              </ul>
            )}
            {result.recommendedAction && <p className="notice">{result.recommendedAction}</p>}
            <Button variant="ghost" icon={<RefreshCw size={14} />} loading={refreshing === result.id} onClick={() => void refreshOne(result.id)}>{t('system.recheck')}</Button>
          </Card>
        ))}
      </div>
    </>
  );
}
