import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, useColorScheme, TextInput,
  RefreshControl, ActivityIndicator, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Search, X, BookOpen } from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getFeaturedCourses, searchAllPublishedCourses, getMySubscriptions } from '@/lib/api';
import { CourseCard } from '@/components/CourseCard';
import { SubscribeSheet, type SubscribeSheetContact } from '@/components/SubscribeSheet';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { NeuSearchBar } from '@/components/NeuInputRow';
import type { RelativePathString } from 'expo-router';

const FEATURED_LIMIT = 10;

type CourseItem = {
  id: string;
  title: string;
  description?: string | null;
  image_url?: string | null;
  price_egp?: number | null;
  use_default_contact?: boolean | null;
  whatsapp?: string | null;
  telegram?: string | null;
  phone?: string | null;
  // The PHP data adapter preserves joined rows as arrays for legacy relation shapes;
  // we normalise to a single object via doctorOf() below.
  doctor?: {
    id: string;
    full_name: string;
    contact_whatsapp?: string | null;
    contact_telegram?: string | null;
    contact_phone?: string | null;
  } | {
    id: string;
    full_name: string;
    contact_whatsapp?: string | null;
    contact_telegram?: string | null;
    contact_phone?: string | null;
  }[] | null;
};

/** Resolve the effective contact info for a course, respecting use_default_contact. */
function resolveContact(item: CourseItem): { whatsapp?: string | null; telegram?: string | null; phone?: string | null } {
  const useDefault = item.use_default_contact !== false; // true when null/undefined (default)
  if (useDefault) {
    const doc = Array.isArray(item.doctor) ? (item.doctor[0] ?? null) : item.doctor;
    return {
      whatsapp: doc?.contact_whatsapp,
      telegram: doc?.contact_telegram,
      phone:    doc?.contact_phone,
    };
  }
  return { whatsapp: item.whatsapp, telegram: item.telegram, phone: item.phone };
}

function doctorOf(item: CourseItem): { id: string; full_name: string } | null {
  if (!item.doctor) return null;
  return Array.isArray(item.doctor) ? (item.doctor[0] ?? null) : item.doctor;
}export default function CoursesHome() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const router = useRouter();
  const { profile } = useProfileStore();

  // Featured / searched courses
  const [featured, setFeatured] = useState<CourseItem[]>([]);
  const [searchResults, setSearchResults] = useState<CourseItem[]>([]);
  // Set of enrolled course IDs → O(1) lookup
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const [enrollmentMap, setEnrollmentMap] = useState<Record<string, 'active' | 'completed'>>({});

  const [query, setQuery] = useState('');
  const [loadingFeatured, setLoadingFeatured] = useState(true);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Subscribe sheet state
  const [subscribeVisible, setSubscribeVisible] = useState(false);
  const [subscribeContact, setSubscribeContact] = useState<SubscribeSheetContact>({});
  const [subscribeCourseTitle, setSubscribeCourseTitle] = useState('');

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load featured courses + my enrollments ────────────────────────────────
  const loadFeatured = useCallback(async () => {
    try {
      const [courses, subs] = await Promise.all([
        getFeaturedCourses(FEATURED_LIMIT),
        profile ? getMySubscriptions(profile.id) : Promise.resolve([]),
      ]);
      setFeatured(courses as unknown as CourseItem[]);

      const ids = new Set<string>();
      const map: Record<string, 'active' | 'completed'> = {};
      for (const s of subs) {
        if (s.course?.id) {
          ids.add(s.course.id);
          map[s.course.id] = s.status === 'completed' ? 'completed' : 'active';
        }
      }
      setEnrolledIds(ids);
      setEnrollmentMap(map);
    } catch {
      // silently degrade — user still sees empty state
    } finally {
      setLoadingFeatured(false);
    }
  }, [profile]);

  useFocusEffect(
    useCallback(() => {
      setLoadingFeatured(true);
      void loadFeatured();
    }, [loadFeatured])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    setQuery('');
    setSearchResults([]);
    await loadFeatured();
    setRefreshing(false);
  };

  // ── Debounced search ──────────────────────────────────────────────────────
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);

    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchAllPublishedCourses(q);
        setSearchResults(results as unknown as CourseItem[]);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 320);

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  // ── Derived display list ──────────────────────────────────────────────────
  const isSearching = query.trim().length > 0;
  const displayList: CourseItem[] = isSearching ? searchResults : featured;

  // ── Render helpers ────────────────────────────────────────────────────────
  const renderItem = ({ item }: { item: CourseItem }) => {
    const enrolled = enrolledIds.has(item.id);
    const status = enrollmentMap[item.id] ?? null;
    const doctor = doctorOf(item);
    return (
      <CourseCard
        title={item.title}
        doctorName={doctor?.full_name}
        description={item.description}
        imageUrl={item.image_url}
        priceEgp={item.price_egp}
        isEnrolled={enrolled}
        enrollmentStatus={status}
        compact
        onPress={() => router.push(`/(app)/course/${item.id}` as RelativePathString)}
        onAction={() => router.push(`/(app)/course/${item.id}` as RelativePathString)}
        onSubscribe={() => {
          const contact = resolveContact(item);
          setSubscribeCourseTitle(item.title);
          setSubscribeContact(contact);
          setSubscribeVisible(true);
        }}
      />
    );
  };

  const ListHeader = (
    <>
      <PageHeader
        title="Courses"
        subtitle={isSearching
          ? `Searching all published courses…`
          : `${FEATURED_LIMIT} recently published`}
      />

    <View style={{ paddingHorizontal: layout.screenPx, paddingTop: 12 }}>

      {/* Search bar */}
      <View style={{ marginBottom: 12 }}>
        <NeuSearchBar
          c={c}
          value={query}
          onChangeText={setQuery}
          onClear={() => setQuery('')}
          placeholder="Search all courses by title, description, instructor…"
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          leftIcon={searching ? <ActivityIndicator size="small" color={c.primary} /> : undefined}
        />
      </View>

      {/* Section label */}
      {!isSearching && (
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.4,
          textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
          Recently Published
        </Text>
      )}
      {isSearching && !searching && searchResults.length > 0 && (
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.4,
          textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
          {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} found
        </Text>
      )}
    </View>
    </>
  );

  const ListEmpty = (
    <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: layout.screenPx }}>
      {loadingFeatured && !isSearching
        ? <ActivityIndicator size="large" color={c.primary} />
        : (
          <>
            <BookOpen size={52} color={c.primary} opacity={0.2} style={{ marginBottom: 14 }} />
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, opacity: 0.45, textAlign: 'center' }}>
              {isSearching ? 'No courses found' : 'No courses available'}
            </Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.35, marginTop: 6, textAlign: 'center' }}>
              {isSearching
                ? 'Try a different keyword or clear the search'
                : 'Check back soon for new content'}
            </Text>
          </>
        )
      }
    </View>
  );

  return (
    // Root View sets the neumorphic background — without this the system
    // default (white in light mode) bleeds through behind the FlatList.
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <FlatList
        data={displayList}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmpty}
        contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingBottom: layout.scrollBottom() }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />
        }
      />

      <SubscribeSheet
        visible={subscribeVisible}
        courseTitle={subscribeCourseTitle}
        contact={subscribeContact}
        onClose={() => setSubscribeVisible(false)}
      />
    </View>
  );
}
