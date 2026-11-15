import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from '../src/lib/i18n';
import { applyStoredTheme, useTheme } from '../src/lib/theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('theme preference', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('applies a stored dark theme before React renders', () => {
    localStorage.setItem('med_portal_theme', 'dark');
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('defaults to the system preference when nothing is stored', () => {
    applyStoredTheme();
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme);
  });

  it('persists a preference chosen through the hook', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let setPreference: ((value: 'light' | 'dark' | 'system') => void) | null = null;

    function Probe() {
      const theme = useTheme();
      setPreference = theme.setPreference;
      return <span data-testid="resolved">{theme.resolved}</span>;
    }

    await act(async () => { root.render(<Probe />); });
    await act(async () => { setPreference?.('dark'); });

    expect(localStorage.getItem('med_portal_theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await act(async () => { root.unmount(); });
    container.remove();
  });
});

describe('Arabic portal terminology', () => {
  it('uses الإدارة for Staff and الرصيد for Credits', async () => {
    localStorage.setItem('med_portal_lang', 'ar');
    const container = document.createElement('div');
    const root = createRoot(container);
    let translate: ((key: string) => string) | null = null;

    function Probe() {
      const { t } = useI18n();
      translate = t;
      return null;
    }

    await act(async () => {
      root.render(<I18nProvider><Probe /></I18nProvider>);
    });

    expect(translate?.('nav.management')).toBe('الإدارة');
    expect(translate?.('dashboard.credits')).toBe('الرصيد');
    expect(translate?.('courses.field.credits')).toBe('الرصيد المطلوب');

    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.clear();
  });
});
