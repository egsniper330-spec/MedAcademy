import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowDown, ArrowLeft, ArrowUp, BookmarkPlus, Copy, FileText, FileUp, Pencil, Plus, Save, Trash2, Upload, Video,
} from 'lucide-react';
import { api, errorMessage, uploadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatBytes, formatDuration, formatNumber } from '../lib/format';
import type { Course } from './Courses';
import {
  Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, Input, Modal, PageHeader,
  Select, Spinner, Textarea, useToast,
} from '../components/ui';

interface Section { id: string; title: string; order_index: number }
interface Lesson {
  id: string;
  section_id: string;
  title: string;
  description: string | null;
  notes?: string | null;
  duration_seconds: number;
  status: string;
  order_index: number;
  video_id: string | null;
  video_asset_id?: string | null;
  video_type?: string | null;
  youtube_video_id?: string | null;
  video_title?: string | null;
  video_thumbnail_url?: string | null;
  is_preview?: number | boolean;
  download_enabled?: number | boolean;
  comments_enabled?: number | boolean;
  visible?: number | boolean;
  estimated_minutes?: number;
  scheduled_at?: string | null;
  material_url?: string | null;
  material_name?: string | null;
}
interface Material {
  id: string;
  lesson_id: string;
  file_name: string;
  file_size: number;
  file_type: string;
  download_enabled: number | boolean;
  preview_enabled: number | boolean;
  permission?: string | null;
  created_at: string;
}
interface Category { id: string; name: string }
interface CourseTemplate { id: string; title: string; source_course_id: string | null; template_data: { course?: Record<string, unknown>; sections?: Array<Record<string, unknown>> } }
interface University { id: string; name: string }
interface Faculty { id: string; name: string }
interface CourseDetailData {
  course: Course;
  sections: Section[];
  lessons: Lesson[];
  materials: Material[];
  categories: Category[];
}

interface EditForm {
  title: string;
  short_description: string;
  full_description: string;
  language: string;
  status: string;
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

const EMPTY_EDIT: EditForm = {
  title: '', short_description: '', full_description: '', language: 'Arabic', status: 'draft', price_egp: '0',
  university_id: '', faculty_id: '', use_default_contact: true, whatsapp: '', telegram: '', phone: '',
  sequential_learning: false, free_preview: false, certificate_enabled: false, subscription_required: true,
};

/** Extract the 11-character YouTube id from the URL forms the mobile app accepts. */
function youtubeIdFromInput(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const match = input.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[a-z_]+=[^&]*&)*v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
  );
  return match?.[1] ?? null;
}

function localDateTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function CourseDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const { notify } = useToast();

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<EditForm>(EMPTY_EDIT);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [universities, setUniversities] = useState<University[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [sectionTitle, setSectionTitle] = useState('');
  const [sectionEdit, setSectionEdit] = useState<{ id: string; title: string } | null>(null);
  const [lessonOpen, setLessonOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [lessonForm, setLessonForm] = useState({
    title: '', description: '', section_id: '', video_id: '', duration_seconds: '0',
    status: 'draft', order_index: '0', asset_id: '', video_type: 'youtube',
    youtube_url: '', notes: '', estimated_minutes: '0', scheduled_at: '',
    is_preview: false, download_enabled: true, comments_enabled: true, visible: true,
  });
  const [lessonError, setLessonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'section' | 'lesson'; id: string; title: string } | null>(null);
  const [materialFor, setMaterialFor] = useState<Lesson | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);

  const { data, loading, error, reload } = useAsync<CourseDetailData>(async (signal) => {
    if (!id) throw new Error('Missing course id');
    const [detail, sections, lessons, materials, categories] = await Promise.all([
      api.get<{ course: Course }>(`/courses/${id}`, undefined, signal),
      api.get<{ sections: Section[] }>(`/courses/${id}/sections`, undefined, signal),
      api.get<{ lessons: Lesson[] }>(`/courses/${id}/lessons`, undefined, signal),
      api.get<Material[]>('/api/lesson_materials', { course_id: `eq.${id}`, order: 'order_index.asc' }, signal).catch(() => []),
      api.get<{ categories: Category[] }>('/categories', undefined, signal).catch(() => ({ categories: [] })),
    ]);
    return {
      course: detail.course,
      sections: sections.sections ?? [],
      lessons: lessons.lessons ?? [],
      materials: Array.isArray(materials) ? materials : [],
      categories: categories.categories ?? [],
    };
  }, [id]);

  useDocumentTitle(data?.course.title ?? t('courses.title'));

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

  const grouped = useMemo(() => {
    const sections = [...(data?.sections ?? [])].sort((a, b) => a.order_index - b.order_index);
    return sections.map((section) => ({
      ...section,
      lessons: (data?.lessons ?? []).filter((lesson) => lesson.section_id === section.id).sort((a, b) => a.order_index - b.order_index),
    }));
  }, [data]);

  const materialCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const material of data?.materials ?? []) {
      counts.set(material.lesson_id, (counts.get(material.lesson_id) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  if (loading) return <Spinner label={t('common.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t('error.notFound')} />;

  const { course } = data;

  const openEdit = () => {
    setForm({
      title: course.title ?? '',
      short_description: course.short_description ?? '',
      full_description: course.full_description ?? course.description ?? '',
      language: course.language ?? 'Arabic',
      status: course.status ?? 'draft',
      price_egp: String(course.price_egp ?? 0),
      university_id: course.university_id ?? '',
      faculty_id: course.faculty_id ?? '',
      use_default_contact: course.use_default_contact !== 0 && course.use_default_contact !== false,
      whatsapp: course.whatsapp ?? '',
      telegram: course.telegram ?? '',
      phone: course.phone ?? '',
      sequential_learning: Boolean(course.sequential_learning),
      free_preview: Boolean(course.free_preview),
      certificate_enabled: Boolean(course.certificate_enabled),
      subscription_required: course.subscription_required !== 0 && course.subscription_required !== false,
    });
    setCover(null);
    setFormError(null);
    setEditOpen(true);
  };

  const saveCourse = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || !form.short_description.trim() || !form.full_description.trim()) {
      setFormError(t('common.required'));
      return;
    }
    if (!form.use_default_contact && !form.whatsapp.trim() && !form.telegram.trim() && !form.phone.trim()) {
      setFormError(t('courses.contactRequired'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      let imageUrl = course.image_url ?? null;
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
        imageUrl = uploaded.url;
      }
      await api.post('/rpc/update-course-audited', {
        course_id: id,
        updates: {
          title: form.title.trim(),
          short_description: form.short_description.trim(),
          full_description: form.full_description.trim(),
          description: form.full_description.trim(),
          language: form.language,
          status: form.status,
          price_egp: Number(form.price_egp) || 0,
          university_id: form.university_id || null,
          faculty_id: form.faculty_id || null,
          use_default_contact: form.use_default_contact,
          whatsapp: form.use_default_contact ? null : (form.whatsapp.trim() || null),
          telegram: form.use_default_contact ? null : (form.telegram.trim() || null),
          phone: form.use_default_contact ? null : (form.phone.trim() || null),
          sequential_learning: form.sequential_learning,
          free_preview: form.free_preview,
          certificate_enabled: form.certificate_enabled,
          subscription_required: form.subscription_required,
          image_url: imageUrl,
        },
      });
      notify(t('common.success'));
      setEditOpen(false);
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const addSection = async (event: FormEvent) => {
    event.preventDefault();
    if (!sectionTitle.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/sections', {
        course_id: id,
        title: sectionTitle.trim(),
        order_index: (data.sections.reduce((max, section) => Math.max(max, section.order_index), -1) + 1),
      });
      setSectionTitle('');
      setSectionOpen(false);
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openLesson = (sectionId: string, lesson?: Lesson) => {
    setEditingLesson(lesson ?? null);
    setLessonError(null);
    setLessonForm({
      title: lesson?.title ?? '',
      description: lesson?.description ?? '',
      section_id: lesson?.section_id ?? sectionId,
      video_id: lesson?.video_id ?? '',
      duration_seconds: String(lesson?.duration_seconds ?? 0),
      status: lesson?.status ?? 'draft',
      order_index: String(lesson?.order_index ?? 0),
      asset_id: '',
      video_type: lesson?.video_type ?? 'youtube',
      youtube_url: lesson?.youtube_video_id ? `https://youtu.be/${lesson.youtube_video_id}` : '',
      notes: lesson?.notes ?? '',
      estimated_minutes: String(lesson?.estimated_minutes ?? 0),
      scheduled_at: localDateTime(lesson?.scheduled_at),
      is_preview: Boolean(lesson?.is_preview),
      download_enabled: lesson ? Boolean(lesson.download_enabled) : true,
      comments_enabled: lesson ? Boolean(lesson.comments_enabled) : true,
      visible: lesson ? Boolean(lesson.visible) : true,
    });
    setLessonOpen(true);
  };

  const renameSection = async (event: FormEvent) => {
    event.preventDefault();
    if (!sectionEdit || !sectionEdit.title.trim()) return;
    setBusy(true);
    try {
      await api.patch(`/api/sections?id=eq.${sectionEdit.id}`, { title: sectionEdit.title.trim() });
      notify(t('common.success'));
      setSectionEdit(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const moveSection = async (section: Section, direction: -1 | 1) => {
    const ordered = [...data.sections].sort((a, b) => a.order_index - b.order_index);
    const index = ordered.findIndex((item) => item.id === section.id);
    const target = ordered[index + direction];
    if (!target) return;
    setBusy(true);
    try {
      await api.patch(`/api/sections?id=eq.${section.id}`, { order_index: target.order_index });
      await api.patch(`/api/sections?id=eq.${target.id}`, { order_index: section.order_index });
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const duplicateLesson = async (lesson: Lesson, sectionLessons: Lesson[]) => {
    setBusy(true);
    try {
      await api.post<{ id?: string }>('/api/lessons', {
        course_id: id,
        section_id: lesson.section_id,
        title: `${lesson.title} (copy)`.slice(0, 255),
        description: lesson.description,
        notes: lesson.notes,
        video_id: lesson.video_id,
        video_type: lesson.video_type ?? 'youtube',
        youtube_video_id: lesson.youtube_video_id ?? null,
        video_title: lesson.video_title ?? null,
        video_thumbnail_url: lesson.video_thumbnail_url ?? null,
        is_preview: Boolean(lesson.is_preview),
        download_enabled: Boolean(lesson.download_enabled),
        comments_enabled: Boolean(lesson.comments_enabled),
        visible: Boolean(lesson.visible),
        estimated_minutes: lesson.estimated_minutes ?? 0,
        duration_seconds: lesson.duration_seconds,
        status: 'draft',
        order_index: sectionLessons.reduce((max, item) => Math.max(max, item.order_index), -1) + 1,
      });
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const moveLesson = async (lesson: Lesson, sectionLessons: Lesson[], direction: -1 | 1) => {
    const ordered = [...sectionLessons].sort((a, b) => a.order_index - b.order_index);
    const index = ordered.findIndex((item) => item.id === lesson.id);
    const target = ordered[index + direction];
    if (!target) return;
    setBusy(true);
    try {
      await api.patch(`/api/lessons?id=eq.${lesson.id}`, { order_index: target.order_index });
      await api.patch(`/api/lessons?id=eq.${target.id}`, { order_index: lesson.order_index });
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveLesson = async (event: FormEvent) => {
    event.preventDefault();
    if (!lessonForm.title.trim()) return;
    let youtubeId: string | null = null;
    if (lessonForm.video_type === 'youtube') {
      youtubeId = youtubeIdFromInput(lessonForm.youtube_url);
      if (!youtubeId) {
        setLessonError(t('courses.youtubeInvalid'));
        return;
      }
    }
    if (lessonForm.status === 'scheduled' && !lessonForm.scheduled_at) {
      setLessonError(t('courses.scheduledAt'));
      return;
    }
    setLessonError(null);
    setBusy(true);
    try {
      const payload = {
        title: lessonForm.title.trim(),
        description: lessonForm.description,
        notes: lessonForm.notes.trim() || null,
        section_id: lessonForm.section_id,
        course_id: id,
        video_type: lessonForm.video_type,
        video_id: null,
        youtube_video_id: lessonForm.video_type === 'youtube' ? youtubeId : null,
        duration_seconds: Number(lessonForm.duration_seconds) || 0,
        estimated_minutes: Number(lessonForm.estimated_minutes) || 0,
        is_preview: lessonForm.is_preview,
        download_enabled: lessonForm.download_enabled,
        comments_enabled: lessonForm.comments_enabled,
        visible: lessonForm.visible,
        scheduled_at: lessonForm.scheduled_at ? new Date(lessonForm.scheduled_at).toISOString() : null,
        status: lessonForm.status,
        order_index: Number(lessonForm.order_index) || 0,
      };
      if (editingLesson) {
        await api.patch(`/api/lessons?id=eq.${editingLesson.id}`, payload);
      } else {
        await api.post<{ id?: string }>('/api/lessons', payload);
      }
      notify(t('common.success'));
      setLessonOpen(false);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const bulkAddLessons = async (section: Section & { lessons: Lesson[] }, files: FileList | null) => {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) return;
    setBusy(true);
    let created = 0;
    let failed = 0;
    let order = section.lessons.reduce((max, lesson) => Math.max(max, lesson.order_index), -1) + 1;
    for (const file of selectedFiles) {
      try {
        await api.post('/api/lessons', {
          course_id: id,
          section_id: section.id,
          title: file.name.replace(/\.[^/.]+$/, '').slice(0, 255) || file.name.slice(0, 255),
          status: 'draft',
          order_index: order,
          video_type: 'coming_soon',
          estimated_minutes: 0,
        });
        created += 1;
        order += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed > 0) {
      notify(t('courses.bulkLessonsPartial').replace('{created}', String(created)).replace('{failed}', String(failed)), 'error');
    } else {
      notify(t('courses.bulkLessonsCreated').replace('{count}', String(created)));
    }
    reload();
  };

  const deleteItem = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'section') {
        await api.post(`/courses/${id}/sections/${confirm.id}/delete`);
      } else {
        await api.post(`/lessons/${confirm.id}/delete`);
      }
      notify('Deleted.');
      setConfirm(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const uploadMaterial = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!materialFor || !user) return;
    const input = event.currentTarget.elements.namedItem('material-file') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadPercent(0);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${id}/${materialFor.id}/${Date.now()}_${safeName}`;
    try {
      const body = new FormData();
      body.append('bucket', 'lesson-materials');
      body.append('path', storagePath);
      body.append('file', file);
      body.append('file_name', file.name);
      body.append('declared_size', String(file.size));
      body.append('declared_size_source', 'stat');

      const uploaded = await uploadFile<{ path: string; size: number }>('/storage/upload', body, setUploadPercent);
      await api.post('/api/lesson_materials', {
        lesson_id: materialFor.id,
        course_id: id,
        uploaded_by: user.id,
        file_name: file.name,
        file_url: uploaded.path,
        storage_path: uploaded.path,
        file_type: file.type || 'application/octet-stream',
        file_size: uploaded.size,
        download_enabled: 1,
        preview_enabled: 1,
        order_index: materialCount.get(materialFor.id) ?? 0,
      });
      notify('Material uploaded.');
      setMaterialFor(null);
      reload();
    } catch (e) {
      // If bytes reached storage but the row was refused, reclaim the object.
      try { await api.post('/storage/discard-upload', { bucket: 'lesson-materials', path: storagePath }); } catch { /* best effort */ }
      notify(errorMessage(e), 'error');
    } finally {
      setUploading(false);
    }
  };

  const deleteMaterial = async (material: Material) => {
    if (!window.confirm(`Delete “${material.file_name}”?`)) return;
    try {
      await api.post(`/materials/${material.id}/delete`);
      notify('Material deleted.');
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const saveAsTemplate = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !templateName.trim()) return;
    setBusy(true);
    try {
      const templateData = {
        course: { ...course },
        sections: grouped.map((section) => ({
          title: section.title,
          order_index: section.order_index,
          lessons: section.lessons.map((lesson) => ({
            title: lesson.title,
            description: lesson.description,
            duration_seconds: lesson.duration_seconds,
            video_type: lesson.video_type,
            video_id: lesson.video_id,
            video_asset_id: lesson.video_asset_id,
            youtube_video_id: lesson.youtube_video_id,
            is_preview: Boolean(lesson.is_preview),
            download_enabled: Boolean(lesson.download_enabled),
            comments_enabled: Boolean(lesson.comments_enabled),
            visible: Boolean(lesson.visible),
            notes: lesson.notes,
            estimated_minutes: lesson.estimated_minutes ?? 0,
            order_index: lesson.order_index,
          })),
        })),
      };
      await api.post<CourseTemplate>('/api/course_templates', {
        doctor_id: user.id,
        title: templateName.trim(),
        source_course_id: id,
        template_data: templateData,
      });
      notify(t('common.success'));
      setTemplateOpen(false);
      setTemplateName('');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateMaterialPermission = async (material: Material, permission: string) => {
    try {
      await api.patch(`/api/lesson_materials?id=eq.${material.id}`, { permission });
      notify(t('common.success'));
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <Link to="/courses" className="back-link"><ArrowLeft size={16} />{t('courses.title')}</Link>
      <PageHeader
        title={course.title}
        subtitle={course.short_description ?? undefined}
        actions={(
          <>
            <Badge value={course.status} />
            <Button icon={<BookmarkPlus size={16} />} onClick={() => setTemplateOpen(true)}>{t('courses.saveTemplate')}</Button>
            <Button icon={<Save size={16} />} onClick={openEdit}>{t('common.edit')}</Button>
          </>
        )}
      />

      <div className="detail-meta">
        <span>{t('courses.price')}: <strong>{(Number(course.price_egp) || 0) === 0 ? t('courses.free') : `${formatNumber(course.price_egp, lang)} EGP`}</strong></span>
        <span>{t('courses.lessons')}: <strong>{formatNumber(data.lessons.length, lang)}</strong></span>
        <span>{t('courses.sections')}: <strong>{formatNumber(data.sections.length, lang)}</strong></span>
        <span>{t('courses.field.language')}: <strong>{course.language ?? '—'}</strong></span>
        <span>{t('courses.instructor')}: <strong>{course.doctor_name ?? '—'}</strong></span>
      </div>

      <div className="card-head standalone">
        <h2>{t('courses.content')}</h2>
        <Button icon={<Plus size={16} />} onClick={() => setSectionOpen(true)}>{t('courses.addSection')}</Button>
      </div>

      {grouped.length === 0 ? (
        <Card><EmptyState title={t('common.empty')} hint={t('courses.addSection')} action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setSectionOpen(true)}>{t('courses.addSection')}</Button>} /></Card>
      ) : grouped.map((section, sectionIndex) => (
        <Card key={section.id} className="curriculum-card">
          <div className="curriculum-head">
            <div>
              <span className="eyebrow">{t('courses.sectionN')} {section.order_index + 1}</span>
              <h3>{section.title}</h3>
            </div>
            <div className="row-actions">
              <Button variant="ghost" icon={<Plus size={15} />} onClick={() => openLesson(section.id)}>{t('courses.addLesson')}</Button>
              <label className="btn btn-ghost" style={{ cursor: busy ? 'not-allowed' : 'pointer' }} title={t('courses.bulkLessonsHint')}>
                <FileUp size={15} />{t('courses.bulkAddLessons')}
                <input
                  type="file"
                  multiple
                  disabled={busy}
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    void bulkAddLessons(section, event.target.files);
                    event.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="icon-btn" aria-label={t('courses.renameSection')} onClick={() => setSectionEdit({ id: section.id, title: section.title })}><Pencil size={15} /></button>
              <button type="button" className="icon-btn" aria-label={t('courses.moveUp')} disabled={sectionIndex === 0 || busy} onClick={() => moveSection(section, -1)}><ArrowUp size={15} /></button>
              <button type="button" className="icon-btn" aria-label={t('courses.moveDown')} disabled={sectionIndex === grouped.length - 1 || busy} onClick={() => moveSection(section, 1)}><ArrowDown size={15} /></button>
              <button type="button" className="icon-btn danger" aria-label={t('courses.deleteSection')} onClick={() => setConfirm({ kind: 'section', id: section.id, title: section.title })}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>
          {section.lessons.length === 0 ? (
            <p className="muted small padded-small">{t('common.empty')}</p>
          ) : (
            <ul className="lesson-list">
              {section.lessons.map((lesson, lessonIndex) => {
                const materials = (data.materials ?? []).filter((material) => material.lesson_id === lesson.id);
                return (
                  <li key={lesson.id}>
                    <div className="lesson-main">
                      <span className="lesson-order">{lesson.order_index + 1}</span>
                      <div>
                        <div className="lesson-title-row">
                          <strong>{lesson.title}</strong>
                          <Badge value={lesson.status} />
                          {lesson.video_id && <span className="chip"><Video size={12} />{lesson.video_id.slice(0, 10)}…</span>}
                        </div>
                        <span className="muted small">{formatDuration(lesson.duration_seconds)} · {materials.length} {t('courses.materials').toLowerCase()}</span>
                        {materials.length > 0 && (
                          <ul className="material-list">
                            {materials.map((material) => (
                              <li key={material.id}>
                                <FileText size={14} />
                                <span className="material-name">{material.file_name}</span>
                                <span className="muted small">{formatBytes(material.file_size)}</span>
                                <Select
                                  aria-label={t('courses.materialAccess')}
                                  value={material.permission ?? 'allow'}
                                  onChange={(event) => void updateMaterialPermission(material, event.target.value)}
                                >
                                  <option value="allow">{t('courses.permissionAllow')}</option>
                                  <option value="preview_only">{t('courses.permissionPreview')}</option>
                                  <option value="hidden">{t('courses.permissionHidden')}</option>
                                  <option value="disabled">{t('courses.permissionDisabled')}</option>
                                </Select>
                                <button type="button" className="icon-btn danger tiny" aria-label={t('common.delete')} onClick={() => deleteMaterial(material)}><Trash2 size={13} /></button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="icon-btn" aria-label={t('courses.moveUp')} disabled={lessonIndex === 0 || busy} onClick={() => moveLesson(lesson, section.lessons, -1)}><ArrowUp size={14} /></button>
                      <button type="button" className="icon-btn" aria-label={t('courses.moveDown')} disabled={lessonIndex === section.lessons.length - 1 || busy} onClick={() => moveLesson(lesson, section.lessons, 1)}><ArrowDown size={14} /></button>
                      <button type="button" className="icon-btn" aria-label={t('courses.duplicateLesson')} disabled={busy} onClick={() => duplicateLesson(lesson, section.lessons)}><Copy size={14} /></button>
                      <Button variant="ghost" icon={<Upload size={15} />} onClick={() => setMaterialFor(lesson)}>{t('courses.uploadMaterial')}</Button>
                      <Button variant="ghost" icon={<Save size={15} />} onClick={() => openLesson(lesson.section_id, lesson)}>{t('common.edit')}</Button>
                      <button type="button" className="icon-btn danger" aria-label={t('courses.deleteLesson')} onClick={() => setConfirm({ kind: 'lesson', id: lesson.id, title: lesson.title })}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ))}

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t('courses.editTitle')}
        wide
        footer={(
          <>
            <Button onClick={() => setEditOpen(false)} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="edit-course-form" loading={saving}>{t('common.save')}</Button>
          </>
        )}
      >
        <form id="edit-course-form" onSubmit={saveCourse} className="form-grid">
          <div className="form-span-2">
            <Input label={t('courses.field.title')} required maxLength={255} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
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
          <Select label={t('common.status')} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="draft">{t('common.draft')}</option>
            <option value="published">{t('common.published')}</option>
            {user?.role !== 'doctor' && <option value="hidden">{t('common.hidden')}</option>}
          </Select>
          <Select label={t('courses.field.language')} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
            {['Arabic', 'English', 'French', 'German', 'Spanish', 'Turkish', 'Urdu'].map((language) => <option key={language} value={language}>{language}</option>)}
          </Select>
          <Input label={t('courses.field.price')} type="number" min={0} step="0.01" value={form.price_egp} onChange={(e) => setForm({ ...form, price_egp: e.target.value })} />
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
        open={sectionOpen}
        onClose={() => setSectionOpen(false)}
        title={t('courses.addSection')}
        footer={(
          <>
            <Button onClick={() => setSectionOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="section-form" loading={busy}>{t('common.create')}</Button>
          </>
        )}
      >
        <form id="section-form" onSubmit={addSection}>
          <Input label={t('courses.sectionTitle')} required value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} autoFocus />
        </form>
      </Modal>

      <Modal
        open={lessonOpen}
        onClose={() => setLessonOpen(false)}
        title={editingLesson ? t('common.edit') : t('courses.addLesson')}
        wide
        footer={(
          <>
            <Button onClick={() => setLessonOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="lesson-form" loading={busy}>{t('common.save')}</Button>
          </>
        )}
      >
        <form id="lesson-form" onSubmit={saveLesson} className="form-grid">
          <div className="form-span-2">
            <Input label={t('courses.lessonTitle')} required value={lessonForm.title} onChange={(e) => setLessonForm({ ...lessonForm, title: e.target.value })} autoFocus />
          </div>
          <div className="form-span-2">
            <Textarea label={t('courses.field.description')} value={lessonForm.description} onChange={(e) => setLessonForm({ ...lessonForm, description: e.target.value })} />
          </div>
          <div className="form-span-2">
            <Textarea label={t('courses.lessonNotes')} placeholder={t('courses.lessonNotesPlaceholder')} value={lessonForm.notes} onChange={(e) => setLessonForm({ ...lessonForm, notes: e.target.value })} />
          </div>
          <Select label={t('courses.sections')} value={lessonForm.section_id} onChange={(e) => setLessonForm({ ...lessonForm, section_id: e.target.value })}>
            {data.sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
          </Select>
          <Select label={t('common.status')} value={lessonForm.status} onChange={(e) => setLessonForm({ ...lessonForm, status: e.target.value })}>
            <option value="draft">{t('common.draft')}</option>
            <option value="published">{t('common.published')}</option>
            <option value="hidden">{t('common.hidden')}</option>
            <option value="scheduled">{t('common.scheduled')}</option>
            <option value="archived">{t('common.archived')}</option>
          </Select>
          <Select label={t('courses.videoSource')} value={lessonForm.video_type} onChange={(e) => setLessonForm({ ...lessonForm, video_type: e.target.value })}>
            <option value="youtube">{t('courses.videoYoutube')}</option>
            <option value="coming_soon">{t('courses.videoComingSoon')}</option>
          </Select>
          <div className="field-stack">
            {/* Video uploads are retired with VdoCipher: YouTube is the only supported
                source, so a lesson either carries a YouTube URL or is marked coming soon. */}
            {lessonForm.video_type === 'youtube' ? (
              <Input
                label={t('courses.youtubeUrl')}
                placeholder="https://youtube.com/watch?v=…"
                value={lessonForm.youtube_url}
                onChange={(e) => setLessonForm({ ...lessonForm, youtube_url: e.target.value })}
              />
            ) : (
              <p className="muted small">{t('courses.videoComingSoon')}</p>
            )}
          </div>
          <Input label={t('courses.lessonDuration')} type="number" min={0} value={lessonForm.duration_seconds} onChange={(e) => setLessonForm({ ...lessonForm, duration_seconds: e.target.value })} />
          <Input label={t('courses.estimatedMinutes')} type="number" min={0} value={lessonForm.estimated_minutes} onChange={(e) => setLessonForm({ ...lessonForm, estimated_minutes: e.target.value })} />
          <Input label="Order" type="number" min={0} value={lessonForm.order_index} onChange={(e) => setLessonForm({ ...lessonForm, order_index: e.target.value })} />
          <Input label={t('courses.scheduledAt')} type="datetime-local" value={lessonForm.scheduled_at} onChange={(e) => setLessonForm({ ...lessonForm, scheduled_at: e.target.value })} disabled={lessonForm.status !== 'scheduled'} />
          <div className="form-span-2 form-section">
            <h3>{t('courses.lessonSettings')}</h3>
            <div className="check-grid">
              <Checkbox label={t('courses.lessonPreview')} checked={lessonForm.is_preview} onChange={(checked) => setLessonForm({ ...lessonForm, is_preview: checked })} />
              <Checkbox label={t('courses.downloadEnabled')} checked={lessonForm.download_enabled} onChange={(checked) => setLessonForm({ ...lessonForm, download_enabled: checked })} />
              <Checkbox label={t('courses.commentsEnabled')} checked={lessonForm.comments_enabled} onChange={(checked) => setLessonForm({ ...lessonForm, comments_enabled: checked })} />
              <Checkbox label={t('courses.lessonVisible')} checked={lessonForm.visible} onChange={(checked) => setLessonForm({ ...lessonForm, visible: checked })} />
            </div>
          </div>
          {lessonError && <div className="form-span-2"><div className="inline-error">{lessonError}</div></div>}
        </form>
      </Modal>

      <Modal
        open={Boolean(sectionEdit)}
        onClose={() => setSectionEdit(null)}
        title={t('courses.renameSection')}
        footer={(
          <>
            <Button onClick={() => setSectionEdit(null)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="rename-section-form" loading={busy}>{t('common.save')}</Button>
          </>
        )}
      >
        <form id="rename-section-form" onSubmit={renameSection}>
          <Input label={t('courses.sectionTitle')} required value={sectionEdit?.title ?? ''} onChange={(e) => setSectionEdit({ id: sectionEdit?.id ?? '', title: e.target.value })} autoFocus />
        </form>
      </Modal>

      <Modal
        open={Boolean(materialFor)}
        onClose={() => { if (!uploading) setMaterialFor(null); }}
        title={`${t('courses.uploadMaterial')} — ${materialFor?.title ?? ''}`}
        footer={<Button onClick={() => setMaterialFor(null)} disabled={uploading}>{t('common.close')}</Button>}
      >
        <form onSubmit={uploadMaterial} className="stack">
          <p className="muted small">{t('courses.materialHint')}</p>
          <input name="material-file" type="file" required accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip,image/*" />
          {uploading && (
            <div className="progress">
              <div className="progress-bar" style={{ width: `${uploadPercent}%` }} />
              <span>{uploadPercent}%</span>
            </div>
          )}
          <Button type="submit" variant="primary" icon={<Upload size={16} />} loading={uploading} disabled={uploading}>Upload</Button>
        </form>
      </Modal>

      <Modal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title={t('courses.saveTemplate')}
        footer={(
          <>
            <Button onClick={() => setTemplateOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="template-form" loading={busy}>{t('common.save')}</Button>
          </>
        )}
      >
        <form id="template-form" onSubmit={saveAsTemplate} className="stack">
          <p className="muted small">{t('courses.saveTemplateHint')}</p>
          <Input label={t('courses.templateName')} required maxLength={255} value={templateName} onChange={(e) => setTemplateName(e.target.value)} autoFocus />
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === 'section' ? t('courses.deleteSection') : t('courses.deleteLesson')}
        message={confirm ? `Delete “${confirm.title}”? This cannot be undone.` : ''}
        confirmLabel={t('common.delete')}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={deleteItem}
      />
    </>
  );
}
