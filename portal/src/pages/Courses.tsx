import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Archive, Copy, Download, FileUp, MoreHorizontal, Pencil, Plus, Send, Trash2, Undo2, X,
} from 'lucide-react';
import { api, errorMessage, uploadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useAsync, useDebounced, useDocumentTitle } from '../lib/hooks';
import { downloadCsv, formatDate, formatMoney, formatNumber } from '../lib/format';
import { courseCsvTemplate, parseCsv } from '../lib/csv';
import {
  Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, Input, Modal, PageHeader,
  Select, Spinner, Table, Textarea, Tabs, useToast,
} from '../components/ui';

export interface Course {
  id: string;
  title: string;
  short_description?: string | null;
  description?: string | null;
  full_description?: string | null;
  status: string;
  price_egp?: number | null;
  total_lessons?: number | null;
  total_sections?: number | null;
  doctor_name?: string | null;
  category_id?: string | null;
  language?: string | null;
  difficulty?: string | null;
  credits_required?: number | null;
  free_preview?: number | boolean | null;
  sequential_learning?: number | boolean | null;
  certificate_enabled?: number | boolean | null;
  subscription_required?: number | boolean | null;
  use_default_contact?: number | boolean | null;
  whatsapp?: string | null;
  telegram?: string | null;
  phone?: string | null;
  university_id?: string | null;
  faculty_id?: string | null;
  image_url?: string | null;
  created_at: string;
  updated_at?: string;
}

interface University { id: string; name: string }
interface Faculty { id: string; name: string }
interface CourseTemplate {
  id: string;
  title: string;
  template_data?: {
    course?: Record<string, unknown>;
    sections?: Array<{ title?: string; order_index?: number; lessons?: Array<Record<string, unknown>> }>;
  };
}

const STATUS_TABS = ['all', 'draft', 'published', 'hidden', 'archived'] as const;
type StatusTab = typeof STATUS_TABS[number];
type BulkAction = 'publish' | 'unpublish' | 'archive';

interface CourseForm {
  title: string;
  short_description: string;
  full_description: string;
  language: string;
  price_egp: string;
  university_id: string;
  faculty_id: string;
  use_default_contact: boolean;
  whatsapp: string;
  telegram: string;
  phone: string;
  sequential_learning: boolean;
  free_preview: boolean;
  certificate_enabled: boolean;
  subscription_required: boolean;
}

const EMPTY_FORM: CourseForm = {
  title: '', short_description: '', full_description: '', language: 'Arabic', price_egp: '0',
  university_id: '', faculty_id: '', use_default_contact: true, whatsapp: '', telegram: '', phone: '',
  sequential_learning: false, free_preview: false, certificate_enabled: false, subscription_required: true,
};

interface ImportResult {
  imported: number;
  failed: number;
  total: number;
  results: { row: number; status: string; message?: string; title?: string }[];
}

