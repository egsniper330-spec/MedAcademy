/**
 * ScreenState — shared terminal-state primitives for admin data screens.
 *
 * The Platform sub-pages (Branding, CMS, Feature Flags, Maintenance, System
 * Config) previously shared one bug class: `loading ? spinner : data.map(...)`
 * with `catch (_) {}`. ANY failure — expired token, offline, server 5xx, role
 * change — left a bare near-white screen with no error message and no way to
 * recover. That is exactly the "completely WHITE/BLANK screen" symptom.
 *
 * Contract for every screen that loads server data:
 *   LOADING   → <LoadingState />
 *   ERROR     → <ErrorState error={e} onRetry={load} />
 *   EMPTY     → <EmptyState … /> (already exists: src/components/EmptyState.tsx)
 *   SUCCESS   → content
 * A screen must never render "nothing" — that is the bug this prevents.
 */
import React from 'react';
import { View, Text, ActivityIndicator, useColorScheme } from 'react-native';
import { CloudOff, RefreshCw, AlertTriangle, Ban } from 'lucide-react-native';
import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { EmptyState } from '@/components/EmptyState';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { spacing } from '@/lib/ds';
import { friendlyError } from '@/lib/validation';
import { useTranslation } from '@/lib/i18n';

/**
 * Fullscreen loading indicator with context. Replaces bare <ActivityIndicator/>
 * so a slow screen never looks like a dead screen.
 */
export function LoadingState({ label }: { label?: string }) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { t } = useTranslation();
  const text = label ?? t('common.loading');
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.hero, gap: spacing.md }} accessibilityRole="progressbar" accessibilityLabel={text}>
      <ActivityIndicator size="large" color={c.primary} />
      <Text style={[{ fontSize: 13 }, mutedTextStyle(c, 0.55)]}>{text}</Text>
    </View>
  );
}

interface ErrorStateProps {
  /** The thrown error — message is passed through friendlyError (never raw). */
  error: unknown;
  /** Retry callback. Omit for a non-retryable informational state. */
  onRetry?: () => void;
  /** Retry label (default "Try Again"). */
  retryLabel?: string;
  /** Set when the device is offline so the copy is network-aware. */
  offline?: boolean;
  /** Compact variant for inline (non-fullscreen) errors. */
  compact?: boolean;
}

/**
 * Terminal error state. Distinguishes network failure from server failure —
 * a network error is NEVER rendered as empty data, and never as a blank screen.
 */
export function ErrorState({ error, onRetry, retryLabel, offline, compact }: ErrorStateProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { t } = useTranslation();
  const Icon = offline ? CloudOff : AlertTriangle;
  // Semantic ink: the light-mode amber/red against a dark surface measure
  // 3.0:1 and 2.4:1, so dark takes the brighter warning/danger tiers.
  const color = offline ? (isDark ? c.warning : '#D97706') : (isDark ? c.danger : '#DC2626');
  const message = friendlyError(error, t('common.requestFailed'));

  const body = (
    <View style={{ alignItems: 'center', paddingVertical: compact ? spacing.lg : spacing.xl, gap: spacing.sm, paddingHorizontal: spacing.lg }}>
      <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={26} color={color} />
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, textAlign: 'center' }}>
        {offline ? t('common.offlineTitle') : t('common.somethingWentWrong')}
      </Text>
      <Text style={[{ fontSize: 13, textAlign: 'center', maxWidth: 340 }, mutedTextStyle(c, 0.6)]}>
        {message}
      </Text>
      {onRetry && (
        <View style={{ marginTop: spacing.sm, minWidth: 180 }}>
          <NeuButton label={offline ? t('common.retryWhenOnline') : (retryLabel ?? t('common.tryAgain'))} onPress={onRetry} icon={<RefreshCw size={15} color="#fff" />} />
        </View>
      )}
    </View>
  );

  if (compact) return body;
  return (
    <NeuCard style={{ marginTop: spacing.lg }}>
      {body}
    </NeuCard>
  );
}

interface FeatureUnavailableStateProps {
  /** Short headline, e.g. "Course creation is unavailable". */
  title: string;
  /** One or two sentences: what is off, who turned it off, what to do. */
  description: string;
  /** Optional custom glyph (defaults to a muted "blocked" icon). */
  icon?: React.ReactNode;
  /** Inline variant — no card chrome, for embedding in a form section. */
  compact?: boolean;
}

/**
 * Ubiquitous UNAVAILABLE-FEATURE state.
 *
 * A feature the Super Admin has turned OFF is NOT an error, and must never be
 * presented as one. The historical bug was a generic "Save failed" toast when a
 * doctor tried to use a disabled capability — which reads as "the app is
 * broken" instead of "an administrator disabled this". Every disabled-capability
 * surface (course creation, video provider/Plyr assignment, …)
 * renders THIS component so the copy, colour and layout stay consistent and the
 * state is unmistakably a deliberate configuration, not a failure.
 *
 * Colour: amber (an advisory), never red (an error).
 */
export function FeatureUnavailableState({ title, description, icon, compact }: FeatureUnavailableStateProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const color = isDark ? c.warning : '#B45309';

  const body = (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: compact ? spacing.lg : spacing.hero,
        paddingHorizontal: spacing.lg,
        gap: spacing.sm,
      }}
    >
      <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center' }}>
        {icon ?? <Ban size={26} color={color} />}
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, textAlign: 'center' }}>
        {title}
      </Text>
      <Text style={[{ fontSize: 13, textAlign: 'center', maxWidth: 360, lineHeight: 19 }, mutedTextStyle(c, 0.6)]}>
        {description}
      </Text>
    </View>
  );

  if (compact) return body;
  return <NeuCard style={{ marginTop: spacing.lg }}>{body}</NeuCard>;
}

/**
 * Standard loader contract helper — mirrors the state machine required by the
 * Platform screens: LOADING → (ERROR | EMPTY | SUCCESS), always terminal.
 */
export type ScreenPhase = 'loading' | 'error' | 'success';

export function renderDataState(opts: {
  phase: ScreenPhase;
  isEmpty: boolean;
  emptyIcon?: React.ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
  onRetry: () => void;
  error?: unknown;
  offline?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { phase, isEmpty, emptyIcon, emptyTitle, emptyDescription, onRetry, error, offline, children } = opts;
  if (phase === 'loading') return <LoadingState />;
  if (phase === 'error') return <ErrorState error={error} onRetry={onRetry} offline={offline} />;
  if (isEmpty) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
        action={{ label: 'Refresh', onPress: onRetry }}
      />
    );
  }
  return <>{children}</>;
}
