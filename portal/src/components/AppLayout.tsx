import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, BadgeCheck, Bell, BookOpen, Building2, ChevronDown, FileText, Flag,
  GraduationCap, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Palette, Search,
  Moon, ScanSearch, ShieldCheck, Smartphone, Sparkles, Sun, Users, Wallet, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { Badge } from './ui';
import { BrandLogo } from './BrandLogo';

type StaffRole = 'doctor' | 'admin' | 'super_admin';

interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  roles: StaffRole[];
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

const ALL: StaffRole[] = ['doctor', 'admin', 'super_admin'];
const STAFF: StaffRole[] = ['admin', 'super_admin'];

const NAV: NavGroup[] = [
  {
    labelKey: 'nav.overview',
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, roles: ALL },
    ],
  },
  {
    labelKey: 'nav.workspace',
    items: [
      { to: '/courses', labelKey: 'nav.courses', icon: BookOpen, roles: ALL },
      { to: '/students', labelKey: 'nav.students', icon: GraduationCap, roles: ['doctor'] },
      { to: '/users', labelKey: 'nav.users', icon: Users, roles: STAFF },
      { to: '/academic', labelKey: 'nav.academic', icon: Building2, roles: STAFF },
      { to: '/devices', labelKey: 'nav.devices', icon: MonitorSmartphone, roles: STAFF },
      { to: '/credits', labelKey: 'nav.credits', icon: Wallet, roles: ALL },
      // PDF Checker takes the slot the Video Library held: VdoCipher is retired and the
      // checker is the document tool staff actually use. One page, one route.
      { to: '/pdf-checker', labelKey: 'nav.pdfChecker', icon: ScanSearch, roles: ALL },
      { to: '/analytics', labelKey: 'nav.analytics', icon: Activity, roles: STAFF },
      { to: '/audit', labelKey: 'nav.audit', icon: FileText, roles: STAFF },
    ],
  },
  {
    labelKey: 'nav.platform',
    items: [
      { to: '/branding', labelKey: 'nav.branding', icon: Palette, roles: ['super_admin'] },
      { to: '/cms', labelKey: 'nav.cms', icon: Sparkles, roles: ['super_admin'] },
      { to: '/feature-flags', labelKey: 'nav.flags', icon: Flag, roles: ['super_admin'] },
      { to: '/app-updates', labelKey: 'nav.updates', icon: Smartphone, roles: ['super_admin'] },
      { to: '/support', labelKey: 'nav.support', icon: BadgeCheck, roles: ['super_admin'] },
    ],
  },
  {
    labelKey: 'nav.security',
    items: [
      { to: '/maintenance', labelKey: 'nav.maintenance', icon: Wrench, roles: ['super_admin'] },
      { to: '/security', labelKey: 'nav.security.settings', icon: ShieldCheck, roles: ['super_admin'] },
      { to: '/system', labelKey: 'nav.system', icon: Activity, roles: ['super_admin'] },
    ],
  },
];

