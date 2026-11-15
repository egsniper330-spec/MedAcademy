import { useMemo, useState } from 'react';
import { Flag, Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import {
  Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, Switch, useToast,
} from '../components/ui';

interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
  is_default: boolean;
  overrides: number;
}

export default function FeatureFlags() {
  const { t } = useI18n();
  const { notify } = useToast();
  const [search, setSearch] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  useDocumentTitle(t('flags.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ flags: FeatureFlag[] }>('/platform/feature-flags', undefined, signal);
    return response.flags ?? [];
  }, []);

  const grouped = useMemo(() => {
    const rows = (data ?? []).filter((flag) => {
      if (!search.trim()) return true;
      const needle = search.toLowerCase();
      return `${flag.key} ${flag.label} ${flag.description}`.toLowerCase().includes(needle);
    });
    return rows.reduce<Record<string, FeatureFlag[]>>((acc, flag) => {
      (acc[flag.category] ??= []).push(flag);
      return acc;
    }, {});
  }, [data, search]);

  const toggle = async (flag: FeatureFlag, enabled: boolean) => {
    setSavingKey(flag.key);
    try {
      await api.put(`/platform/feature-flags/${flag.key}`, { enabled });
      notify(`${flag.label}: ${enabled ? t('flags.enabled') : t('flags.disabled')}`);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t('flags.title')}
        subtitle={t('flags.subtitle')}
        actions={(
          <div className="search-inline">
            <Search size={16} />
            <input type="search" placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        )}
      />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : Object.keys(grouped).length === 0 ? <Card><EmptyState /></Card> : (
        Object.entries(grouped).map(([category, flags]) => (
          <section key={category} className="settings-group">
            <h2 className="settings-group-title"><Flag size={16} />{category.replace(/_/g, ' ')}</h2>
            <Card padded={false}>
              <ul className="toggle-list">
                {flags.map((flag) => (
                  <li key={flag.key}>
                    <div className="toggle-copy">
                      <div className="toggle-title">
                        <strong>{flag.label}</strong>
                        <code className="code">{flag.key}</code>
                        {flag.overrides > 0 && <Badge tone="blue">{flag.overrides} override{flag.overrides === 1 ? '' : 's'}</Badge>}
                      </div>
                      <p>{flag.description}</p>
                      <span className="muted small">Default: {flag.is_default ? t('flags.enabled') : t('flags.disabled')}</span>
                    </div>
                    <Switch checked={flag.enabled} disabled={savingKey === flag.key} label={flag.label} onChange={(value) => void toggle(flag, value)} />
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
    </>
  );
}