export default function Courses() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<StatusTab>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1');
  const [form, setForm] = useState<CourseForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [templates, setTemplates] = useState<CourseTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [templateImageUrl, setTemplateImageUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ course: Course; action: 'publish' | 'unpublish' | 'archive' | 'delete' } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [universities, setUniversities] = useState<University[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  useDocumentTitle(t('courses.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const courses = await api.get<{ courses: Course[] }>(
      '/courses',
      { archived_at: status === 'archived' ? undefined : 'is.null' },
      signal,
    );
    return { courses: courses.courses ?? [] };
  }, [status]);

  useEffect(() => {
    if (params.get('new') === '1') setCreateOpen(true);
  }, [params]);

  useEffect(() => {
    api.get<University[]>('/api/universities', { order: 'name.asc', limit: 500 })
      .then((rows) => setUniversities(Array.isArray(rows) ? rows : []))
      .catch(() => setUniversities([]));
  }, []);

  useEffect(() => {
    if (!form.university_id) { setFaculties([]); return; }
    api.get<Faculty[]>('/api/faculties', { university_id: `eq.${form.university_id}`, order: 'name.asc', limit: 500 })
      .then((rows) => setFaculties(Array.isArray(rows) ? rows : []))
      .catch(() => setFaculties([]));
  }, [form.university_id]);

  useEffect(() => {
    if (!createOpen || !user) return;
    api.get<CourseTemplate[]>('/api/course_templates', {
      or: `doctor_id.eq.${user.id},is_public.eq.true`,
      order: 'created_at.desc',
      limit: 50,
    })
      .then((rows) => setTemplates(Array.isArray(rows) ? rows : []))
      .catch(() => setTemplates([]));
  }, [createOpen, user]);

  const closeCreate = () => {
    setCreateOpen(false);
    setForm(EMPTY_FORM);
    setCover(null);
    setTemplateId('');
    setTemplateImageUrl(null);
    setFormError(null);
    if (params.get('new') === '1') {
      params.delete('new');
      setParams(params, { replace: true });
    }
  };

  const courses = data?.courses ?? [];

  const applyTemplate = (nextId: string) => {
    setTemplateId(nextId);
    const template = templates.find((item) => item.id === nextId);
    if (!template) return;
    const course = template.template_data?.course ?? {};
    const text = (key: string, fallback = '') => typeof course[key] === 'string' ? course[key] as string : fallback;
    const flag = (key: string, fallback = false) => {
      const value = course[key];
      return value === undefined ? fallback : value !== 0 && value !== false;
    };
    setForm((current) => ({
      ...current,
      title: text('title') ? `${text('title')} (${t('courses.fromTemplate')})`.slice(0, 255) : current.title,
      short_description: text('short_description'),
      full_description: text('full_description', text('description')),
      language: text('language', 'Arabic'),
      price_egp: course.price_egp === undefined || course.price_egp === null ? '0' : String(course.price_egp),
      university_id: text('university_id'),
      faculty_id: text('faculty_id'),
      use_default_contact: flag('use_default_contact', true),
      whatsapp: text('whatsapp'),
      telegram: text('telegram'),
      phone: text('phone'),
      sequential_learning: flag('sequential_learning'),
      free_preview: flag('free_preview'),
      certificate_enabled: flag('certificate_enabled'),
      subscription_required: flag('subscription_required', true),
    }));
    setTemplateImageUrl(typeof course.image_url === 'string' ? course.image_url : null);
    setCover(null);
  };

  const filtered = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    return courses.filter((course) => {
      if (status !== 'all' && course.status !== status) return false;
      if (!needle) return true;
      return `${course.title} ${course.doctor_name ?? ''} ${course.short_description ?? ''}`.toLowerCase().includes(needle);
    });
  }, [courses, debouncedSearch, status]);

  useEffect(() => { setSelected(new Set()); }, [status, debouncedSearch]);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = filtered.length > 0 && filtered.every((course) => selected.has(course.id));

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filtered.forEach((course) => next.delete(course.id));
      else filtered.forEach((course) => next.add(course.id));
      return next;
    });
  };

  const runAction = async (course: Course, action: 'publish' | 'unpublish' | 'archive' | 'delete' | 'duplicate') => {
    setBusyId(course.id);
    try {
      if (action === 'duplicate') {
        await api.post(`/courses/${course.id}/duplicate`);
        notify(t('common.success'));
      } else {
        await api.post(`/courses/${course.id}/${action}`);
        notify(t('common.success'));
      }
      setConfirm(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected];
    setBulkConfirm(null);
    setBusyId('bulk');
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await api.post(`/courses/${id}/${action}`);
      } catch (e) {
        const course = courses.find((row) => row.id === id);
        failures.push(`${course?.title ?? id}: ${errorMessage(e)}`);
      }
    }
    setBusyId(null);
    if (failures.length > 0) {
      notify(`${ids.length - failures.length} ${t('common.success')} ${failures.length} ${t('common.failed')}. ${failures.slice(0, 2).join(' · ')}`, 'error');
    } else {
      notify(`${ids.length} ${t('common.success')}`);
    }
    setSelected(new Set());
    reload();
  };

  const createCourse = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || !form.short_description.trim() || !form.full_description.trim()) {
      setFormError(t('common.required'));
      return;
    }
    if (!form.price_egp || Number.isNaN(Number(form.price_egp)) || Number(form.price_egp) < 0) {
      setFormError(t('courses.field.price'));
      return;
    }
    if (!form.use_default_contact && !form.whatsapp.trim() && !form.telegram.trim() && !form.phone.trim()) {
      setFormError(t('courses.contactRequired'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.post<{ course: Course }>('/courses', {
        title: form.title.trim(),
        description: form.full_description.trim(),
        short_description: form.short_description.trim(),
        full_description: form.full_description.trim(),
        language: form.language,
        status: 'draft',
      });
      const id = created.course.id;
      await api.post('/rpc/update-course-audited', {
        course_id: id,
        updates: {
          university_id: form.university_id || null,
          faculty_id: form.faculty_id || null,
          price_egp: Number(form.price_egp) || 0,
          sequential_learning: form.sequential_learning,
          free_preview: form.free_preview,
          certificate_enabled: form.certificate_enabled,
          subscription_required: form.subscription_required,
          use_default_contact: form.use_default_contact,
          whatsapp: form.use_default_contact ? null : (form.whatsapp.trim() || null),
          telegram: form.use_default_contact ? null : (form.telegram.trim() || null),
          phone: form.use_default_contact ? null : (form.phone.trim() || null),
        },
      });
      if (cover) {
        const extension = cover.name.split('.').pop()?.toLowerCase() || 'jpg';
        const body = new FormData();
        body.append('bucket', 'course-images');
        body.append('path', `${id}/${Date.now()}-cover.${extension}`);
        body.append('file', cover);
        body.append('file_name', cover.name);
        body.append('declared_size', String(cover.size));
        body.append('declared_size_source', 'stat');
        const uploaded = await uploadFile<{ url: string }>('/storage/upload', body);
        await api.post('/rpc/update-course-audited', { course_id: id, updates: { image_url: uploaded.url } });
      } else if (templateImageUrl) {
        await api.post('/rpc/update-course-audited', { course_id: id, updates: { image_url: templateImageUrl } });
      }
      const template = templates.find((item) => item.id === templateId);
      let structureFailures = 0;
      if (template) {
        const sections = [...(template.template_data?.sections ?? [])].sort(
          (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0),
        );
        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
          const section = sections[sectionIndex];
          try {
            const createdSection = await api.post<{ id?: string }>('/api/sections', {
              course_id: id,
              title: (section.title ?? `Section ${sectionIndex + 1}`).slice(0, 255),
              order_index: section.order_index ?? sectionIndex,
            });
            if (!createdSection.id) { structureFailures += 1; continue; }
            const lessons = [...(section.lessons ?? [])].sort(
              (a, b) => Number(a.order_index ?? 0) - Number(b.order_index ?? 0),
            );
            for (const lesson of lessons) {
              try {
                const createdLesson = await api.post<{ id?: string }>('/api/lessons', {
                  course_id: id,
                  section_id: createdSection.id,
                  title: String(lesson.title ?? 'Lesson').slice(0, 255),
                  description: typeof lesson.description === 'string' ? lesson.description : '',
                  notes: typeof lesson.notes === 'string' ? lesson.notes : null,
                  duration_seconds: Number(lesson.duration_seconds ?? 0) || 0,
                  estimated_minutes: Number(lesson.estimated_minutes ?? 0) || 0,
                  status: 'draft',
                  order_index: Number(lesson.order_index ?? 0) || 0,
                  video_type: ['vdocipher', 'youtube', 'coming_soon'].includes(String(lesson.video_type))
                    ? String(lesson.video_type) : 'coming_soon',
                  youtube_video_id: typeof lesson.youtube_video_id === 'string' ? lesson.youtube_video_id : null,
                  is_preview: Boolean(lesson.is_preview),
                  download_enabled: lesson.download_enabled === undefined ? true : Boolean(lesson.download_enabled),
                  comments_enabled: lesson.comments_enabled === undefined ? true : Boolean(lesson.comments_enabled),
                  visible: lesson.visible === undefined ? true : Boolean(lesson.visible),
                });
                if (createdLesson.id && typeof lesson.video_asset_id === 'string' && lesson.video_asset_id) {
                  try {
                    await api.post('/video/attach-lesson', { lesson_id: createdLesson.id, asset_id: lesson.video_asset_id });
                  } catch {
                    structureFailures += 1;
                  }
                }
              } catch {
                structureFailures += 1;
              }
            }
          } catch {
            structureFailures += 1;
          }
        }
      }
      if (structureFailures > 0) {
        notify(t('courses.templatePartial').replace('{count}', String(structureFailures)), 'error');
      } else {
        notify(t('common.success'));
      }
      closeCreate();
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const readImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setImportResult(null);
    setImportRows([]);
    setImportErrors([]);
    setImportName('');
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setImportErrors(['CSV files must be 2 MB or smaller.']);
      return;
    }
    const text = await file.text();
    const parsed = parseCsv(text);
    setImportName(file.name);
    setImportRows(parsed.rows);
    const errors = [...parsed.errors];
    if (parsed.rows.length > 200) errors.push('A maximum of 200 rows can be imported at once.');
    parsed.rows.forEach((row, index) => {
      if (!row.title?.trim()) errors.push(`Row ${index + 2}: title is required.`);
      if (Number.isNaN(Number(row.price_egp || 0)) || Number(row.price_egp || 0) < 0) {
        errors.push(`Row ${index + 2}: price_egp must be zero or greater.`);
      }
    });
    setImportErrors(errors);
  };

  const downloadTemplate = () => {
    const blob = new Blob([`\ufeff${courseCsvTemplate()}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'medacademy-course-import-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const commitImport = async () => {
    if (importRows.length === 0 || importErrors.length > 0) return;
    setImporting(true);
    try {
      const result = await api.post<ImportResult>('/courses/import', { rows: importRows });
      setImportResult(result);
      notify(`${result.imported} ${t('common.success')} ${result.failed} ${t('common.failed')}`);
      reload();
    } catch (e) {
      setImportErrors([errorMessage(e)]);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('courses.title')}
        subtitle={t('courses.subtitle')}
        actions={(
          <>
            <Button icon={<Download size={16} />} onClick={() => downloadCsv('courses.csv', filtered as unknown as Record<string, unknown>[])} disabled={filtered.length === 0}>
              {t('common.export')}
            </Button>
            <Button icon={<FileUp size={16} />} onClick={() => setImportOpen(true)}>{t('common.import')}</Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>{t('courses.new')}</Button>
          </>
        )}
      />

      <Card padded={false}>
        <div className="toolbar">
          <Tabs
            value={status}
            onChange={setStatus}
            options={STATUS_TABS.map((value) => ({
              value,
              label: value === 'all' ? t('common.all') : t(`common.${value}`),
            }))}
          />
          <input
            className="toolbar-search"
            type="search"
            placeholder={t('courses.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar" role="region" aria-label={t('common.selected')}>
            <strong>{selected.size} {t('common.selected')}</strong>
            <div className="row-actions">
              <Button variant="ghost" icon={<Send size={15} />} disabled={busyId === 'bulk'} onClick={() => setBulkConfirm('publish')}>{t('courses.bulkPublish')}</Button>
              <Button variant="ghost" icon={<Undo2 size={15} />} disabled={busyId === 'bulk'} onClick={() => setBulkConfirm('unpublish')}>{t('courses.bulkUnpublish')}</Button>
              <Button variant="ghost" icon={<Archive size={15} />} disabled={busyId === 'bulk'} onClick={() => setBulkConfirm('archive')}>{t('courses.bulkArchive')}</Button>
              <button type="button" className="icon-btn" aria-label={t('common.clear')} onClick={() => setSelected(new Set())}><X size={16} /></button>
            </div>
          </div>
        )}

        {loading ? <Spinner label={t('common.loading')} /> : error ? <ErrorState message={error} onRetry={reload} /> : filtered.length === 0 ? (
          <EmptyState title={t('courses.empty')} action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>{t('courses.new')}</Button>} />
        ) : (
          <Table className="courses-table">
            <thead>
              <tr>
                <th className="check-cell col-check">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label={t('common.selectAll')}
                  />
                </th>
                <th className="col-title">{t('courses.field.title')}</th>
                {user?.role !== 'doctor' && <th className="col-instructor">{t('courses.instructor')}</th>}
                <th className="col-status">{t('common.status')}</th>
                <th className="col-price">{t('courses.price')}</th>
                <th className="col-lessons">{t('courses.lessons')}</th>
                <th className="col-updated">{t('courses.updated')}</th>
                <th className="align-end col-actions">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((course) => (
                <tr key={course.id} className={selected.has(course.id) ? 'selected-row' : ''}>
                  <td className="check-cell col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(course.id)}
                      onChange={() => toggleSelected(course.id)}
                      aria-label={`${t('courses.selectCourse')}: ${course.title}`}
                    />
                  </td>
                  <td className="col-title">
                    <Link to={`/courses/${course.id}`} className="strong-link">{course.title}</Link>
                    <div className="muted small">{course.short_description || '—'}</div>
                  </td>
                  {user?.role !== 'doctor' && <td className="col-instructor" data-label={t('courses.instructor')}>{course.doctor_name ?? '—'}</td>}
                  <td className="col-status" data-label={t('common.status')}><Badge value={course.status} /></td>
                  <td className="col-price" data-label={t('courses.price')}>{(Number(course.price_egp) || 0) === 0 ? t('courses.free') : formatMoney(course.price_egp, lang)}</td>
                  <td className="col-lessons" data-label={t('courses.lessons')}>{formatNumber(course.total_lessons ?? 0, lang)}</td>
                  <td className="col-updated" data-label={t('courses.updated')}>{formatDate(course.updated_at ?? course.created_at, lang)}</td>
                  <td className="align-end col-actions">
                    <div className="row-actions">
                      <Link to={`/courses/${course.id}`} className="icon-btn" aria-label={t('common.edit')}><Pencil size={16} /></Link>
                      <details className="row-menu">
                        <summary className="icon-btn" aria-label={t('common.actions')}><MoreHorizontal size={17} /></summary>
                        <div className="row-menu-popover">
                          {course.status === 'published' ? (
                            <button type="button" onClick={() => setConfirm({ course, action: 'unpublish' })}><Undo2 size={15} />{t('courses.unpublish')}</button>
                          ) : (
                            <button type="button" onClick={() => setConfirm({ course, action: 'publish' })}><Send size={15} />{t('courses.publish')}</button>
                          )}
                          <button type="button" onClick={() => runAction(course, 'duplicate')} disabled={busyId === course.id}><Copy size={15} />{t('courses.duplicate')}</button>
                          {course.status !== 'archived' && (
                            <button type="button" onClick={() => setConfirm({ course, action: 'archive' })}><Archive size={15} />{t('courses.archive')}</button>
                          )}
                          <button type="button" className="danger" onClick={() => setConfirm({ course, action: 'delete' })}><Trash2 size={15} />{t('courses.delete')}</button>
                        </div>
                      </details>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title={t('courses.createTitle')}
        wide
        footer={(
          <>
            <Button onClick={closeCreate} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="create-course-form" loading={saving}>{t('common.create')}</Button>
          </>
        )}
      >
        <form id="create-course-form" onSubmit={createCourse} className="form-grid">
          {templates.length > 0 && (
            <div className="form-span-2">
              <Select label={t('courses.startFromTemplate')} value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">—</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
              </Select>
            </div>
          )}
          <div className="form-span-2">
            <Input label={t('courses.field.title')} required maxLength={255} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
          </div>
          <div className="form-span-2">
            <Input label={t('courses.field.short')} required maxLength={2000} value={form.short_description} onChange={(e) => setForm({ ...form, short_description: e.target.value })} />
          </div>
          <div className="form-span-2">
            <Textarea label={t('courses.field.fullDescription')} required value={form.full_description} onChange={(e) => setForm({ ...form, full_description: e.target.value })} />
          </div>
          <Select label={t('courses.field.university')} value={form.university_id} onChange={(e) => setForm({ ...form, university_id: e.target.value, faculty_id: '' })}>
            <option value="">—</option>
            {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
          </Select>
          <Select label={t('courses.field.faculty')} value={form.faculty_id} onChange={(e) => setForm({ ...form, faculty_id: e.target.value })} disabled={!form.university_id}>
            <option value="">—</option>
            {faculties.map((faculty) => <option key={faculty.id} value={faculty.id}>{faculty.name}</option>)}
          </Select>
          <Select label={t('courses.field.language')} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
            {['Arabic', 'English', 'French', 'German', 'Spanish', 'Turkish', 'Urdu'].map((language) => <option key={language} value={language}>{language}</option>)}
          </Select>
          <Input label={t('courses.field.price')} type="number" min={0} step="0.01" required value={form.price_egp} onChange={(e) => setForm({ ...form, price_egp: e.target.value })} />
          <div className="form-span-2">
            <label className="file-field">
              <span>{t('courses.field.cover')}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
              {cover && <small>{cover.name}</small>}
            </label>
          </div>
          <div className="form-span-2 form-section">
            <h3>{t('courses.contact')}</h3>
            <Checkbox label={t('courses.contactDefault')} checked={form.use_default_contact} onChange={(checked) => setForm({ ...form, use_default_contact: checked })} />
            {!form.use_default_contact && (
              <div className="form-grid">
                <Input label={t('profile.whatsapp')} value={form.whatsapp} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} />
                <Input label={t('profile.telegram')} value={form.telegram} onChange={(e) => setForm({ ...form, telegram: e.target.value })} />
                <Input label={t('profile.contactPhone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            )}
          </div>
          <div className="form-span-2 form-section">
            <h3>{t('courses.settings')}</h3>
            <div className="check-grid">
              <Checkbox label={t('courses.field.sequential')} checked={form.sequential_learning} onChange={(checked) => setForm({ ...form, sequential_learning: checked })} />
              <Checkbox label={t('courses.field.freePreview')} checked={form.free_preview} onChange={(checked) => setForm({ ...form, free_preview: checked })} />
              <Checkbox label={t('courses.field.certificate')} checked={form.certificate_enabled} onChange={(checked) => setForm({ ...form, certificate_enabled: checked })} />
              <Checkbox label={t('courses.field.subscription')} checked={form.subscription_required} onChange={(checked) => setForm({ ...form, subscription_required: checked })} />
            </div>
          </div>
          {formError && <div className="form-span-2"><div className="inline-error">{formError}</div></div>}
        </form>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => { if (!importing) { setImportOpen(false); setImportResult(null); setImportRows([]); setImportErrors([]); setImportName(''); } }}
        title={t('courses.importTitle')}
        wide
        footer={(
          <>
            <Button onClick={downloadTemplate} icon={<Download size={15} />}>{t('courses.downloadTemplate')}</Button>
            <Button onClick={() => { setImportOpen(false); setImportResult(null); }} disabled={importing}>{t('common.close')}</Button>
            <Button variant="primary" loading={importing} disabled={importRows.length === 0 || importErrors.length > 0 || Boolean(importResult)} onClick={commitImport}>
              {t('courses.importConfirm').replace('{count}', String(importRows.length))}
            </Button>
          </>
        )}
      >
        <div className="stack">
          <p className="muted small">{t('courses.importHint')}</p>
          <label className="file-field">
            <span>{t('courses.chooseCsv')}</span>
            <input type="file" accept=".csv,text/csv" onChange={readImportFile} disabled={importing} />
            {importName && <small>{importName}</small>}
          </label>
          {importErrors.length > 0 && (
            <div className="inline-error" role="alert">
              {importErrors.slice(0, 8).map((message) => <div key={message}>{message}</div>)}
            </div>
          )}
          {importRows.length > 0 && !importResult && (
            <div className="import-preview">
              <h3>{t('courses.importPreview')} · {importRows.length}</h3>
              <Table>
                <thead><tr><th>#</th><th>{t('courses.field.title')}</th><th>{t('courses.field.language')}</th><th>{t('courses.field.price')}</th></tr></thead>
                <tbody>
                  {importRows.slice(0, 5).map((row, index) => (
                    <tr key={`${row.title}-${index}`}>
                      <td>{index + 2}</td><td>{row.title || '—'}</td><td>{row.language || 'Arabic'}</td><td>{row.price_egp || '0'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {importResult && (
            <div className="import-result" role="status">
              <h3>{t('courses.importSummary')}</h3>
              <p><strong>{importResult.imported}</strong> {t('common.success')} · <strong>{importResult.failed}</strong> {t('common.failed')}</p>
              {importResult.results.filter((row) => row.status === 'failed').slice(0, 8).map((row) => (
                <div key={row.row} className="inline-error">Row {row.row}: {row.message}</div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm ? t(`courses.${confirm.action}`) : ''}
        message={confirm?.action === 'delete'
          ? `${t('courses.deleteConfirm')}\n\n${confirm.course.title}`
          : confirm ? `${t(`courses.${confirm.action}`)} — ${confirm.course.title}?` : ''}
        confirmLabel={confirm ? t(`courses.${confirm.action}`) : t('common.confirm')}
        busy={Boolean(busyId)}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void runAction(confirm.course, confirm.action); }}
      />

      <ConfirmDialog
        open={Boolean(bulkConfirm)}
        title={bulkConfirm ? t(`courses.bulk${bulkConfirm[0].toUpperCase()}${bulkConfirm.slice(1)}`) : ''}
        message={t('courses.bulkConfirm').replace('{count}', String(selected.size))}
        confirmLabel={t('common.confirm')}
        busy={busyId === 'bulk'}
        onCancel={() => setBulkConfirm(null)}
        onConfirm={() => { if (bulkConfirm) void runBulk(bulkConfirm); }}
      />
    </>
  );
}
