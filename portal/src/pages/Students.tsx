import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { GraduationCap, Pause, Play, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDebounced, useDocumentTitle } from '../lib/hooks';
import { formatDate, formatNumber } from '../lib/format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Input, Modal, PageHeader,
  Select, Spinner, Table, useToast,
} from '../components/ui';

interface Enrollment {
  id: string;
  status?: string | null;
  enrolled_at: string;
  progress_percent?: number | null;
  student?: {
    full_name?: string;
    email?: string | null;
    phone?: string | null;
    phone_e164?: string | null;
    public_user_id?: string | null;
    status?: string;
  };
  course?: { id?: string; title?: string };
}

interface Course { id: string; title: string }

export default function Students() {
  const { t, lang } = useI18n();
  const { notify } = useToast();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '', course_id: '' });
  const [confirm, setConfirm] = useState<{ enrollment: Enrollment; action: 'suspend' | 'resume' | 'remove' } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState<'suspend' | 'resume' | 'remove' | null>(null);

  useDocumentTitle(t('students.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const [students, courses] = await Promise.all([
      api.get<Enrollment[]>('/doctors/students', { search: debouncedSearch.trim() }, signal),
      api.get<{ courses: Course[] }>('/courses', { archived_at: 'is.null' }, signal).catch(() => ({ courses: [] })),
    ]);
    return { students: Array.isArray(students) ? students : [], courses: courses.courses ?? [] };
  }, [debouncedSearch]);

  const rows = data?.students ?? [];
  const courses = data?.courses ?? [];
  const activeCount = useMemo(() => rows.filter((row) => row.status !== 'suspended').length, [rows]);

  useEffect(() => { setSelected(new Set()); }, [debouncedSearch]);

  const toggleSelected = (enrollmentId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(enrollmentId)) next.delete(enrollmentId); else next.add(enrollmentId);
      return next;
    });
  };

  const allVisibleSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) rows.forEach((row) => next.delete(row.id));
      else rows.forEach((row) => next.add(row.id));
      return next;
    });
  };

  const runBulk = async () => {
    if (!bulkConfirm) return;
    const action = bulkConfirm;
    const ids = [...selected];
    setBulkConfirm(null);
    setBusy(true);
    try {
      const result = await api.post<{ succeeded: number; skipped: number; failed: number }>('/students/bulk-action', {
        action,
        enrollment_ids: ids,
      });
      const summary = `${result.succeeded} ${t('common.success')} · ${result.skipped} ${t('common.skipped')} · ${result.failed} ${t('common.failed')}`;
      notify(summary, result.failed > 0 ? 'error' : 'success');
      setSelected(new Set());
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const runAction = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.action === 'remove') {
        await api.post('/rpc/remove-course-enrollment', { p_enrollment_id: confirm.enrollment.id });
      } else {
        await api.patch(`/api/enrollments?id=eq.${confirm.enrollment.id}`, {
          status: confirm.action === 'suspend' ? 'suspended' : 'active',
        });
      }
      notify(confirm.action === 'remove' ? 'Enrollment removed.' : `Enrollment ${confirm.action === 'suspend' ? 'suspended' : 'resumed'}.`);
      setConfirm(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const addStudent = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.full_name.trim() || (!form.email.trim() && !form.phone.trim()) || form.password.length < 6 || !form.course_id) {
      setFormError('Name, email or phone, a 6+ character password and a course are required.');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api.post('/student-operations', {
        mode: 'create_and_enroll_credits',
        full_name: form.full_name.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        password: form.password,
        course_id: form.course_id,
      });
      notify('Student created and enrolled.');
      setAddOpen(false);
      setForm({ full_name: '', email: '', phone: '', password: '', course_id: '' });
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('students.title')}
        subtitle={t('students.subtitle')}
        actions={<Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setAddOpen(true)}>{t('users.new')}</Button>}
      />

      <div className="mini-stats">
        <span><GraduationCap size={16} /> {formatNumber(rows.length, lang)} {t('students.title').toLowerCase()}</span>
        <span><Badge tone="green">{formatNumber(activeCount, lang)} {t('common.active')}</Badge></span>
        <span><Badge tone="amber">{formatNumber(rows.length - activeCount, lang)} {t('common.suspended')}</Badge></span>
      </div>

      <Card padded={false}>
        <div className="toolbar">
          <input
            className="toolbar-search"
            type="search"
            placeholder={t('students.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {selected.size > 0 && (
          <div className="bulk-bar" role="region" aria-label={t('common.selected')}>
            <strong>{selected.size} {t('common.selected')}</strong>
            <div className="row-actions">
              <Button variant="ghost" icon={<Play size={15} />} onClick={() => setBulkConfirm('resume')}>{t('students.bulkResume')}</Button>
              <Button variant="ghost" icon={<Pause size={15} />} onClick={() => setBulkConfirm('suspend')}>{t('students.bulkSuspend')}</Button>
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setBulkConfirm('remove')}>{t('students.bulkRemove')}</Button>
              <button type="button" className="icon-btn" aria-label={t('common.clear')} onClick={() => setSelected(new Set())}><X size={16} /></button>
            </div>
          </div>
        )}
        {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
          <EmptyState title={t('students.empty')} action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>{t('users.new')}</Button>} />
        ) : (
          <Table className="students-table">
            <thead>
              <tr>
                <th className="check-cell">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label={t('common.selectAll')} />
                </th>
                <th>{t('common.name')}</th>
                <th>{t('common.phone')}</th>
                <th>{t('students.course')}</th>
                <th>{t('common.status')}</th>
                <th>{t('students.progress')}</th>
                <th>{t('students.enrolled')}</th>
                <th className="align-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const suspended = row.status === 'suspended';
                return (
                  <tr key={row.id} className={selected.has(row.id) ? 'selected-row' : ''}>
                    <td className="check-cell">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        aria-label={`${t('students.selectStudent')}: ${row.student?.full_name ?? row.id}`}
                      />
                    </td>
                    <td className="student-name">
                      <strong>{row.student?.full_name ?? '—'}</strong>
                      <div className="muted small">{row.student?.public_user_id ?? row.student?.email ?? '—'}</div>
                    </td>
                    <td data-label={t('common.phone')}>{row.student?.phone_e164 ?? row.student?.phone ?? '—'}</td>
                    <td data-label={t('students.course')}>{row.course?.title ?? '—'}</td>
                    <td data-label={t('common.status')}><Badge value={suspended ? 'suspended' : (row.status ?? 'active')} /></td>
                    <td data-label={t('students.progress')}>{formatNumber(row.progress_percent ?? 0, lang)}%</td>
                    <td data-label={t('students.enrolled')}>{formatDate(row.enrolled_at, lang)}</td>
                    <td className="align-end student-actions">
                      <div className="row-actions">
                        <Button variant="ghost" icon={suspended ? <Play size={15} /> : <Pause size={15} />} onClick={() => setConfirm({ enrollment: row, action: suspended ? 'resume' : 'suspend' })}>
                          {suspended ? t('common.active') : t('common.suspended')}
                        </Button>
                        <button type="button" className="icon-btn danger" aria-label={t('common.delete')} onClick={() => setConfirm({ enrollment: row, action: 'remove' })}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('users.new')}
        footer={(
          <>
            <Button onClick={() => setAddOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="add-student-form" loading={busy}>{t('common.create')}</Button>
          </>
        )}
      >
        <form id="add-student-form" onSubmit={addStudent} className="form-grid">
          <div className="form-span-2">
            <Input label={t('profile.fullName')} required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoFocus />
          </div>
          <Input label={t('common.email')} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input label={t('common.phone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Input label={t('login.password')} type="password" autoComplete="new-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} hint="Minimum 6 characters" />
          <Select label={t('students.course')} required value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })}>
            <option value="">—</option>
            {courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
          </Select>
          {formError && <div className="form-span-2"><div className="inline-error">{formError}</div></div>}
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm ? `${confirm.action === 'remove' ? t('common.delete') : confirm.action === 'suspend' ? t('common.suspended') : t('common.active')}` : ''}
        message={confirm ? `${confirm.enrollment.student?.full_name ?? ''} — ${confirm.enrollment.course?.title ?? ''}` : ''}
        confirmLabel={t('common.confirm')}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={runAction}
      />

      <ConfirmDialog
        open={Boolean(bulkConfirm)}
        title={bulkConfirm ? t(`students.bulk${bulkConfirm[0].toUpperCase()}${bulkConfirm.slice(1)}`) : ''}
        message={t('students.bulkConfirm').replace('{count}', String(selected.size))}
        confirmLabel={t('common.confirm')}
        busy={busy}
        onCancel={() => setBulkConfirm(null)}
        onConfirm={runBulk}
      />
    </>
  );
}
