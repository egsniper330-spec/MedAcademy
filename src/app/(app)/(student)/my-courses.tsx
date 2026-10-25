import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { View, Text, useColorScheme, RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useProfileStore } from '@/lib/store';
import { getMySubscriptionsCached } from '@/lib/myCoursesCache';
import { prefetchCourseImages, courseImageUrlsFrom } from '@/lib/imagePrefetch';
import { CourseCard } from '@/components/CourseCard';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import type { RelativePathString } from 'expo-router';
import { NeuSearchBar } from '@/components/NeuInputRow';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScrollView';
import { t } from '@/lib/i18n';

export default function MyCourses() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const router = useRouter();

  const [subscriptions, setSubscriptions] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await getMySubscriptionsCached(profile.id);
      setSubscriptions(data);
      prefetchCourseImages(courseImageUrlsFrom(data));
    } catch {}
  }, [profile]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const filtered = subscriptions.filter(e =>
    e.course?.title?.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <KeyboardAwareScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <PageHeader title={t('nav.myCourses')} subtitle={t('course.subtitleMine')} />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* Search */}
        <View style={{ marginBottom: 12 }}>
          <NeuSearchBar
            c={c}
            value={query}
            onChangeText={setQuery}
            onClear={() => setQuery('')}
            placeholder={t('course.searchPlaceholder')}
          />
        </View>

        {filtered.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 60 }}>
            <Text style={{ fontSize: 16, ...mutedTextStyle(c, 0.4) }}>
              {query ? t('common.noResults') : t('course.none')}
            </Text>
          </View>
        ) : (
          filtered.map((sub) => (
            <CourseCard
              key={sub.id}
              title={sub.course?.title ?? t('course.titleFallback')}
              doctorName={sub.course?.doctor?.full_name}
              imageUrl={sub.course?.image_url}
              status={sub.status === 'completed' ? 'completed' : 'active'}
              compact
              onPress={() => router.push(`/(app)/course/${sub.course?.id}` as RelativePathString)}
            />
          ))
        )}
      </View>
    </KeyboardAwareScrollView>
  );
}
