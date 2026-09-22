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
import { CloudOff, RefreshCw, AlertTriangle } from 'lucide-react-native';
import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { EmptyState } from '@/components/EmptyState';
import { neuColors } from '@/lib/neu';
import { spacing } from '@/lib/ds';
import { friendlyError } from '@/lib/validation';

/**
 * Fullscreen loading indicator with context. Replaces bare <ActivityIndicator/>
 * so a slow screen never looks like a dead screen.
 */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.hero, gap: spacing.md }} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={c.primary} />
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.55 }}>{label}</Text>
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
export function ErrorState({ error, onRetry, retryLabel = 'Try Again', offline, compact }: ErrorStateProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const Icon = offline ? CloudOff : AlertTriangle;
  const color = offline ? '#D97706' : '#DC2626';
  const message = friendlyError(error, 'The request could not be completed.');

  const body = (
    <View style={{ alignItems: 'center', paddingVertical: compact ? spacing.lg : spacing.xl, gap: spacing.sm, paddingHorizontal: spacing.lg }}>
      <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={26} color={color} />
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, textAlign: 'center' }}>
        {offline ? 'You are offline' : 'Something went wrong'}
      </Text>
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, textAlign: 'center', maxWidth: 340 }}>
        {message}
      </Text>
      {onRetry && (
        <View style={{ marginTop: spacing.sm, minWidth: 180 }}>
          <NeuButton label={offline ? 'Retry When Online' : retryLabel} onPress={onRetry} icon={<RefreshCw size={15} color="#fff" />} />
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
