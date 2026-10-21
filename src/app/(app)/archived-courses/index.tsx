/**
 * Archived Courses — Doctor / Admin / Super Admin.
 *
 * WHO SEES WHAT (server-enforced, see AnalyticsController::archivedCourses):
 *   • doctor     → only the courses they own (this is the dashboard quick action)
 *   • admin / SA → every archived course
 *
 * An archived course keeps `status = 'archived'` + `archived_at`, which already
 * hides it from the public catalog and from new subscriptions while enrolled
 * students keep their access and progress. Restoring returns it to `draft`
 * (the doctor republishes when ready) — the existing lifecycle behaviour.
 *
 * The previous version of this screen was the source of the "0 archived / huge
 * blank area" report: the endpoint refused doctors (403 swallowed → empty list),
 * every string was hardcoded English, and the empty state was a bare icon under
 * a fixed pad with no explanation.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, TextInput, useColorScheme,
  RefreshControl, Modal, useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Archive, BookOpen, Clock, RefreshCw, Search, Users,
  Trash2, RotateCcw, AlertTriangle, ShieldAlert, Inbox,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import {
  getArchivedCourses, restoreCourse, permanentlyDeleteCourse,
  type ArchivedCourse,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeBottom, mutedTextStyle } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScrollView';
import { useTranslation } from '@/lib/i18n';
import { formatLocalizedDate } from '@/lib/i18n/date';
import { friendlyError } from '@/lib/validation';

export default function ArchivedCoursesScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { width } = useWindowDimensions();
  const { profile } = useProfileStore();
  const { showToast } = useToast();
  const { t, tCount, locale } = useTranslation();

  const [courses, setCourses] = useState<ArchivedCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Restore state
  const [restoring, setRestoring] = useState<string | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState<ArchivedCourse | null>(null);

  // Delete state (Super Admin only)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<ArchivedCourse | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const role = profile?.role ?? '';
  const isSuperAdmin = role === 'super_admin';
  const canAccess = ['doctor', 'admin', 'super_admin'].includes(role);
  const isWide = width >= 700;

  const loadData = useCallback(async () => {
    if (!profile || !canAccess) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      // Ownership/identity are resolved from the SESSION on the server; the
      // client sends no actor id and no actor role.
      const data = await getArchivedCourses();
      setCourses(data);
    } catch (e) {
      setCourses([]);
      setLoadError(friendlyError(e, t('archived.errorBody')));
    }
    setLoading(false);
  }, [profile, canAccess, t]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    loadData();
  }, [loadData]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleRestore = async (course: ArchivedCourse) => {
    if (!profile) return;
    setRestoring(course.id);
    try {
      await restoreCourse(course.id, profile.id, profile.role);
      setCourses(prev => prev.filter(row => row.id !== course.id));
      showToast({ type: 'success', message: t('archived.restoreSuccess', { title: course.title }) });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('archived.restoreFailed')) });
    }
    setRestoring(null);
    setShowRestoreConfirm(null);
  };

  const handlePermanentDelete = async (course: ArchivedCourse) => {
    if (!profile || !isSuperAdmin) return;
    setDeleting(course.id);
    try {
      await permanentlyDeleteCourse(course.id, profile.id);
      setCourses(prev => prev.filter(row => row.id !== course.id));
      showToast({ type: 'success', message: t('archived.deleteSuccess', { title: course.title }) });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('archived.deleteFailed')) });
    }
    setDeleting(null);
    setShowDeleteConfirm(null);
  };

  const needle = query.trim().toLowerCase();
  const filtered = courses.filter(course =>
    !needle
    || String(course.title ?? '').toLowerCase().includes(needle)
    || String(course.doctor_name ?? '').toLowerCase().includes(needle)
  );

  const backFallback =
    role === 'doctor' ? '/(app)/(doctor)/dr-overview'
      : role === 'admin' ? '/(app)/(admin)/admin-overview'
        : '/(app)/(superadmin)/sa-overview';

  if (!canAccess) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <PageHeader title={t('archived.title')} showBack backFallback="/" />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: layout.screenPx }}>
          <ShieldAlert size={40} color={c.danger} opacity={0.6} />
          <Text style={{ marginTop: 10, fontSize: 15, fontWeight: '700', color: c.text, textAlign: 'center' }}>
            {t('archived.accessDenied')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <KeyboardAwareScrollView
        contentContainerStyle={{ flexGrow: 1, paddingBottom: safeBottom(layout.insets.bottom, layout.sectionGap) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        <PageHeader
          title={t('archived.title')}
          subtitle={tCount('archived.courseCount', courses.length)}
          showBack
          backFallback={backFallback}
        />

        {/* Policy banner */}
        <View style={{
          marginHorizontal: layout.screenPx, marginBottom: layout.pad.md,
          paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm,
          borderRadius: layout.cardRadius,
          backgroundColor: isDark ? '#D9770618' : '#D9770610',
          borderWidth: 1,
          borderColor: isDark ? '#D9770635' : '#D9770625',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Archive size={14} color="#D97706" style={{ marginTop: 2 }} />
            <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: isDark ? '#F0B45A' : '#B45309' }}>
              {t('archived.bannerBody')}
            </Text>
          </View>
        </View>

        {/* Search */}
        <View style={{ paddingHorizontal: layout.screenPx, marginBottom: layout.pad.md }}>
          <View style={[neuPressedStyle(isDark), {
            borderRadius: layout.cardRadius, flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: layout.pad.md, gap: 10,
          }]}>
            <Search size={15} color={c.text} opacity={0.4} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('archived.searchPlaceholder')}
              placeholderTextColor={`${c.text}55`}
              accessibilityLabel={t('archived.searchPlaceholder')}
              style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 11 }}
            />
          </View>
        </View>

        {/* Content */}
        <View style={{ paddingHorizontal: layout.screenPx, gap: layout.itemGap, flexGrow: 1 }}>
          {loading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center', gap: 10 }}>
              <ActivityIndicator color={c.primary} />
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>{t('archived.loading')}</Text>
            </View>
          ) : loadError ? (
            <View style={{ paddingVertical: 32, alignItems: 'center', gap: 10 }}>
              <AlertTriangle size={34} color={c.danger} opacity={0.7} />
              <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, textAlign: 'center' }}>
                {t('archived.errorTitle')}
              </Text>
              <Text style={{ fontSize: 12.5, textAlign: 'center', ...mutedTextStyle(c, 0.5), lineHeight: 19 }}>
                {loadError}
              </Text>
              <Pressable
                onPress={() => { setLoading(true); loadData(); }}
                accessibilityRole="button"
                style={[neuFlatStyle(isDark), {
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, marginTop: 4,
                }]}
              >
                <RefreshCw size={14} color={c.primary} />
                <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>{t('archived.retry')}</Text>
              </Pressable>
            </View>
          ) : filtered.length === 0 ? (
            /* Balanced empty state: a bounded card, not a naked icon under a
               fixed pad — the old layout left a large dead area below it. */
            <View style={{ flexGrow: 1, justifyContent: 'center', paddingVertical: layout.sectionGap }}>
              <NeuCard style={{ alignItems: 'center', paddingVertical: 26, paddingHorizontal: layout.cardPx, gap: 8 }}>
                <View style={{
                  width: 52, height: 52, borderRadius: 26,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: `${c.primary}14`,
                }}>
                  {needle
                    ? <Search size={24} color={c.primary} opacity={0.5} />
                    : <Inbox size={24} color={c.primary} opacity={0.5} />}
                </View>
                <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, textAlign: 'center' }}>
                  {needle ? t('archived.noMatchTitle') : t('archived.emptyTitle')}
                </Text>
                <Text style={{ fontSize: 12.5, textAlign: 'center', lineHeight: 19, ...mutedTextStyle(c, 0.5) }}>
                  {needle ? t('archived.noMatchBody') : t('archived.emptyBody')}
                </Text>
              </NeuCard>
            </View>
          ) : (
            <View style={{
              flexDirection: isWide ? 'row' : 'column',
              flexWrap: 'wrap',
              gap: layout.itemGap,
            }}>
              {filtered.map(course => (
                <NeuCard
                  key={course.id}
                  style={isWide ? { gap: 10, width: '48.5%' } : { gap: 10 }}
                >
                  {/* Title row */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    <View style={{
                      width: 38, height: 38, borderRadius: 12,
                      backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <Archive size={17} color="#D97706" />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 14.5, fontWeight: '800', color: c.text }} numberOfLines={2}>
                        {course.title}
                      </Text>
                      {!!course.doctor_name && (
                        <Text style={{ fontSize: 11.5, marginTop: 2, ...mutedTextStyle(c, 0.5) }} numberOfLines={1}>
                          {course.doctor_name}
                        </Text>
                      )}
                    </View>
                  </View>

                  {/* Meta — wraps instead of overflowing on narrow phones */}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, rowGap: 4 }}>
                    <MetaItem
                      icon={Clock}
                      label={course.archived_at
                        ? t('archived.archivedOn', { date: formatLocalizedDate(course.archived_at, locale) })
                        : t('archived.archivedUnknown')}
                      c={c}
                    />
                    {!!course.archived_by_name && (
                      <MetaItem icon={Archive} label={t('archived.by', { name: course.archived_by_name })} c={c} />
                    )}
                    <MetaItem icon={Users} label={tCount('archived.students', course.students_count ?? 0)} c={c} />
                    <MetaItem icon={BookOpen} label={tCount('drCourses.lessonCount', course.lessons_count ?? 0)} c={c} />
                  </View>

                  {!!course.archive_reason && (
                    <View style={{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: `${c.text}06` }}>
                      <Text style={{ fontSize: 11.5, fontStyle: 'italic', ...mutedTextStyle(c, 0.55) }}>
                        {course.archive_reason}
                      </Text>
                    </View>
                  )}

                  {/* Actions */}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Pressable
                      onPress={() => setShowRestoreConfirm(course)}
                      disabled={restoring === course.id}
                      accessibilityRole="button"
                      accessibilityLabel={t('archived.restore')}
                      style={[neuFlatStyle(isDark), {
                        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                        paddingVertical: 10, borderRadius: 12, gap: 6,
                      }]}
                    >
                      {restoring === course.id
                        ? <ActivityIndicator size="small" color="#16A34A" />
                        : <RotateCcw size={14} color="#16A34A" />}
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>{t('archived.restore')}</Text>
                    </Pressable>

                    {isSuperAdmin && (
                      <Pressable
                        onPress={() => setShowDeleteConfirm(course)}
                        disabled={deleting === course.id}
                        accessibilityRole="button"
                        accessibilityLabel={t('archived.deleteForever')}
                        style={[neuFlatStyle(isDark), {
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          paddingVertical: 10, borderRadius: 12, gap: 6,
                        }]}
                      >
                        {deleting === course.id
                          ? <ActivityIndicator size="small" color="#DC2626" />
                          : <Trash2 size={14} color="#DC2626" />}
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{t('archived.deleteForever')}</Text>
                      </Pressable>
                    )}
                  </View>
                </NeuCard>
              ))}
            </View>
          )}
        </View>
      </KeyboardAwareScrollView>

      {/* ── Restore Confirmation ── */}
      <Modal visible={!!showRestoreConfirm} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <NeuCard style={{ width: '100%', maxWidth: 400 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                <RotateCcw size={20} color="#16A34A" />
              </View>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, flex: 1 }}>{t('archived.restoreTitle')}</Text>
            </View>
            <Text style={{ fontSize: 13, lineHeight: 20, marginBottom: 6, ...mutedTextStyle(c, 0.55) }}>
              <Text style={{ fontWeight: '700', color: c.text }}>{showRestoreConfirm?.title}</Text>
              {'\n\n'}{t('archived.restoreBody')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <Pressable
                onPress={() => setShowRestoreConfirm(null)}
                accessibilityRole="button"
                style={[neuFlatStyle(isDark), { flex: 1, padding: 12, borderRadius: 12, alignItems: 'center' }]}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.5) }}>{t('archived.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={() => showRestoreConfirm && handleRestore(showRestoreConfirm)}
                accessibilityRole="button"
                style={{ flex: 1, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#16A34A' }}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>{t('archived.restore')}</Text>
              </Pressable>
            </View>
          </NeuCard>
        </View>
      </Modal>

      {/* ── Permanent Delete Confirmation (Super Admin only) ── */}
      <Modal visible={!!showDeleteConfirm} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <NeuCard style={{ width: '100%', maxWidth: 420 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={22} color="#DC2626" />
              </View>
              <Text style={{ fontSize: 17, fontWeight: '800', color: '#DC2626', flex: 1 }}>{t('archived.deleteTitle')}</Text>
            </View>

            {!!showDeleteConfirm && (
              <View style={{ gap: 8, marginBottom: 16 }}>
                <View style={{ padding: 14, borderRadius: 12, backgroundColor: `${c.text}06`, gap: 6 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>{showDeleteConfirm.title}</Text>
                  {!!showDeleteConfirm.doctor_name && (
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{showDeleteConfirm.doctor_name}</Text>
                  )}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 4 }}>
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                      {tCount('archived.students', showDeleteConfirm.students_count ?? 0)}
                    </Text>
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                      {tCount('drCourses.lessonCount', showDeleteConfirm.lessons_count ?? 0)}
                    </Text>
                  </View>
                </View>

                <View style={{
                  flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12,
                  borderRadius: 12, backgroundColor: '#DC262610', borderWidth: 1, borderColor: '#DC262625',
                }}>
                  <AlertTriangle size={14} color="#DC2626" style={{ marginTop: 1 }} />
                  <Text style={{ flex: 1, fontSize: 12, color: '#DC2626', lineHeight: 18, fontWeight: '600' }}>
                    {t('archived.deleteWarning')}
                  </Text>
                </View>
              </View>
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={() => setShowDeleteConfirm(null)}
                accessibilityRole="button"
                style={[neuFlatStyle(isDark), { flex: 1, padding: 12, borderRadius: 12, alignItems: 'center' }]}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.55) }}>{t('archived.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={() => showDeleteConfirm && handlePermanentDelete(showDeleteConfirm)}
                accessibilityRole="button"
                style={{ flex: 1.2, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#DC2626' }}
              >
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>{t('archived.deleteForever')}</Text>
              </Pressable>
            </View>
          </NeuCard>
        </View>
      </Modal>
    </View>
  );
}

function MetaItem({ icon: Icon, label, c }: { icon: any; label: string; c: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' }}>
      <Icon size={12} color={c.text} opacity={0.4} />
      <Text style={{ fontSize: 11.5, ...mutedTextStyle(c, 0.55) }} numberOfLines={1}>{label}</Text>
    </View>
  );
}
