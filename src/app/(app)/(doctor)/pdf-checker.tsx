/**
 * Doctor PDF Checker — mobile.
 *
 * Pick the suspected leaked PDF and run the check. NO source material/course selection: the
 * watermark payload identifies the issuance on the server, which resolves student, material
 * and course inside the caller's authorized scope (`/pdf-forensic/check` without material_id).
 *
 * The screen never decides identity. Verdict, student, course and course counts are all
 * server-derived and already role-scoped. The result card shows only what a doctor can act on:
 * who the copy was issued to, in which course, and when — the technical detection metrics and
 * the issuance history live in the backend records, not in the doctor's face.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, ScrollView, StyleSheet, Text, View, useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FileSearch, ShieldAlert, ShieldCheck, ShieldQuestion, Upload, Users, X } from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, mutedTextStyle, safeBottom, type NeuPalette } from '@/lib/neu';
import { useTranslation } from '@/lib/i18n';
import { runForensicCheck, type CheckResult, type PickedPdf } from '@/lib/pdfForensicApi';

const MAX_BYTES = 25 * 1024 * 1024;

const VERDICT_TONE: Record<string, { color: string; icon: 'check' | 'question' | 'alert' }> = {
  confirmed: { color: '#16A34A', icon: 'check' },
  probable: { color: '#D97706', icon: 'question' },
  ambiguous: { color: '#D97706', icon: 'question' },
  no_mark: { color: '#6B7280', icon: 'alert' },
  unsupported: { color: '#DC2626', icon: 'alert' },
};

type Stage = 'idle' | 'preparing' | 'uploading' | 'analyzing' | 'done' | 'failed';

export default function PdfCheckerScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { t, isRTL } = useTranslation();
  const rtl = isRTL;
  const router = useRouter();

  const [file, setFile] = useState<PickedPdf | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Courses the IDENTIFIED STUDENT is enrolled in, inside this doctor's scope.
   * Comes from the server (`student.enrolled_courses`, computed in SQL with the doctor
   * filter applied) — it used to count the doctor's own course list instead, which is a
   * different number entirely (6 courses the doctor has vs 4 the student is in).
   */
  const [courseCount, setCourseCount] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const running = stage === 'preparing' || stage === 'uploading' || stage === 'analyzing';

  // The count is a property of the identified student, so it can only be known after a
  // successful check — never from the doctor's own course list.
  useEffect(() => {
    setCourseCount(result?.issuance?.student?.enrolled_courses ?? null);
  }, [result]);

  const pickFile = useCallback(async () => {
    setError(null);
    setResult(null);
    setStage('preparing');
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      setStage('idle');
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      if (asset.size && asset.size > MAX_BYTES) {
        setFile(null);
        setError(t('pdfChecker.tooLarge'));
        return;
      }
      setFile({
        uri: asset.uri,
        name: asset.name ?? 'document.pdf',
        size: asset.size ?? 0,
        mimeType: asset.mimeType ?? 'application/pdf',
      });
    } catch {
      setStage('idle');
      setError(t('pdfChecker.pickFailed'));
    }
  }, [t]);

  const submit = useCallback(async () => {
    if (!file || running) return; // duplicate-submission guard
    setError(null);
    setResult(null);
    setProgress(0);
    setStage('uploading');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await runForensicCheck(file, {
        signal: controller.signal,
        onProgress: setProgress,
        onStage: (next) => setStage(next),
      });
      setResult(data);
      setStage('done');
    } catch (e) {
      setStage('failed');
      const code = e instanceof Error ? e.message : '';
      if (code === 'aborted') setError(t('pdfChecker.cancelled'));
      else if (code === 'too_large') setError(t('pdfChecker.tooLarge'));
      else if (code === 'not_inspectable') setError(t('pdfChecker.notInspectable'));
      else if (code === 'forbidden') setError(t('pdfChecker.forbidden'));
      else if (code === 'network_error') setError(t('pdfChecker.checkFailed'));
      else setError(t('pdfChecker.checkFailed'));
    } finally {
      abortRef.current = null;
    }
  }, [file, running, t]);

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStage('failed');
    setError(t('pdfChecker.cancelled'));
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setProgress(0);
    setStage('idle');
    setFile(null);
  };

  const formatDate = useMemo(
    () => (value?: string | null) => {
      if (!value) return '—';
      const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
      const parsed = new Date(iso);
      if (Number.isNaN(parsed.getTime())) return value;
      return `${parsed.toLocaleDateString(rtl ? 'ar-EG' : 'en-GB')} ${parsed.toLocaleTimeString(rtl ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    },
    [rtl],
  );

  const tone = result ? VERDICT_TONE[result.verdict] ?? VERDICT_TONE.no_mark : null;
  const VerdictIcon = tone?.icon === 'check' ? ShieldCheck : tone?.icon === 'question' ? ShieldQuestion : ShieldAlert;
  const student = result?.issuance?.student ?? null;

  const stageLabel = (): string => {
    if (stage === 'uploading') return `${t('pdfChecker.stage.uploading')} ${progress}%`;
    if (stage === 'analyzing') return t('pdfChecker.stage.analyzing');
    if (stage === 'preparing') return t('pdfChecker.stage.preparing');
    return t('pdfChecker.running');
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={t('pdfChecker.title')} subtitle={t('pdfChecker.subtitle')} />
      <ScrollView
        contentContainerStyle={{
          padding: layout.pad.lg,
          // Existing helper, not a magic number: it is the safe-area bottom
          // PLUS the floating bar's clearance when this screen sits under it.
          paddingBottom: layout.roleTabsBottom(layout.pad.lg),
          gap: layout.pad.md,
        }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* File only — no material, no course. */}
        <NeuCard>
          <Text style={[styles.label, mutedTextStyle(c)]}>{t('pdfChecker.file')}</Text>
          <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'center', gap: layout.pad.sm, flexWrap: 'wrap' }}>
            <NeuButton
              label={file ? t('pdfChecker.changeFile') : t('pdfChecker.chooseFile')}
              variant="secondary"
              onPress={() => void pickFile()}
              disabled={running}
              icon={<Upload size={16} color={c.text} />}
            />
            <Text style={[mutedTextStyle(c), { flexShrink: 1 }]} numberOfLines={1}>
              {file ? file.name : t('pdfChecker.noFile')}
            </Text>
          </View>
        </NeuCard>

        {/* Stage-aware progress: real transferred bytes on web, honest stages elsewhere. */}
        {running && (
          <NeuCard>
            <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'center', gap: layout.pad.sm }}>
              <ActivityIndicator color={c.primary} />
              <Text style={[mutedTextStyle(c), { flexShrink: 1 }]}>{stageLabel()}</Text>
            </View>
            {stage === 'uploading' && (
              <View style={[styles.track, { backgroundColor: `${c.text}14`, marginTop: layout.pad.sm }]}>
                <View style={[styles.fill, { width: `${Math.max(2, progress)}%`, backgroundColor: c.primary }]} />
              </View>
            )}
            <View style={{ marginTop: layout.pad.md }}>
              <NeuButton
                label={t('pdfChecker.cancel')}
                variant="secondary"
                onPress={cancel}
                icon={<X size={16} color={c.text} />}
              />
            </View>
          </NeuCard>
        )}

        {!!error && (
          <NeuCard>
            <Text style={{ color: '#DC2626', fontWeight: '700' }}>{error}</Text>
            <View style={{ marginTop: layout.pad.sm }}>
              <NeuButton
                label={t('pdfChecker.retry')}
                variant="secondary"
                onPress={() => { setError(null); void submit(); }}
                disabled={!file || running}
              />
            </View>
          </NeuCard>
        )}

        {!running && (
          <NeuButton
            label={t('pdfChecker.run')}
            onPress={() => void submit()}
            disabled={!file}
            fullWidth
            icon={<FileSearch size={18} color="#fff" />}
          />
        )}

        {result && tone && (
          <NeuCard>
            {/* ── Identity: photo + name + student id ─────────────────────── */}
            {student ? (
              <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'center', gap: layout.pad.md }}>
                <StudentAvatar c={c} name={student.name} src={student.avatar_url} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.label, mutedTextStyle(c)]}>{t('pdfChecker.student')}</Text>
                  <Text style={{ color: c.text, fontSize: layout.bodySize + 2, fontWeight: '800' }} numberOfLines={2}>
                    {student.name ?? '—'}
                  </Text>
                  {!!student.public_user_id && (
                    <Text style={[mutedTextStyle(c), { fontWeight: '700' }]}>{student.public_user_id}</Text>
                  )}
                </View>
                <View style={{ alignItems: 'center', gap: 2 }}>
                  <Users size={16} color={c.primary} />
                  <Text style={{ color: c.text, fontWeight: '800' }}>{courseCount ?? '—'}</Text>
                  <Text style={[mutedTextStyle(c), { fontSize: 10, textAlign: 'center', maxWidth: 80 }]} numberOfLines={2}>
                    {t('pdfChecker.scopeCourses')}
                  </Text>
                </View>
              </View>
            ) : null}

            {/* ── Verdict ─────────────────────────────────────────────────── */}
            <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'center', gap: layout.pad.sm, marginTop: layout.pad.md }}>
              <VerdictIcon size={22} color={tone.color} />
              <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: tone.color }}>
                {t(`pdfChecker.verdict.${result.verdict}`)}
              </Text>
            </View>

            {/* ── Course + issuance date (no UUID, no metrics, no history) ─── */}
            {result.issuance && (
              <View style={{ marginTop: layout.pad.md, gap: 8 }}>
                <Row c={c} rtl={rtl} label={t('pdfChecker.course')}
                  value={result.issuance.course_title || result.issuance.course_id} />
                <Row c={c} rtl={rtl} label={t('pdfChecker.issued')} value={formatDate(result.issuance.issued_at)} />
                {student && (
                  <View style={{ marginTop: layout.pad.sm }}>
                    <NeuButton
                      label={t('pdfChecker.openStudent')}
                      variant="secondary"
                      // Same destination the eye icon uses: the Students screen opens the
                      // full profile sheet for this exact student id from its own data.
                      onPress={() => router.push({
                        pathname: '/(app)/(doctor)/students',
                        params: { student: student.id },
                      } as never)}
                    />
                  </View>
                )}
              </View>
            )}

            {!result.matched && (
              <Text style={[mutedTextStyle(c), { marginTop: layout.pad.sm }]}>
                {result.note ?? t('pdfChecker.unidentified')}
              </Text>
            )}

            <View style={{ marginTop: layout.pad.md }}>
              <NeuButton label={t('pdfChecker.again')} variant="secondary" onPress={reset} />
            </View>
          </NeuCard>
        )}
      </ScrollView>
    </View>
  );
}

/** Profile photo with an initials fallback — a dead URL never renders a broken image. */
function StudentAvatar({ c, name, src }: { c: NeuPalette; name: string | null; src?: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = (name ?? '')
    .trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';

  if (src && !failed) {
    return (
      <Image
        source={{ uri: src }}
        onError={() => setFailed(true)}
        style={{ width: 56, height: 56, borderRadius: 28 }}
      />
    );
  }
  return (
    <View style={{
      width: 56, height: 56, borderRadius: 28,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: `${c.primary}20`,
    }}>
      <Text style={{ color: c.primary, fontWeight: '800', fontSize: 18 }}>{initials}</Text>
    </View>
  );
}

function Row({ c, rtl, label, value }: { c: NeuPalette; rtl: boolean; label: string; value: string }) {
  return (
    <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', justifyContent: 'space-between', gap: 10 }}>
      <Text style={[styles.label, mutedTextStyle(c), { marginBottom: 0 }]}>{label}</Text>
      <Text style={{ color: c.text, fontWeight: '700', flexShrink: 1, textAlign: rtl ? 'left' : 'right' }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  track: { height: 6, borderRadius: 999, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 999 },
});
