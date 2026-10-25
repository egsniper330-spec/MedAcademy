import { View, Text, useColorScheme } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { CheckCircle, BookOpen, Clock } from 'lucide-react-native';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { useTranslation } from '@/lib/i18n';

// ── Progress bar color constants ────────────────────────────────────────────
// Emerald green palette — conveys success / completion, matches MedAcademy
// branding premium feel on both light and dark themes.
// Single gradient used for ALL progress levels (replaces the red→orange→blue→
// green tier system that falsely implied early-progress was an error state).
const BAR_COLOR_START = '#34D399'; // Emerald 400 — bright leading edge
const BAR_COLOR_END   = '#22C55E'; // Green 500  — rich trailing fill
// Text / label color: a single confident green (no red, no orange)
const LABEL_COLOR = '#16A34A';     // Green 600  — readable on light & dark

interface Props {
  totalLessons: number;
  completedLessons: number;
  progressPct: number;
  remainingSeconds?: number;
  compact?: boolean;
}

/**
 * Remaining study time, localized. This component is rendered INSIDE the
 * course details screen, so its labels are part of that screen's contract: in
 * Arabic the old literal "2h 5m remaining" stayed English.
 */
function formatRemaining(secs: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!secs || secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return t('course.remainingHm', { h, m });
  if (m > 0) return t('course.remainingMs', { m });
  return t('course.remainingS', { s: secs });
}

export function CourseProgressBar({
  totalLessons,
  completedLessons,
  progressPct,
  remainingSeconds = 0,
  compact = false,
}: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { t } = useTranslation();

  const remaining = totalLessons - completedLessons;
  const pct = Math.min(100, Math.max(0, progressPct));

  if (compact) {
    return (
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: LABEL_COLOR }}>
            {t('course.pctComplete', { pct })}
          </Text>
          <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{completedLessons}/{totalLessons}</Text>
        </View>
        {/* Track */}
        <View style={{
          height: 6, borderRadius: 3, overflow: 'hidden',
          backgroundColor: isDark ? '#1a3a2a' : '#dcfce7',
        }}>
          {/* Gradient fill */}
          <LinearGradient
            colors={[BAR_COLOR_START, BAR_COLOR_END]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ height: 6, width: `${pct}%` as any, borderRadius: 3 }}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={{
      padding: 16,
      borderRadius: 16,
      backgroundColor: c.base,
      shadowColor: isDark ? '#000' : '#b8c0cc',
      shadowOffset: { width: 4, height: 4 },
      shadowOpacity: isDark ? 0.5 : 0.6,
      shadowRadius: 8,
      borderWidth: 1,
      borderColor: isDark ? '#2a2a2a' : '#e8ecf0',
      gap: 12,
    }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{t('course.yourProgress')}</Text>
        <Text style={{ fontSize: 20, fontWeight: '800', color: LABEL_COLOR }}>{pct}%</Text>
      </View>

      {/* Progress track — neumorphic inset, emerald gradient fill */}
      <View style={{
        height: 10, borderRadius: 5, overflow: 'hidden',
        backgroundColor: isDark ? '#1a3a2a' : '#dcfce7',
        shadowColor: isDark ? '#000' : '#b8c0cc',
        shadowOffset: { width: 2, height: 2 },
        shadowOpacity: isDark ? 0.5 : 0.4,
        shadowRadius: 3,
      }}>
        <LinearGradient
          colors={[BAR_COLOR_START, BAR_COLOR_END]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ height: 10, width: `${pct}%` as any, borderRadius: 5 }}
        />
      </View>

      {/* Stats row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Stat icon={CheckCircle} color="#16A34A" label={`${completedLessons}`} sub={t('course.doneShort')} isDark={isDark} c={c} />
        <Stat icon={BookOpen}    color="#3B82F6" label={`${remaining}`}         sub={t('course.leftShort')} isDark={isDark} c={c} />
        {remainingSeconds > 0 && (
          <Stat icon={Clock} color="#F97316" label={formatRemaining(remainingSeconds, t)} sub="" isDark={isDark} c={c} />
        )}
      </View>
    </View>
  );
}

function Stat({
  icon: Icon, color, label, sub, isDark, c,
}: { icon: any; color: string; label: string; sub: string; isDark: boolean; c: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Icon size={14} color={color} />
      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
        {label}{sub ? <Text style={{ fontWeight: '400', opacity: 0.6, fontSize: 11 }}> {sub}</Text> : null}
      </Text>
    </View>
  );
}
