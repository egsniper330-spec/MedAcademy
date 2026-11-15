import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, GraduationCap, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useDocumentTitle } from '../lib/hooks';
import { Button, InlineError } from '../components/ui';
import { BrandLogo } from '../components/BrandLogo';

export default function Login() {
  const { user, loading, error, signIn } = useAuth();
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useDocumentTitle(t('login.title'));

  useEffect(() => {
    if (!loading && user) navigate('/dashboard', { replace: true });
  }, [loading, user, navigate]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setFieldError('Email/phone and password are required.');
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      await signIn(identifier, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      // 429 gets a localized message with no countdown; other errors are surfaced by the auth context.
      if (err instanceof ApiError && err.status === 429) setFieldError(t('login.rateLimited'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-aside">
        <div className="auth-brand">
          <BrandLogo variant="full" className="auth-logo-full" />
        </div>
        <div className="auth-aside-copy">
          <h1>{t('app.portal')}</h1>
          <p>{t('login.subtitle')}</p>
          <ul>
            <li><ShieldCheck size={18} /> {t('login.secure')}</li>
            <li><GraduationCap size={18} /> {t('login.courses')}</li>
            <li><LockKeyhole size={18} /> {t('login.mobileOnly')}</li>
          </ul>
        </div>
        <p className="auth-foot">{t('login.footer')}</p>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-head">
            <div className="auth-card-brand">
              <BrandLogo variant="compact" className="auth-logo-card" />
            </div>
            <div className="lang-switch" role="group" aria-label={t('common.language')}>
              <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
              <button type="button" className={lang === 'ar' ? 'active' : ''} onClick={() => setLang('ar')}>AR</button>
            </div>
          </div>
          <h2>{t('login.title')}</h2>
          <p className="muted">{t('login.subtitle')}</p>

          <form onSubmit={onSubmit} noValidate>
            <label className="field" htmlFor="login-identifier">
              <span>{t('login.identifier')}</span>
              <input
                id="login-identifier"
                name="identifier"
                autoComplete="username"
                inputMode="email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="doctor@example.com"
                autoFocus
              />
            </label>

            <label className="field" htmlFor="login-password">
              <span>{t('login.password')}</span>
              <div className="password-wrap">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={showPassword ? t('login.hide') : t('login.show')}
                  onClick={() => setShowPassword((show) => !show)}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>

            <InlineError message={fieldError ?? error} />

            <Button type="submit" variant="primary" loading={busy} className="btn-block">
              {busy ? t('login.working') : t('login.submit')}
            </Button>
          </form>

          <div className="auth-note">
            <GraduationCap size={16} />
            <span>{t('login.student')}</span>
          </div>
        </div>
      </main>
    </div>
  );
}
