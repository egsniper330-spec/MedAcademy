import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { View, Text, ScrollView, useColorScheme, RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useProfileStore } from '@/lib/store';
import { getMySubscriptions } from '@/lib/api';
import { CourseCard } from '@/components/CourseCard';
import { neuColors, useLayout } from '@/lib/neu';
import type { RelativePathString } from 'expo-router';
import { NeuSearchBar } from '@/components/NeuInputRow';

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
      const data = await getMySubscriptions(profile.id);
      setSubscriptions(data);
    } catch {}
  }, [profile]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const filtered = subscriptions.filter(e =>
    e.course?.title?.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <PageHeader title="My Courses" subtitle="Your subscribed courses" />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* Search */}
        <View style={{ marginBottom: 12 }}>
          <NeuSearchBar
            c={c}
            value={query}
            onChangeText={setQuery}
            onClear={() => setQuery('')}
            placeholder="Search courses…"
          />
        </View>

        {filtered.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 60 }}>
            <Text style={{ fontSize: 16, color: c.text, opacity: 0.4 }}>
              {query ? 'No results found' : 'No subscribed courses'}
            </Text>
          </View>
        ) : (
          filtered.map((sub) => (
            <CourseCard
              key={sub.id}
              title={sub.course?.title ?? 'Course'}
              doctorName={sub.course?.doctor?.full_name}
              imageUrl={sub.course?.image_url}
              status={sub.status === 'completed' ? 'completed' : 'active'}
              compact
              onPress={() => router.push(`/(app)/course/${sub.course?.id}` as RelativePathString)}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}
