import { Link } from 'react-router-dom';
import {
  Activity, BookOpen, CreditCard, FileText, GraduationCap, MonitorSmartphone, Plus, Users, Wallet,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate, formatNumber } from '../lib/format';
import {
  Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, StatCard,
} from '../components/ui';

interface Stats {
  users: number;
  doctors: number;
  courses: number;
  enrollments: number;
  active_devices: number;
  trashed_users: number;
}

interface Course {
  id: string;
  title: string;
  status: string;
  price_egp: number | null;
  total_lessons: number | null;
  created_at: string;
}

interface CreditBalance { allocated: number; consumed: number; remaining: number }
interface StudentEnrollment { id: string; student?: { full_name?: string }; course?: { title?: string } }
interface AuditLog { id: string; action: string; created_at: string; actor_name?: string; actor_email?: string }

export default function Dashboard() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const isDoctor = user?.role === 'doctor';
  useDocumentTitle(t('nav.dashboard'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    if (isDoctor) {
      const [courses, credits, students] = await Promise.all([
        api.get<{ courses: Course[] }>('/courses', { archived_at: 'is.null' }, signal),
        api.get<CreditBalance>('/credits/me', undefined, signal).catch(() => ({ allocated: 0, consumed: 0, remaining: 0 })),
        api.get<StudentEnrollment[]>('/doctors/students', undefined, signal).catch(() => []),
      ]);
      return { courses: courses.courses ?? [], credits, students };
    }
    const [stats, audit] = await Promise.all([
      api.get<Stats>('/admin/stats', undefined, signal),
      api.get<{ logs: AuditLog[] }>('/admin/audit-logs', { limit: 8 }, signal).catch(() => ({ logs: [] })),
    ]);
    return { stats, audit: audit.logs ?? [] };
  }, [isDoctor]);

  if (loading) return <Spinner label={t('common.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  if (isDoctor) {
    const courses = (data as { courses: Course[] }).courses;
    const credits = (data as { credits: CreditBalance }).credits;
    const students = (data as { students: StudentEnrollment[] }).students;
    const published = courses.filter((course) => course.status === 'published').length;

    return (
      <>
        <PageHeader
          title={`${t('dashboard.welcome')}, ${user?.full_name?.split(' ')[0] ?? ''}`}
          subtitle={t('dashboard.doctorSub')}
          actions={<Link to="/courses?new=1"><Button variant="primary" icon={<Plus size={16} />}>{t('dashboard.newCourse')}</Button></Link>}
        />
        <div className="stats-grid">
          <StatCard label={t('dashboard.myCourses')} value={formatNumber(courses.length, lang)} hint={`${published} ${t('common.published')}`} icon={<BookOpen size={20} />} />
          <StatCard label={t('dashboard.myStudents')} value={formatNumber(students.length, lang)} icon={<GraduationCap size={20} />} tone="green" />
          <StatCard label={t('credits.balance')} value={formatNumber(credits.remaining, lang)} hint={`${formatNumber(credits.consumed, lang)} ${t('credits.consumed')}`} icon={<Wallet size={20} />} tone="amber" />
          <StatCard label={t('credits.allocated')} value={formatNumber(credits.allocated, lang)} icon={<CreditCard size={20} />} tone="violet" />
        </div>

        <div className="dashboard-grid">
          <Card>
            <div className="card-head">
              <h2>{t('dashboard.recentCourses')}</h2>
              <Link to="/courses" className="text-link">{t('nav.courses')}</Link>
            </div>
            {courses.length === 0 ? <EmptyState title={t('courses.empty')} hint={t('dashboard.newCourse')} /> : (
              <ul className="simple-list">
                {courses.slice(0, 6).map((course) => (
                  <li key={course.id}>
                    <div>
                      <Link to={`/courses/${course.id}`} className="strong-link">{course.title}</Link>
                      <span className="muted small">{[course.total_lessons ?? 0, t('courses.lessons'), formatDate(course.created_at, lang)].join(' · ')}</span>
                    </div>
                    <Badge value={course.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="card-head">
              <h2>{t('dashboard.quickActions')}</h2>
            </div>
            <div className="quick-actions">
              <Link to="/courses?new=1"><Button icon={<Plus size={16} />} className="btn-block">{t('dashboard.newCourse')}</Button></Link>
              <Link to="/students"><Button icon={<GraduationCap size={16} />} className="btn-block">{t('dashboard.myStudents')}</Button></Link>
              <Link to="/credits"><Button icon={<Wallet size={16} />} className="btn-block">{t('nav.credits')}</Button></Link>
              <Link to="/notifications"><Button icon={<Activity size={16} />} className="btn-block">{t('nav.notifications')}</Button></Link>
            </div>
          </Card>
        </div>
      </>
    );
  }

  const stats = (data as { stats: Stats }).stats;
  const audit = (data as { audit: AuditLog[] }).audit;

  return (
    <>
      <PageHeader title={t('nav.dashboard')} subtitle={t('dashboard.adminSub')} />
      <div className="stats-grid">
        <StatCard label={t('dashboard.users')} value={formatNumber(stats.users, lang)} icon={<Users size={20} />} />
        <StatCard label={t('dashboard.doctors')} value={formatNumber(stats.doctors, lang)} icon={<GraduationCap size={20} />} tone="violet" />
        <StatCard label={t('dashboard.courses')} value={formatNumber(stats.courses, lang)} icon={<BookOpen size={20} />} tone="green" />
        <StatCard label={t('dashboard.enrollments')} value={formatNumber(stats.enrollments, lang)} icon={<CreditCard size={20} />} tone="amber" />
        <StatCard label={t('dashboard.devices')} value={formatNumber(stats.active_devices, lang)} icon={<MonitorSmartphone size={20} />} />
        <StatCard label={t('dashboard.trashed')} value={formatNumber(stats.trashed_users, lang)} icon={<FileText size={20} />} tone="red" />
      </div>

      <div className="dashboard-grid">
        <Card>
          <div className="card-head"><h2>{t('dashboard.recentActivity')}</h2><Link to="/audit" className="text-link">{t('nav.audit')}</Link></div>
          {audit.length === 0 ? <EmptyState title={t('common.empty')} /> : (
            <ul className="simple-list">
              {audit.map((log) => (
                <li key={log.id}>
                  <div>
                    <strong className="small">{log.action.replace(/_/g, ' ')}</strong>
                    <span className="muted small">{log.actor_name ?? log.actor_email ?? 'System'} · {formatDate(log.created_at, lang, true)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <div className="card-head"><h2>{t('dashboard.quickActions')}</h2></div>
          <div className="quick-actions">
            <Link to="/users"><Button icon={<Users size={16} />} className="btn-block">{t('dashboard.manageUsers')}</Button></Link>
            <Link to="/courses"><Button icon={<BookOpen size={16} />} className="btn-block">{t('nav.courses')}</Button></Link>
            <Link to="/analytics"><Button icon={<Activity size={16} />} className="btn-block">{t('dashboard.viewReports')}</Button></Link>
            <Link to="/audit"><Button icon={<FileText size={16} />} className="btn-block">{t('dashboard.reviewAudit')}</Button></Link>
          </div>
        </Card>
      </div>
    </>
  );
}
