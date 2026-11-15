import { useState } from 'react';
import { FileText, Save } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate } from '../lib/format';
import {
  Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner, Textarea, useToast,
} from '../components/ui';

interface Page { id: string; key: string; title: string; content: string; published: boolean; using_builtin: boolean; updated_at: string }

export default function Cms() {
  const { t, lang } = useI18n();
  const { notify } = useToast();
  useDocumentTitle(t('cms.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const response = await api.get<{ pages: Page[] }>('/platform/pages', undefined, signal);
    return response.pages ?? [];
  }, []);

  const [editing, setEditing] = useState<Page | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [published, setPublished] = useState(true);
  const [saving, setSaving] = useState(false);

  const open = (page: Page) => {
    setEditing(page);
    setTitle(page.title);
    setContent(page.content);
    setPublished(page.published);
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await api.put(`/platform/pages/${editing.key}`, { title, content, published });
      notify(t('common.success'));
      setEditing(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={t('cms.title')} subtitle={t('cms.subtitle')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.length === 0 ? <Card><EmptyState /></Card> : (
        <div className="cms-grid">
          {data.map((page) => (
            <Card key={page.key} className="cms-card">
              <div className="cms-icon"><FileText size={20} /></div>
              <div className="cms-body">
                <div className="cms-head">
                  <h3>{page.title}</h3>
                  <Badge value={page.published ? 'published' : 'hidden'} />
                </div>
                <code className="code">{page.key}</code>
                <p className="muted small clamp-3">{page.content || 'Built-in default text'}</p>
                <div className="cms-foot">
                  <span className="muted small">{formatDate(page.updated_at, lang, true)}</span>
                  <Button variant="ghost" onClick={() => open(page)}>{t('common.edit')}</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.title ?? ''}
        wide
        footer={(
          <>
            <Button onClick={() => setEditing(null)} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" icon={<Save size={16} />} onClick={save} loading={saving}>{t('common.save')}</Button>
          </>
        )}
      >
        <div className="stack">
          <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <Textarea label={t('cms.content')} rows={16} value={content} onChange={(e) => setContent(e.target.value)} hint="Plain text only. Empty content uses the app's built-in legal text." />
          <label className="checkbox"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /><span>{t('cms.published')}</span></label>
        </div>
      </Modal>
    </>
  );
}
