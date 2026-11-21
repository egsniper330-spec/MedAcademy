import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight, BookOpen, CalendarClock, FileText, FileUp, ScanSearch, ShieldAlert, ShieldCheck,
  ShieldQuestion, Users, X,
} from 'lucide-react';
import { api, errorMessage, uploadFile, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useDocumentTitle } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, InlineError, PageHeader, Spinner } from '../components/ui';

/**
 * PDF forensic checker.
 *
 * This page never decides identity. The backend decodes the opaque payload from the page
 * images and maps it to an issuance inside the caller's authorized scope; everything shown
 * here is exactly what the server returned.
 *
 * NO SOURCE MATERIAL IS SELECTED: the watermark payload identifies the issuance on its own,
 * so the doctor picks the suspect file and the server resolves student/material/course.
 * Every figure in the result card (course name, course count, identifiers) is server-derived
 * and already scoped to the caller's role.
 */

type Verdict = 'confirmed' | 'probable' | 'no_mark' | 'ambiguous' | 'unsupported' | 'insufficient_quality';

/**
 * What is being inspected. The two modes hit DIFFERENT endpoints but share the same
 * authorization, the same audit table and the same identity resolution: the payload in
 * the pixels is the only input in both cases.
 */
type InputMode = 'pdf' | 'image';

/** Stable reason codes the service returns for an unusable image. */
type QualityReason = 'low_resolution' | 'blurry' | 'low_contrast';

interface Course { id: string }

interface CheckResult {
  verdict: Verdict;
  /** Identical to verdict for the PDF path; for images it adds the four-way outcome. */
  input?: 'pdf' | 'image';
  result_state?: 'identified' | 'unmatched_payload' | 'no_mark' | 'insufficient_quality';
  matched: boolean;
  score?: number;
  agreement?: number;
  candidates_analyzed?: number;
  candidates_readable?: number;
  candidates_total?: number;
  quality?: { ok: boolean; reasons?: QualityReason[]; width?: number | null; height?: number | null };
  note?: string;
  issuance?: {
    watermark_record: string;
    issued_at: string;
    expires_at: string;
    course_id: string;
    course_title?: string | null;
    material_id: string;
    material_name?: string | null;
    student?: {
      id: string;
      name: string | null;
      public_user_id: string | null;
      avatar_url?: string | null;
    } | null;
    doctor?: { id: string; name: string | null } | null;
  };
}

/** Distinct, honest stages: the percentage only ever describes BYTES SENT. */
type Stage = 'idle' | 'preparing' | 'uploading' | 'uploaded' | 'analyzing' | 'done' | 'failed';

const MAX_BYTES = 26214400;
/** Matches the backend/service image ceiling; enforced here so the upload is not wasted. */
const MAX_IMAGE_BYTES = 12582912;

const VERDICT_TONE: Record<Verdict, string> = {
  confirmed: 'green',
  probable: 'amber',
  ambiguous: 'amber',
  no_mark: 'slate',
  unsupported: 'slate',
  insufficient_quality: 'slate',
};

function VerdictIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === 'confirmed') return <ShieldCheck size={15} aria-hidden="true" />;
  if (verdict === 'ambiguous') return <ShieldQuestion size={15} aria-hidden="true" />;
  return <ShieldAlert size={15} aria-hidden="true" />;
}

/**
 * Profile photo with a professional initials fallback. `onError` flips to the fallback, so a
 * dead image URL can never render as a broken icon.
 */
