import { Activity, BookOpen, ShieldAlert, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate, formatNumber } from '../lib/format';
import {
  Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, StatCard, Table,
} from '../components/ui';

interface Summary {
  totals: {
    enrollments: number;
    unique_students: number;
    courses_with_enrollments: number;
    doctors_with_enrollments: number;
    courses_total: number;
    doctors_total: number;
  };
}
interface DoctorRow {
  doctor_id: string;
  full_name: string;
  email: string;
  status: string;
  courses_count: number;
  enrollments: number;
  unique_students: number;
}
interface CourseRow {
  course_id: string;
  title: string;
  status: string;
  doctor_name: string;
  enrollments: number;
  unique_students: number;
  last_enrolled_at: string | null;
}
interface SecurityStats {
  total_events: number;
  recent_events_24h: number;
  root_jailbreak: number;
  vpn: number;
  proxy: number;
  ssl_pinning: number;
  screenshot: number;
  screen_recording: number;
  debug: number;
  app_integrity: number;
  by_type: { event_type: string; count: number }[];
}

export default function Analytics() {
  const { t, lang } = useI18n();
  useDocumentTitle(t('analytics.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    const [summary, doctors, courses, security] = await Promise.all([
      api.get<Summary>('/analytics/enrollment-stats', undefined, signal),
      api.get<{ rows: DoctorRow[] }>('/analytics/enrollment-stats/doctors', { per_page: 10, sort: 'enrollments', order: 'desc' }, signal),
      api.get<{ rows: CourseRow[] }>('/analytics/enrollment-stats/courses', { per_page: 12, sort: 'enrollments', order: 'desc' }, signal),
      api.get<SecurityStats>('/analytics/security-stats', undefined, signal).catch(() => null),
    ]);
    return { summary, doctors: doctors.rows ?? [], courses: courses.rows ?? [], security };
  }, []);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState />;

  const { totals } = data.summary;
  const security = data.security;

  return (
    <>
      <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
      <div className="stats-grid">
        <StatCard label={t('dashboard.enrollments')} value={formatNumber(totals.enrollments, lang)} icon={<Activity size={20} />} />
        <StatCard label={t('students.title')} value={formatNumber(totals.unique_students, lang)} icon={<Users size={20} />} tone="green" />
        <StatCard label={t('dashboard.courses')} value={formatNumber(totals.courses_total, lang)} hint={`${formatNumber(totals.courses_with_enrollments, lang)} with enrollments`} icon={<BookOpen size={20} />} tone="violet" />
        <StatCard label={t('dashboard.doctors')} value={formatNumber(totals.doctors_total, lang)} hint={`${formatNumber(totals.doctors_with_enrollments, lang)} with enrollments`} icon={<Users size={20} />} tone="amber" />
        {security && <StatCard label={t('analytics.security')} value={formatNumber(security.total_events, lang)} hint={`${formatNumber(security.recent_events_24h, lang)} in 24h`} icon={<ShieldAlert size={20} />} tone="red" />}
      </div>

      <div className="dashboard-grid">
        <Card padded={false}>
          <div className="card-head padded-head"><h2>{t('analytics.doctors')}</h2></div>
          {data.doctors.length === 0 ? <EmptyState title={t('analytics.noData')} /> : (
            <Table>
              <thead><tr><th>{t('common.name')}</th><th>{t('dashboard.courses')}</th><th>{t('dashboard.enrollments')}</th><th>{t('students.title')}</th></tr></thead>
              <tbody>
                {data.doctors.map((doctor) => (
                  <tr key={doctor.doctor_id}>
                    <td><strong>{doctor.full_name}</strong><div className="muted small">{doctor.email}</div></td>
                    <td>{formatNumber(doctor.courses_count, lang)}</td>
                    <td>{formatNumber(doctor.enrollments, lang)}</td>
                    <td>{formatNumber(doctor.unique_students, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card padded={false}>
          <div className="card-head padded-head"><h2>{t('analytics.security')}</h2></div>
          {!security ? <EmptyState title={t('analytics.noData')} /> : (
            <div className="security-counters">
              {[
                ['Root / jailbreak', security.root_jailbreak], ['VPN', security.vpn], ['Proxy', security.proxy],
                ['SSL pinning', security.ssl_pinning], ['Screenshot', security.screenshot],
                ['Screen recording', security.screen_recording], ['Debug', security.debug], ['App integrity', security.app_integrity],
              ].map(([label, value]) => (
                <div key={String(label)}><span>{label}</span><strong>{formatNumber(Number(value), lang)}</strong></div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card padded={false}>
        <div className="card-head padded-head"><h2>{t('analytics.enrollments')}</h2></div>
        {data.courses.length === 0 ? <EmptyState title={t('analytics.noData')} /> : (
          <Table>
            <thead><tr><th>{t('courses.field.title')}</th><th>{t('courses.instructor')}</th><th>{t('common.status')}</th><th>{t('dashboard.enrollments')}</th><th>{t('students.title')}</th><th>{t('students.enrolled')}</th></tr></thead>
            <tbody>
              {data.courses.map((course) => (
                <tr key={course.course_id}>
                  <td><strong>{course.title}</strong></td>
                  <td>{course.doctor_name}</td>
                  <td><Badge value={course.status} /></td>
                  <td>{formatNumber(course.enrollments, lang)}</td>
                  <td>{formatNumber(course.unique_students, lang)}</td>
                  <td>{formatDate(course.last_enrolled_at, lang, true)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
