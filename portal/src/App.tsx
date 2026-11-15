import { Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './lib/auth';
import { useI18n } from './lib/i18n';
import { AppLayout } from './components/AppLayout';
import { BrandLogo } from './components/BrandLogo';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import CourseDetail from './pages/CourseDetail';
import Students from './pages/Students';
import Users from './pages/Users';
import Academic from './pages/Academic';
import Devices from './pages/Devices';
import Credits from './pages/Credits';
import Analytics from './pages/Analytics';
import Audit from './pages/Audit';
import PdfChecker from './pages/PdfChecker';
import Notifications from './pages/Notifications';
import Profile from './pages/Profile';
import Branding from './pages/Branding';
import Cms from './pages/Cms';
import FeatureFlags from './pages/FeatureFlags';
import AppUpdates from './pages/AppUpdates';
import Support from './pages/Support';
import Maintenance from './pages/Maintenance';
import Security from './pages/Security';
import System from './pages/System';

const STAFF = ['doctor', 'admin', 'super_admin'] as const;
const ADMIN = ['admin', 'super_admin'] as const;
const SA = ['super_admin'] as const;

function RoleGate({ roles, children }: { roles: readonly string[]; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  // Session restore is asynchronous. Redirecting while it is still running
  // would turn every hard refresh of a protected deep link into a trip through
  // /login (and then /dashboard), losing the requested page.
  if (loading) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <BrandLogo variant="mark" className="app-loading-logo" decorative />
        <Loader2 size={24} className="spin" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) {
    return (
      <div className="forbidden">
        <h1>{t('error.forbidden')}</h1>
        <p className="muted">{t('dashboard.welcome')} — {user.role.replace(/_/g, ' ')}</p>
        <a className="btn btn-primary" href="/dashboard">{t('nav.dashboard')}</a>
      </div>
    );
  }
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate roles={STAFF}>
      <AppLayout>{children}</AppLayout>
    </RoleGate>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      <Route path="/dashboard" element={<Shell><Dashboard /></Shell>} />
      <Route path="/courses" element={<Shell><RoleGate roles={STAFF}><Courses /></RoleGate></Shell>} />
      <Route path="/courses/:id" element={<Shell><RoleGate roles={STAFF}><CourseDetail /></RoleGate></Shell>} />
      <Route path="/students" element={<Shell><RoleGate roles={['doctor']}><Students /></RoleGate></Shell>} />
      <Route path="/users" element={<Shell><RoleGate roles={ADMIN}><Users /></RoleGate></Shell>} />
      <Route path="/academic" element={<Shell><RoleGate roles={ADMIN}><Academic /></RoleGate></Shell>} />
      <Route path="/devices" element={<Shell><RoleGate roles={ADMIN}><Devices /></RoleGate></Shell>} />
      <Route path="/credits" element={<Shell><RoleGate roles={STAFF}><Credits /></RoleGate></Shell>} />
      <Route path="/analytics" element={<Shell><RoleGate roles={ADMIN}><Analytics /></RoleGate></Shell>} />
      <Route path="/audit" element={<Shell><RoleGate roles={ADMIN}><Audit /></RoleGate></Shell>} />
      <Route path="/pdf-checker" element={<Shell><RoleGate roles={STAFF}><PdfChecker /></RoleGate></Shell>} />
      <Route path="/notifications" element={<Shell><Notifications /></Shell>} />
      <Route path="/profile" element={<Shell><Profile /></Shell>} />

      <Route path="/branding" element={<Shell><RoleGate roles={SA}><Branding /></RoleGate></Shell>} />
      <Route path="/cms" element={<Shell><RoleGate roles={SA}><Cms /></RoleGate></Shell>} />
      <Route path="/feature-flags" element={<Shell><RoleGate roles={SA}><FeatureFlags /></RoleGate></Shell>} />
      <Route path="/app-updates" element={<Shell><RoleGate roles={SA}><AppUpdates /></RoleGate></Shell>} />
      <Route path="/support" element={<Shell><RoleGate roles={SA}><Support /></RoleGate></Shell>} />
      <Route path="/maintenance" element={<Shell><RoleGate roles={SA}><Maintenance /></RoleGate></Shell>} />
      <Route path="/security" element={<Shell><RoleGate roles={SA}><Security /></RoleGate></Shell>} />
      <Route path="/system" element={<Shell><RoleGate roles={SA}><System /></RoleGate></Shell>} />

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
