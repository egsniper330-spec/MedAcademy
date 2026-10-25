import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, useColorScheme, TextInput,
  RefreshControl, ActivityIndicator, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Search, X, BookOpen } from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getFeaturedCourses, searchAllPublishedCourses } from '@/lib/api';
import { getMySubscriptionsCached } from '@/lib/myCoursesCache';
import { prefetchCourseImages, courseImageUrlsFrom } from '@/lib/imagePrefetch';
import { CourseCard } from '@/components/CourseCard';
import { SubscribeSheet, type SubscribeSheetContact } from '@/components/SubscribeSheet';
// ONE shared contact resolver — the SAME rule the course-details screen uses.
import { resolveCourseContact } from '@/lib/subscribeContact';
import { isFreeCourse, enrollInFreeCourse, EnrollmentError } from '@/lib/courseEnrollment';
import { useStaleWhileRevalidateFocus } from '@/lib/useStaleWhileRevalidateFocus';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { NeuSearchBar } from '@/components/NeuInputRow';
import { useTranslation } from '@/lib/i18n';
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

// NOTE: the use_default_contact → doctor / course-level contact rule used to
// live here as a private copy. It now lives in ONE place
// (src/lib/subscribeContact.ts) and is shared with the course-details screen,
// so the two Subscribe flows can never resolve different contacts again.

function doctorOf(item: CourseItem): { id: string; full_name: string } | null {
  if (!item.doctor) return null;
  return Array.isArray(item.doctor) ? (item.doctor[0] ?? null) : item.doctor;
}export default function CoursesHome() {
  const { t, tCount } = useTranslation();
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
  // Free-course enrollment in flight (one at a time — a second tap on any card
  // while a request is running is ignored, so no duplicate POST can be sent).
  const [enrollingId, setEnrollingId] = useState<string | null>(null);
  const { showToast } = useToast();

  /**
   * ── FREE COURSES ENROLL IMMEDIATELY ─────────────────────────────────────
   * The card's Subscribe action used to open the doctor's contact sheet for
   * EVERY course, including free ones — so a free course could never actually
   * be joined from this list. A free course now calls the server enrollment
   * operation and the card flips to "enrolled" at once.
   *
   * An authoritative 402 (the server's price is not actually 0) falls back to
   * the unchanged contact/purchase sheet; nothing here can grant paid access.
   */
  const handleSubscribe = useCallback(async (item: CourseItem) => {
    if (isFreeCourse(item)) {
      if (enrollingId) return;
      setEnrollingId(item.id);
      try {
        const res = await enrollInFreeCourse(item.id);
        setEnrolledIds((prev) => {
          const next = new Set(prev);
          next.add(item.id);
          return next;
        });
        setEnrollmentMap((prev) => ({ ...prev, [item.id]: 'active' }));
        showToast({
          type: 'success',
          message: res.alreadyEnrolled ? t('course.enrollAlready') : t('course.enrollSuccess'),
        });
      } catch (e) {
        const code = e instanceof EnrollmentError ? e.code : 'failed';
        if (code === 'paid_course') {
          const contact = resolveCourseContact(item);
          setSubscribeCourseTitle(item.title);
          setSubscribeContact(contact);
          setSubscribeVisible(true);
        } else {
          showToast({
            type: 'error',
            message: code === 'suspended' ? t('course.enrollSuspended') : t('course.enrollFailed'),
          });
        }
      } finally {
        setEnrollingId(null);
      }
      return;
    }
    // PAID course — unchanged contact/purchase flow.
    const contact = resolveCourseContact(item);
    setSubscribeCourseTitle(item.title);
    setSubscribeContact(contact);
    setSubscribeVisible(true);
  }, [enrollingId, showToast, t]);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load featured courses + my enrollments ────────────────────────────────
  const loadFeatured = useCallback(async () => {
    try {
      const [courses, subs] = await Promise.all([
        getFeaturedCourses(FEATURED_LIMIT),
        profile ? getMySubscriptionsCached(profile.id) : Promise.resolve([]),
      ]);
      setFeatured(courses as unknown as CourseItem[]);
      prefetchCourseImages(courseImageUrlsFrom(courses));

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

  // STALE-WHILE-REVALIDATE (performance): the course list used to be replaced
  // by a spinner on every focus — returning from a course, closing a sheet or
  // switching tabs all blanked it. It now refreshes in the background and the
  // spinner is reserved for the genuine first load. Same request, same
  // freshness; a doubled focus can no longer start two batches.
  useStaleWhileRevalidateFocus(loadFeatured, {
    setLoading: setLoadingFeatured,
    hasContent: () => featured.length > 0,
  });

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
        onSubscribe={() => { void handleSubscribe(item); }}
      />
    );
  };

  const ListHeader = (
    <>
    {/* PageHeader lives OUTSIDE the padded FlatList (see render below) so the
        hamburger/title stay on the app-wide safe-area edge grid; the FlatList
        contentContainerStyle owns horizontal padding for everything else. */}
    <View style={{ paddingTop: 12 }}>

      {/* Search bar */}
      <View style={{ marginBottom: 12 }}>
        <NeuSearchBar
          c={c}
          value={query}
          onChangeText={setQuery}
          onClear={() => setQuery('')}
          placeholder={t('explore.searchPlaceholder')}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          leftIcon={searching ? <ActivityIndicator size="small" color={c.primary} /> : undefined}
        />
      </View>

      {/* Section label */}
      {!isSearching && (
        <Text style={{ fontSize: 13, fontWeight: '700', ...mutedTextStyle(c, 0.4),
          textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
          {t('explore.recentlyPublished')}
        </Text>
      )}
      {isSearching && !searching && searchResults.length > 0 && (
        <Text style={{ fontSize: 13, fontWeight: '700', ...mutedTextStyle(c, 0.4),
          textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
          {tCount('explore.resultsFound', searchResults.length)}
        </Text>
      )}
    </View>
    </>
  );

  const ListEmpty = (
    <View style={{ alignItems: 'center', paddingVertical: 60 }}>
      {loadingFeatured && !isSearching
        ? <ActivityIndicator size="large" color={c.primary} />
        : (
          <>
            <BookOpen size={52} color={c.primary} opacity={0.2} style={{ marginBottom: 14 }} />
            <Text style={{ fontSize: 17, fontWeight: '700', ...mutedTextStyle(c, 0.45), textAlign: 'center' }}>
              {isSearching ? t('explore.noCoursesFound') : t('explore.noCoursesAvailable')}
            </Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.35), marginTop: 6, textAlign: 'center' }}>
              {isSearching
                ? t('explore.searchHint')
                : t('explore.emptyHint')}
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
      <PageHeader
        title={t('common.courses')}
        subtitle={isSearching
          ? t('explore.searchingAll')
          : tCount('explore.recentlyPublishedCount', FEATURED_LIMIT)}
      />
      <FlatList
        data={displayList}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmpty}
        contentContainerStyle={{ paddingHorizontal: layout.screenPx }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        /* keyboard: native iOS inset, once — no KeyboardAvoidingView stacking a
           second inset on top; Android is adjustResize so nothing is needed
           there. Same mechanism as the shared KeyboardAwareScrollView. */
        automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
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