function StudentAvatar({ name, src }: { name: string | null; src?: string | null }) {
  const [broken, setBroken] = useState(false);
  const initials = useMemo(() => {
    const parts = (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const letters = parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
    return letters || '?';
  }, [name]);

  if (src && !broken) {
    return <img className="avatar-lg" src={src} alt="" onError={() => setBroken(true)} />;
  }
  return (
    <span className="avatar-lg avatar-fallback" aria-hidden="true">{initials}</span>
  );
}

export default function PdfChecker() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  useDocumentTitle(t('pdfcheck.title'));

  const [scopeCourseCount, setScopeCourseCount] = useState<number | null>(null);

  const [mode, setMode] = useState<InputMode>('pdf');
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const running = stage === 'preparing' || stage === 'uploading' || stage === 'uploaded' || stage === 'analyzing';

  /**
   * Course count in the CALLER'S scope: `/courses` is already role-scoped by the backend
   * (doctor → courses they own, admin → what their permissions reach, super admin → all).
   * Never derived from client-supplied ids.
   */
  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ courses: Course[] }>('/courses', { archived_at: 'is.null' }, controller.signal)
      .then((data) => setScopeCourseCount((data.courses ?? []).length))
      .catch((error) => {
        if ((error as { name?: string }).name !== 'AbortError') setScopeCourseCount(null);
      });
    return () => controller.abort();
  }, []);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    [lang],
  );

  const formatDate = (value?: string | null): string => {
    if (!value) return '—';
    const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
  };

  /** Switching the input changes what a valid file is, so the previous pick is dropped. */
  const changeMode = (next: InputMode) => {
    if (next === mode || running) return;
    setMode(next);
    setFile(null);
    setResult(null);
    setFormError(null);
    setProgress(0);
    setStage('idle');
    if (fileInput.current) fileInput.current.value = '';
  };

  const pickFile = (selected: File | null) => {
    setResult(null);
    setFormError(null);
    setProgress(0);
    setStage('idle');
    if (!selected) {
      setFile(null);
      return;
    }
    if (mode === 'pdf') {
      if (!/\.pdf$/i.test(selected.name) && selected.type !== 'application/pdf') {
        setFile(null);
        setFormError(t('pdfcheck.notPdf'));
        return;
      }
      if (selected.size > MAX_BYTES) {
        setFile(null);
        setFormError(t('pdfcheck.tooLarge'));
        return;
      }
    } else {
      // The server re-checks the file SIGNATURE; this is only a fast, friendly gate.
      if (!/^image\/(jpeg|png|webp)$/i.test(selected.type) && !/\.(jpe?g|png|webp)$/i.test(selected.name)) {
        setFile(null);
        setFormError(t('pdfcheck.notImage'));
        return;
      }
      if (selected.size > MAX_IMAGE_BYTES) {
        setFile(null);
        setFormError(t('pdfcheck.imageTooLarge'));
        return;
      }
    }
    setFile(selected);
  };

  const submit = useCallback(async () => {
    if (!file || running) return; // duplicate-submission guard
    setFormError(null);
    setResult(null);
    setProgress(0);
    setStage('preparing');

    const controller = new AbortController();
    abortRef.current = controller;

    const body = new FormData();
    body.append('file', file);

    try {
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the "preparing" paint
      setStage('uploading');

      // Image input goes to its own endpoint: no PDF container, no page loop. Both
      // endpoints share authorization, audit and payload->issuance resolution.
      const endpoint = mode === 'pdf' ? '/pdf-forensic/check' : '/pdf-forensic/check-image';
      const data = await uploadFile<CheckResult>(
        endpoint,
        body,
        (percent) => {
          setProgress(percent);
          if (percent >= 100) setStage('uploaded');
        },
        controller.signal,
      );
      setStage('analyzing');
      setResult(data);
      setStage('done');
    } catch (error) {
      setStage('failed');
      if (error instanceof ApiError && error.status === 413) setFormError(t('pdfcheck.tooLarge'));
      else if (error instanceof ApiError && error.status === 422) setFormError(t('pdfcheck.notPdf'));
      else if (error instanceof ApiError && error.status === 0) setFormError(t('pdfcheck.interrupted'));
      else setFormError(errorMessage(error));
    } finally {
      abortRef.current = null;
    }
  }, [file, mode, running, t]);

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStage('failed');
    setFormError(t('pdfcheck.cancelled'));
  };

  const reset = () => {
    setResult(null);
    setFormError(null);
    setProgress(0);
    setStage('idle');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const student = result?.issuance?.student ?? null;
  const profileHref = student
    ? user?.role === 'doctor'
      ? `/students?id=${encodeURIComponent(student.id)}`
      : `/users?id=${encodeURIComponent(student.id)}`
    : null;

  const stageLabel = (): string => {
    switch (stage) {
      case 'preparing':
        return t('pdfcheck.stage.preparing');
      case 'uploading':
        return `${t('pdfcheck.stage.uploading')} ${progress}%`;
      case 'uploaded':
        return t('pdfcheck.stage.uploaded');
      case 'analyzing':
        return t('pdfcheck.stage.analyzing');
      default:
        return t('pdfcheck.running');
    }
  };

  return (
    <div className="stack">
      <PageHeader title={t('pdfcheck.title')} subtitle={t('pdfcheck.subtitle')} />

      <Card>
        {/* INPUT MODE — a PDF, or ONE image of a page. The image path needs no PDF,
            no page set and no student id: the mark in the pixels is the only input. */}
        <div className="stack-tight">
          <span className="muted small">{t('pdfcheck.mode')}</span>
          <div className="button-row" role="group" aria-label={t('pdfcheck.mode')}>
            <Button
              type="button"
              variant={mode === 'pdf' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'pdf'}
              disabled={running}
              onClick={() => changeMode('pdf')}
            >
              {t('pdfcheck.mode.pdf')}
            </Button>
            <Button
              type="button"
              variant={mode === 'image' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'image'}
              disabled={running}
              onClick={() => changeMode('image')}
            >
              {t('pdfcheck.mode.image')}
            </Button>
          </div>
          {mode === 'image' && <p className="muted small">{t('pdfcheck.modeHint')}</p>}
        </div>

        <div className="detail-grid">
          <div>
            <span id="pdf-checker-file-label" className="muted small">
              {mode === 'pdf' ? t('pdfcheck.file') : t('pdfcheck.image')}
            </span>
            <div className="row-actions">
              <Button
                type="button"
                variant="secondary"
                icon={<FileUp size={16} />}
                disabled={running}
                onClick={() => fileInput.current?.click()}
              >
                {mode === 'pdf'
                  ? (file ? t('pdfcheck.changeFile') : t('pdfcheck.chooseFile'))
                  : (file ? t('pdfcheck.changeImage') : t('pdfcheck.chooseImage'))}
              </Button>
              <span className="muted small file-name" dir="ltr" title={file?.name ?? undefined}>
                {file ? file.name : t('pdfcheck.noFile')}
              </span>
            </div>
            <input
              id="pdf-checker-file"
              ref={fileInput}
              type="file"
              accept={mode === 'pdf' ? 'application/pdf,.pdf' : 'image/jpeg,image/png,image/webp'}
              className="sr-only"
              aria-labelledby="pdf-checker-file-label"
              disabled={running}
              onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
            />
            <p className="muted small">
              {mode === 'pdf' ? t('pdfcheck.fileHint') : t('pdfcheck.imageHint')}
            </p>
          </div>
          <div className="align-end">
            {running ? (
              <Button variant="secondary" icon={<X size={16} />} onClick={cancel}>
                {t('pdfcheck.cancel')}
              </Button>
            ) : (
              <Button variant="primary" icon={<ScanSearch size={16} />} disabled={!file} onClick={() => void submit()}>
                {mode === 'pdf' ? t('pdfcheck.run') : t('pdfcheck.runImage')}
              </Button>
            )}
          </div>
        </div>

        {running && (
          <div className="stack-tight">
            <Spinner label={stageLabel()} />
            {stage === 'uploading' && (
              <progress value={progress} max={100} aria-label={t('pdfcheck.stage.uploading')} />
            )}
          </div>
        )}
        <InlineError message={formError} />
        {stage === 'failed' && file && (
          <div className="button-row">
            <Button variant="secondary" onClick={() => void submit()}>{t('pdfcheck.retry')}</Button>
          </div>
        )}
      </Card>

      {result && (
        <Card>
          <div className="result-head">
            <h2 className="section-title">{t('pdfcheck.result')}</h2>
            <Badge tone={VERDICT_TONE[result.verdict] ?? 'slate'}>
              <VerdictIcon verdict={result.verdict} />
              <span>{t(`pdfcheck.verdict.${result.verdict}`)}</span>
            </Badge>
          </div>

          {result.matched && result.issuance && student ? (
            <>
              {/* IDENTITY — photo beside the name, statistics beside both. */}
              <div className="result-identity">
                <StudentAvatar name={student.name} src={student.avatar_url} />
                <div className="identity-copy">
                  <span className="stat-label">{t('pdfcheck.student')}</span>
                  <h3 className="identity-name">{student.name ?? '—'}</h3>
                  <div className="identity-meta">
                    {student.public_user_id && (
                      <span className="chip" dir="ltr">{student.public_user_id}</span>
                    )}
                    {profileHref && (
                      <Link className="link-inline" to={profileHref}>
                        {t('pdfcheck.openProfile')} <ArrowUpRight size={13} aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                </div>

                <div className="stat-tiles">
                  <div className="stat-tile">
                    <Users size={16} aria-hidden="true" />
                    <strong>{scopeCourseCount ?? '—'}</strong>
                    <span>{t('pdfcheck.scopeCourses')}</span>
                  </div>
                </div>
              </div>

              {/* COURSE + FORENSIC — two separated, scannable sections. */}
              <div className="result-sections">
                <section className="result-section">
                  <h4><BookOpen size={15} aria-hidden="true" /> {t('pdfcheck.course')}</h4>
                  {/* Course NAME from the server join; the UUID is only a fallback. */}
                  <p className="result-value">{result.issuance.course_title ?? result.issuance.course_id}</p>
                  {result.issuance.material_name && (
                    <p className="muted small">{result.issuance.material_name}</p>
                  )}
                </section>

                <section className="result-section">
                  <h4><CalendarClock size={15} aria-hidden="true" /> {t('pdfcheck.issuedAt')}</h4>
                  <p className="result-value">{formatDate(result.issuance.issued_at)}</p>
                </section>

                <section className="result-section">
                  <h4><FileText size={15} aria-hidden="true" /> {t('pdfcheck.status')}</h4>
                  <p className="result-value">{t(`pdfcheck.verdict.${result.verdict}`)}</p>
                  <p className="muted small">{t('pdfcheck.matched')}</p>
                </section>

                {/* IMAGE EVIDENCE — how strong the reading was, and over how many regions.
                    A photograph or crop carries less page area than a whole PDF, so the
                    doctor must see the basis of the identification. */}
                {result.input === 'image' && (
                  <section className="result-section">
                    <h4><ScanSearch size={15} aria-hidden="true" /> {t('pdfcheck.confidence')}</h4>
                    <p className="result-value">
                      {Math.round((result.score ?? 0) * 100)}%
                    </p>
                    <p className="muted small">
                      {t('pdfcheck.candidates')}: {result.candidates_readable ?? 0}/{result.candidates_total ?? 0}
                    </p>
                  </section>
                )}
              </div>
              {result.input === 'image' && (
                <p className="muted small">{t('pdfcheck.imageNote')}</p>
              )}

              {result.verdict === 'ambiguous' && <p className="muted">{t('pdfcheck.ambiguousHint')}</p>}

              {/* ACTIONS — only what this page can actually perform for every staff role. */}
              <div className="result-actions">
                <Button variant="secondary" icon={<FileUp size={16} />} onClick={reset}>{t('pdfcheck.reset')}</Button>
                <Button variant="secondary" loading={running} disabled={running} onClick={() => void submit()}>
                  {t('pdfcheck.retry')}
                </Button>
              </div>
            </>
          ) : (
            <div className="result-sections">
              <section className="result-section">
                <h4><ShieldAlert size={15} aria-hidden="true" /> {t('pdfcheck.status')}</h4>
                <p className="result-value">{t(`pdfcheck.verdict.${result.verdict}`)}</p>
                <p className="muted small">
                  {result.result_state === 'insufficient_quality'
                    ? t('pdfcheck.insufficientQuality')
                    : (result.note ?? (result.verdict === 'no_mark' ? t('pdfcheck.noMark') : t('pdfcheck.unmatched')))}
                </p>
                {/* WHY the image was rejected — low resolution, blur or flat contrast. */}
                {result.result_state === 'insufficient_quality'
                  && (result.quality?.reasons?.length ?? 0) > 0 && (
                    <p className="muted small">
                      <strong>{t('pdfcheck.quality.reasons')}:</strong>{' '}
                      {(result.quality?.reasons ?? [])
                        .map((reason) => t(`pdfcheck.quality.reason.${reason}`))
                        .join(' \u00b7 ')}
                    </p>
                  )}
                {result.input === 'image' && (
                  <p className="muted small">{t('pdfcheck.imageNote')}</p>
                )}
              </section>
              <div className="result-actions">
                <Button variant="secondary" icon={<FileUp size={16} />} onClick={reset}>{t('pdfcheck.reset')}</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {!result && !running && !formError && (
        <Card>
          <EmptyState title={t('pdfcheck.title')} hint={t('pdfcheck.empty')} />
        </Card>
      )}
    </div>
  );
}