function navFor(role: StaffRole | undefined): NavGroup[] {
  if (!role) return [];
  return NAV
    .map((group) => ({ ...group, items: group.items.filter((item) => item.roles.includes(role)) }))
    .filter((group) => group.items.length > 0);
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { t, lang, setLang } = useI18n();
  const { preference, resolved, setPreference } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const role = user?.role as StaffRole | undefined;
  const groups = useMemo(() => navFor(role), [role]);

  const searchable = useMemo(() => {
    const items = groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.labelKey })));
    return [
      ...items,
      { to: '/notifications', labelKey: 'nav.notifications', icon: Bell, group: 'nav.overview' },
      { to: '/profile', labelKey: 'nav.profile', icon: Users, group: 'nav.overview' },
    ];
  }, [groups]);

  const needle = query.trim().toLowerCase();
  const results = useMemo(
    () => (needle ? searchable.filter((item) => t(item.labelKey).toLowerCase().includes(needle)) : []),
    [needle, searchable, t],
  );

  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
    setSearchOpen(false);
    setQuery('');
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        setMenuOpen(false);
        setSearchOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const goToResult = (to: string) => {
    navigate(to);
    setQuery('');
    setSearchOpen(false);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && results.length > 0) {
      event.preventDefault();
      goToResult(results[0].to);
    }
    if (event.key === 'Escape') {
      setQuery('');
      setSearchOpen(false);
    }
  };

  const initials = (user?.full_name ?? user?.email ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <div className="app-shell">
      {drawerOpen && (
        <button
          type="button"
          className="drawer-scrim"
          aria-label={t('shell.closeMenu')}
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="sidebar-brand-lockup">
            <BrandLogo variant="compact" className="sidebar-brand-logo" />
            <span className="brand-subtitle">{t('app.portal')}</span>
          </div>
          <button
            type="button"
            className="icon-btn sidebar-close"
            onClick={() => setDrawerOpen(false)}
            aria-label={t('shell.closeMenu')}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="side-nav" aria-label={t('shell.mainNav')}>
          {groups.map((group) => (
            <div className="nav-group" key={group.labelKey}>
              <span className="nav-group-label">{t(group.labelKey)}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                >
                  <item.icon size={18} strokeWidth={1.8} />
                  <span>{t(item.labelKey)}</span>
                </NavLink>
              ))}
            </div>
          ))}
          <div className="nav-group">
            <span className="nav-group-label">{t('nav.account')}</span>
            <NavLink to="/notifications" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Bell size={18} strokeWidth={1.8} /><span>{t('nav.notifications')}</span>
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Users size={18} strokeWidth={1.8} /><span>{t('nav.profile')}</span>
            </NavLink>
          </div>
        </nav>

        <div className="sidebar-foot">
          <ShieldCheck size={16} />
          <span>{t('shell.secureSession')}</span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label={t('shell.openMenu')}
          >
            <Menu size={20} />
          </button>

          <div className="topbar-title">
            <span className="topbar-mobile-brand">
              <BrandLogo variant="mark" className="topbar-mobile-logo" />
            </span>
          </div>

          <div
            className="topbar-search"
            role="search"
            onFocus={() => { if (needle) setSearchOpen(true); }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setSearchOpen(false);
              }
            }}
          >
            <Search size={17} aria-hidden="true" />
            <label htmlFor="portal-page-search" className="sr-only">{t('topbar.search')}</label>
            <input
              id="portal-page-search"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(Boolean(event.target.value.trim()));
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={t('topbar.search')}
              autoComplete="off"
            />
            {searchOpen && needle && (
              <div className="topbar-search-results" role="menu" aria-label={t('topbar.search')}>
                {results.length === 0 ? (
                  <div className="search-empty">{t('topbar.noResults')}</div>
                ) : results.map((item) => (
                  <button
                    key={item.to}
                    type="button"
                    role="menuitem"
                    onClick={() => goToResult(item.to)}
                  >
                    <item.icon size={16} />
                    <span>{t(item.labelKey)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn theme-toggle"
              onClick={() => setPreference(resolved === 'dark' ? 'light' : 'dark')}
              aria-label={t('theme.switch')}
              title={`${t('theme.label')}: ${t(`theme.${resolved}`)}`}
            >
              {resolved === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <NavLink
              to="/notifications"
              className="icon-btn topbar-notifications"
              aria-label={t('nav.notifications')}
              title={t('nav.notifications')}
            >
              <Bell size={19} strokeWidth={1.8} />
            </NavLink>

            <div className="lang-switch" role="group" aria-label={t('common.language')}>
              <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
              <button type="button" className={lang === 'ar' ? 'active' : ''} onClick={() => setLang('ar')}>AR</button>
            </div>

            <div className="user-menu">
              <button
                type="button"
                className="user-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span className="avatar">{initials}</span>
                <span className="user-copy">
                  <strong>{user?.full_name ?? user?.email}</strong>
                  <Badge value={user?.role} />
                </span>
                <ChevronDown size={15} />
              </button>
              {menuOpen && (
                <div className="user-popover" role="menu">
                  <div className="user-popover-head">
                    <strong>{user?.full_name}</strong>
                    <span>{user?.email}</span>
                  </div>
                  <button type="button" role="menuitem" onClick={() => navigate('/profile')}>
                    <Users size={16} />{t('nav.profile')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => navigate('/notifications')}>
                    <Bell size={16} />{t('nav.notifications')}
                  </button>
                  <div className="theme-options" role="group" aria-label={t('theme.label')}>
                    {(['light', 'dark', 'system'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={preference === option ? 'active' : ''}
                        aria-pressed={preference === option}
                        onClick={() => setPreference(option)}
                      >
                        {t(`theme.${option}`)}
                      </button>
                    ))}
                  </div>
                  <button type="button" role="menuitem" className="danger" onClick={handleSignOut}>
                    <LogOut size={16} />{t('common.signOut')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="page" id="main-content">{children}</main>
      </div>
    </div>
  );
}

export function RoleBadge({ role }: { role?: string }) {
  return <Badge value={role} />;
}
