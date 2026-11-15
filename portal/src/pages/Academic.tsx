import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Building2, ChevronRight, GraduationCap, Plus, Power, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Input, Modal, PageHeader,
  Spinner, useToast,
} from '../components/ui';

interface University { id: string; name: string; is_active: number | boolean }
interface Faculty { id: string; university_id: string; name: string; is_active: number | boolean }
interface Level { id: string; faculty_id: string; name: string; display_order: number; is_active: number | boolean }

export default function Academic() {
  const { t } = useI18n();
  const { notify } = useToast();
  useDocumentTitle(t('nav.academic'));

  const [universityId, setUniversityId] = useState<string>('');
  const [facultyId, setFacultyId] = useState<string>('');
  const [modal, setModal] = useState<'university' | 'faculty' | 'level' | null>(null);
  const [name, setName] = useState('');
  const [order, setOrder] = useState('0');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'university' | 'faculty' | 'level'; id: string; name: string } | null>(null);

  const universities = useAsync<University[]>(async (signal) => {
    const rows = await api.get<University[]>('/api/universities', { order: 'name.asc', limit: 500 }, signal);
    return Array.isArray(rows) ? rows : [];
  }, []);

  const faculties = useAsync<Faculty[]>(async (signal) => {
    if (!universityId) return [];
    const rows = await api.get<Faculty[]>('/api/faculties', { university_id: `eq.${universityId}`, order: 'name.asc', limit: 500 }, signal);
    return Array.isArray(rows) ? rows : [];
  }, [universityId]);

  const levels = useAsync<Level[]>(async (signal) => {
    if (!facultyId) return [];
    const rows = await api.get<Level[]>('/api/academic_levels', { faculty_id: `eq.${facultyId}`, order: 'display_order.asc', limit: 500 }, signal);
    return Array.isArray(rows) ? rows : [];
  }, [facultyId]);

  useEffect(() => { setFacultyId(''); }, [universityId]);
  useEffect(() => { setOrder(String((levels.data?.length ?? 0) + 1)); }, [levels.data]);

  const selectUniversity = (id: string) => {
    setUniversityId(id);
    setFacultyId('');
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (modal === 'faculty' && !universityId) return;
    if (modal === 'level' && !facultyId) return;
    setSaving(true);
    try {
      if (modal === 'university') {
        await api.post('/api/universities', { name: name.trim() });
        universities.reload();
      } else if (modal === 'faculty') {
        await api.post('/api/faculties', { name: name.trim(), university_id: universityId });
        faculties.reload();
      } else if (modal === 'level') {
        await api.post('/api/academic_levels', { name: name.trim(), faculty_id: facultyId, display_order: Number(order) || 0 });
        levels.reload();
      }
      notify(t('common.success'));
      setModal(null);
      setName('');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (kind: 'university' | 'faculty' | 'level', row: { id: string; is_active: number | boolean }) => {
    try {
      await api.patch(`/api/${kind === 'university' ? 'universities' : kind === 'faculty' ? 'faculties' : 'academic_levels'}?id=eq.${row.id}`, {
        is_active: Number(row.is_active) ? 0 : 1,
      });
      notify(t('common.success'));
      if (kind === 'university') universities.reload();
      else if (kind === 'faculty') faculties.reload();
      else levels.reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setSaving(true);
    try {
      const table = confirmDelete.kind === 'university' ? 'universities' : confirmDelete.kind === 'faculty' ? 'faculties' : 'academic_levels';
      await api.del(`/api/${table}`, { id: `eq.${confirmDelete.id}` });
      notify('Deleted.');
      setConfirmDelete(null);
      if (confirmDelete.kind === 'university') { selectUniversity(''); universities.reload(); }
      else if (confirmDelete.kind === 'faculty') { setFacultyId(''); faculties.reload(); }
      else levels.reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const renderList = (
    kind: 'university' | 'faculty' | 'level',
    state: { data: { id: string; name: string; is_active: number | boolean }[] | null; loading: boolean; error: string | null; reload: () => void },
    selected: string,
    onSelect: (id: string) => void,
    icon: ReactNode,
  ) => (
    <Card padded={false} className="academic-column">
      <div className="academic-head">
        <h2>{kind === 'university' ? t('academic.universities') : kind === 'faculty' ? t('academic.faculties') : t('academic.levels')}</h2>
        <Button variant="ghost" icon={<Plus size={15} />} aria-label={t('academic.add')} onClick={() => { setName(''); setModal(kind); }} />
      </div>
      {state.loading ? <Spinner /> : state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : !state.data || state.data.length === 0 ? (
        <EmptyState title={t('common.empty')} />
      ) : (
        <ul className="academic-list">
          {state.data.map((row) => (
            <li key={row.id} className={selected === row.id ? 'active' : ''}>
              <button type="button" className="academic-item" onClick={() => onSelect(row.id)}>
                {icon}
                <span>{row.name}</span>
                {!Number(row.is_active) && <Badge tone="slate">{t('academic.inactive')}</Badge>}
                <ChevronRight size={15} className="academic-chevron" />
              </button>
              <div className="academic-item-actions">
                <button type="button" className="icon-btn tiny" aria-label="Toggle active" onClick={() => void toggleActive(kind, row)}><Power size={13} /></button>
                <button type="button" className="icon-btn tiny danger" aria-label={t('common.delete')} onClick={() => setConfirmDelete({ kind, id: row.id, name: row.name })}><Trash2 size={13} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader title={t('nav.academic')} subtitle={t('academic.subtitle')} />
      <div className="academic-grid">
        {renderList('university', universities, universityId, selectUniversity, <Building2 size={16} />)}
        {renderList('faculty', faculties, facultyId, setFacultyId, <GraduationCap size={16} />)}
        {renderList('level', levels, '', () => {}, <GraduationCap size={16} />)}
      </div>

      <Modal
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        title={`${t('academic.add')} — ${modal ?? ''}`}
        footer={(
          <>
            <Button onClick={() => setModal(null)} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="academic-form" loading={saving}>{t('common.create')}</Button>
          </>
        )}
      >
        <form id="academic-form" onSubmit={create} className="stack">
          <Input label={t('common.name')} required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {modal === 'level' && <Input label={t('academic.displayOrder')} type="number" min={0} value={order} onChange={(e) => setOrder(e.target.value)} />}
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={t('common.delete')}
        message={confirmDelete ? `${t('common.delete')} “${confirmDelete.name}”? ${t('academic.deleteWarning')}` : ''}
        busy={saving}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={remove}
      />
    </>
  );
}
