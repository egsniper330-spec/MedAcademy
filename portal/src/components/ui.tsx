import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Inbox, Loader2, X } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/* ── Buttons ─────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({
  variant = 'secondary', loading, icon, children, className = '', ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      className={`btn btn-${variant} ${className}`.trim()}
      disabled={props.disabled || loading}
    >
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}

/* ── Cards / layout ──────────────────────────────────────────────────────── */

export function Card({ children, className = '', padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={`card ${padded ? 'card-padded' : ''} ${className}`.trim()}>{children}</section>;
}

export function PageHeader({
  title, subtitle, actions,
}: { title: string; subtitle?: string; actions?: ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="page-header">
      <div>
        <nav className="page-breadcrumb" aria-label={t('common.breadcrumb')}>
          <span>{t('app.portal')}</span>
          <span className="crumb-separator" aria-hidden="true">/</span>
          <span aria-current="page">{title}</span>
        </nav>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatCard({
  label, value, hint, icon, tone = 'blue',
}: { label: string; value: ReactNode; hint?: string; icon?: ReactNode; tone?: 'blue' | 'green' | 'amber' | 'red' | 'violet' }) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <div className="stat-icon">{icon}</div>
      <div className="stat-body">
        <span className="stat-label">{label}</span>
        <strong className="stat-value">{value}</strong>
        {hint && <span className="stat-hint">{hint}</span>}
      </div>
    </div>
  );
}

/* ── Status ──────────────────────────────────────────────────────────────── */

const BADGE_TONES: Record<string, string> = {
  active: 'green', published: 'green', enabled: 'green', healthy: 'green', success: 'green',
  draft: 'amber', pending: 'amber', hidden: 'amber', optional: 'amber',
  suspended: 'red', blocked: 'red', trashed: 'red', deleted: 'red', disabled: 'red', failing: 'red',
  archived: 'slate', inactive: 'slate',
  doctor: 'blue', admin: 'violet', super_admin: 'violet', assistant: 'blue', student: 'slate',
};

export function Badge({ children, tone, value }: { children?: ReactNode; tone?: string; value?: string }) {
  const key = tone ?? (value ? BADGE_TONES[value] ?? 'slate' : 'slate');
  return <span className={`badge badge-${key}`}>{children ?? value?.replace(/_/g, ' ')}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <Loader2 size={22} className="spin" />
      <span>{label ?? 'Loading…'}</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title?: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Inbox size={34} />
      <strong>{title ?? 'Nothing to show yet'}</strong>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={22} />
      <div>
        <strong>{t('common.error')}</strong>
        <p>{message}</p>
      </div>
      {onRetry && <Button onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

/* ── Form fields ─────────────────────────────────────────────────────────── */

export function Field({
  label, hint, error, required, children, htmlFor,
}: { label: string; hint?: string; error?: string; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && !error && <small>{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </div>
  );
}

export function Input({ label, hint, error, required, id, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label?: string; hint?: string; error?: string;
}) {
  const autoId = useId();
  const input = <input id={id ?? autoId} {...props} aria-invalid={Boolean(error)} />;
  if (!label) return input;
  return <Field label={label} hint={hint} error={error} required={required} htmlFor={id ?? autoId}>{input}</Field>;
}

export function Textarea({ label, hint, error, required, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string; hint?: string; error?: string;
}) {
  const autoId = useId();
  const textarea = <textarea id={id ?? autoId} rows={5} {...props} aria-invalid={Boolean(error)} />;
  if (!label) return textarea;
  return <Field label={label} hint={hint} error={error} required={required} htmlFor={id ?? autoId}>{textarea}</Field>;
}

export function Select({ label, hint, error, required, id, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string; hint?: string; error?: string;
}) {
  const autoId = useId();
  const select = <select id={id ?? autoId} {...props} aria-invalid={Boolean(error)}>{children}</select>;
  if (!label) return select;
  return <Field label={label} hint={hint} error={error} required={required} htmlFor={id ?? autoId}>{select}</Field>;
}

export function Checkbox({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/* ── Modal / confirm ─────────────────────────────────────────────────────── */

export function Modal({
  open, onClose, title, children, footer, wide,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  // Parents recreate onClose on every render (a keystroke in a controlled form).
  // Keeping it in a ref prevents the focus-lifecycle effect from tearing down and
  // restoring focus after every character.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    const focusTimer = window.setTimeout(() => {
      if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    }, 20);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open, title, message, confirmLabel, tone = 'danger', busy, onConfirm, onCancel,
}: {
  open: boolean; title: string; message: string; confirmLabel?: string;
  tone?: 'danger' | 'primary'; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant={tone} onClick={onConfirm} loading={busy}>{confirmLabel ?? t('common.confirm')}</Button>
        </>
      )}
    >
      <p className="confirm-message">{message}</p>
    </Modal>
  );
}

/* ── Toast ───────────────────────────────────────────────────────────────── */

interface Toast { id: number; message: string; tone: 'success' | 'error' }
const ToastContext = createContext<{ notify: (message: string, tone?: 'success' | 'error') => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { id, message, tone }]);
    window.setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 4500);
  }, []);
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.tone === 'success' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}

/* ── Table / pagination ──────────────────────────────────────────────────── */

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`table-wrap ${className}`.trim()}><table>{children}</table></div>;
}

export function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  const { t } = useI18n();
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <Button variant="ghost" icon={<ChevronLeft size={16} />} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t('common.previous')}
      </Button>
      <span>{t('common.page')} {page} {t('common.of')} {pages}</span>
      <Button variant="ghost" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        {t('common.next')} <ChevronRight size={16} />
      </Button>
    </nav>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="switch-track"><span className="switch-thumb" /></span>
    </label>
  );
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="inline-error" role="alert"><AlertCircle size={16} />{message}</div>;
}
