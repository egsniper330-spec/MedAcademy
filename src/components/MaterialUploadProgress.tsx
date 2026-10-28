/**
 * MaterialUploadProgress — the PDF/material upload card.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Attaching a PDF used to show a spinner and one word ("Uploading…") for the
 * whole request. A large scan on a slow connection takes minutes, so the screen
 * was indistinguishable from a hung request: no bytes, no percentage, no
 * cancel, and no way to tell transfer from server-side verification.
 *
 * This card reports:
 *   • transferred / total bytes and a percentage (when the total is known),
 *   • smoothed transfer speed and an ETA once there are two samples,
 *   • the real stage — preparing → uploading → verifying → saving — so 100 %
 *     transferred is never presented as "done" before the server confirmed the
 *     stored file, and
 *   • a cancel button that aborts this transfer only.
 *
 * All numbers come from `UploadProgressSnapshot` (lib/uploadProgress.ts), which
 * is pure and unit-tested; this file is presentation only.
 */
import { memo } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import { AlertCircle, CheckCircle2, Upload, X } from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { useTranslation } from '@/lib/i18n';
import {
  formatByteCount,
  isActiveStage,
  stageMessageKey,
  type UploadProgressSnapshot,
} from '@/lib/uploadProgress';

interface Props {
  fileName: string;
  snapshot: UploadProgressSnapshot;
  /** Already-translated failure text; null while the upload is healthy. */
  errorMessage?: string | null;
  /** Whether retrying the same file is worth offering. */
  canRetry?: boolean;
  onCancel?: () => void;
  onDismiss?: () => void;
}

function etaLabel(seconds: number | null, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('lessonEditor.upload.etaSeconds', { seconds: Math.round(seconds) });
  return t('lessonEditor.upload.etaMinutes', { minutes: Math.max(1, Math.round(seconds / 60)) });
}

export const MaterialUploadProgress = memo(function MaterialUploadProgress({
  fileName,
  snapshot,
  errorMessage = null,
  canRetry = false,
  onCancel,
  onDismiss,
}: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { t, isRTL } = useTranslation();

  const failed = snapshot.stage === 'failed';
  const cancelled = snapshot.stage === 'cancelled';
  const done = snapshot.stage === 'done';
  const active = isActiveStage(snapshot.stage);

  // A determinate bar only when the total is known; otherwise a fixed, muted
  // track so the card never shows a fake 0 %.
  const pct = snapshot.percent;
  const barWidth = pct === null ? 0 : Math.max(2, Math.min(100, pct));

  const accent = failed ? '#DC2626' : cancelled ? '#6B7280' : done ? '#16A34A' : c.primary;
  const Icon = failed || cancelled ? AlertCircle : done ? CheckCircle2 : Upload;

  const detailParts: string[] = [];
  if (snapshot.totalBytes > 0) {
    detailParts.push(t('lessonEditor.upload.progressDetail', {
      sent: formatByteCount(snapshot.bytesSent),
      total: formatByteCount(snapshot.totalBytes),
    }));
  } else if (snapshot.bytesSent > 0) {
    detailParts.push(formatByteCount(snapshot.bytesSent));
  }
  if (snapshot.speedBps > 0 && active) {
    detailParts.push(t('lessonEditor.upload.speed', { speed: `${formatByteCount(snapshot.speedBps)}/s` }));
  }
  const eta = active ? etaLabel(snapshot.etaSeconds, t) : '';
  if (eta) detailParts.push(eta);

  return (
    <NeuCard style={{ padding: 12, gap: 8, direction: isRTL ? 'rtl' : 'ltr' }}>
      <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 10 }}>
        <Icon size={18} color={accent} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>{fileName}</Text>
          <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.55), marginTop: 2 }}>
            {failed || cancelled ? errorMessage ?? t(stageMessageKey(snapshot.stage)) : t(stageMessageKey(snapshot.stage))}
          </Text>
        </View>
        {pct !== null && active ? (
          <Text style={{ fontSize: 13, fontWeight: '800', color: accent }}>{Math.floor(pct)}%</Text>
        ) : null}
        {active && onCancel ? (
          <Pressable
            onPress={onCancel}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('lessonEditor.upload.cancel')}
          >
            <X size={18} color={c.text} opacity={0.6} />
          </Pressable>
        ) : null}
        {!active && onDismiss ? (
          <Pressable
            onPress={onDismiss}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('lessonEditor.upload.dismiss')}
          >
            <X size={18} color={c.text} opacity={0.6} />
          </Pressable>
        ) : null}
      </View>

      {/* Track + fill. `pct === null` keeps the track empty (indeterminate). */}
      <View style={{
        height: 6, borderRadius: 3, overflow: 'hidden',
        backgroundColor: isDark ? '#2A2A2A' : '#E5E9F0',
      }}>
        <View style={{ height: 6, borderRadius: 3, width: `${barWidth}%`, backgroundColor: accent }} />
      </View>

      {detailParts.length > 0 ? (
        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{detailParts.join('  ·  ')}</Text>
      ) : null}
      {canRetry && failed ? (
        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{t('lessonEditor.upload.retryHint')}</Text>
      ) : null}
    </NeuCard>
  );
});
