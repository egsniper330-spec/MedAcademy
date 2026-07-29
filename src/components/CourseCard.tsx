import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, Pressable, useColorScheme } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, Bell, CheckCircle, BookOpen } from 'lucide-react-native';
import Reanimated, { FadeInDown } from 'react-native-reanimated';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';

// ── Shimmer skeleton for thumbnail loading state ──────────────────────────
function SkeletonShimmer({ width, height, borderRadius = 0 }: { width: number | string; height: number; borderRadius?: number }) {
  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    ).start();
    return () => shimmer.stopAnimation();
  }, [shimmer]);
  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] });
  return (
    <Animated.View
      style={{
        width: width as number,
        height,
        borderRadius,
        backgroundColor: '#9CA3AF',
        opacity,
      }}
    />
  );
}

// Emerald green — course progress fill color (matches CourseProgressBar)
const PROGRESS_COLOR     = '#22C55E';
const PROGRESS_COLOR_DIM = '#16A34A'; // label / percentage text

interface CourseCardProps {
  title: string;
  doctorName?: string;
  description?: string | null;
  imageUrl?: string | null;
  progress?: number;
  priceEgp?: number | null;
  status?: string;
  isEnrolled?: boolean;
  enrollmentStatus?: 'active' | 'completed' | null;
  onPress: () => void;
  onAction?: () => void;
  onSubscribe?: () => void;
  /** Compact mode — horizontal layout, small thumbnail, minimal padding */
  compact?: boolean;
  /** Position index used for staggered enter animation */
  index?: number;
}

export function CourseCard({
  title,
  doctorName,
  description,
  imageUrl,
  progress,
  priceEgp,
  status,
  isEnrolled,
  enrollmentStatus,
  onPress,
  onAction,
  onSubscribe,
  compact = false,
  index = 0,
}: CourseCardProps & { index?: number }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const showEnrollmentUI = isEnrolled !== undefined;

  // ── Compact: horizontal card (thumbnail left, content right) ─────────────
  if (compact) {
    return (
      <Reanimated.View entering={FadeInDown.delay(index * 60).springify().damping(14)}>
        <Pressable onPress={onPress} style={{ marginBottom: 8 }}>
          <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
            {/* Thumbnail — fixed 80×80 square */}
            <CompactThumb imageUrl={imageUrl} primary={c.primary} size={80}
              badge={showEnrollmentUI && isEnrolled ? (enrollmentStatus === 'completed' ? 'done' : 'enrolled') : undefined}
            />

            {/* Content */}
            <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'space-between' }}>
              {/* Title */}
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, lineHeight: 17 }} numberOfLines={2}>
                {title}
              </Text>

              {/* Doctor */}
              {doctorName ? (
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }} numberOfLines={1}>
                  Dr. {doctorName}
                </Text>
              ) : null}

              {/* Price */}
              {priceEgp !== undefined && !isEnrolled ? (
                <Text style={{ fontSize: 12, fontWeight: '800', marginTop: 3,
                  color: (!priceEgp || priceEgp === 0) ? '#16A34A' : c.primary }}>
                  {(!priceEgp || priceEgp === 0) ? 'Free' : `EGP ${Number(priceEgp).toFixed(0)}`}
                </Text>
              ) : null}

              {/* Progress bar */}
              {progress !== undefined ? (
                <View style={{ marginTop: 4 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.45 }}>Progress</Text>
                    <Text style={{ fontSize: 10, color: PROGRESS_COLOR_DIM, fontWeight: '600' }}>{progress}%</Text>
                  </View>
                  <View style={{ height: 3, backgroundColor: isDark ? '#1a3a2a' : '#dcfce7', borderRadius: 2, overflow: 'hidden' }}>
                    <LinearGradient
                      colors={['#34D399', PROGRESS_COLOR]}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={{ height: 3, width: `${progress}%` as `${number}%`, borderRadius: 2 }}
                    />
                  </View>
                </View>
              ) : null}

              {/* Legacy status */}
              {status && !showEnrollmentUI ? (
                <View style={{ marginTop: 4, alignSelf: 'flex-start',
                  backgroundColor: legacyStatusColor(status, c.primary),
                  paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20 }}>
                  <Text style={{ fontSize: 9, color: '#fff', fontWeight: '600', textTransform: 'uppercase' }}>{status}</Text>
                </View>
              ) : null}

              {/* Action buttons */}
              {showEnrollmentUI ? (
                isEnrolled ? (
                  <Pressable
                    onPress={(e) => { e.stopPropagation(); if (onAction) { onAction(); } else { onPress(); } }}
                    style={{ marginTop: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      gap: 5, paddingVertical: 5, borderRadius: 8,
                      backgroundColor: `${c.primary}18` }}
                  >
                    <Play size={10} color={c.primary} />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>Continue</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={(e) => { e.stopPropagation(); if (onSubscribe) { onSubscribe(); } else { onPress(); } }}
                    style={{ marginTop: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      gap: 5, paddingVertical: 5, borderRadius: 8, backgroundColor: c.primary }}
                  >
                    <Bell size={10} color="#fff" />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>Subscribe</Text>
                  </Pressable>
                )
              ) : null}
            </View>
          </View>
        </NeuCard>
      </Pressable>
      </Reanimated.View>
    );
  }

  // ── Default (non-compact): vertical card with full-width banner ──────────
  return (
    <Reanimated.View entering={FadeInDown.delay(index * 60).springify().damping(14)}>
      <Pressable onPress={onPress} style={{ marginBottom: 12 }}>
        <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
        {/* Thumbnail banner */}
        <CourseThumbnailBanner imageUrl={imageUrl} height={110} primary={c.primary}>
          {showEnrollmentUI && isEnrolled && (
            <View style={{
              position: 'absolute', top: 7, right: 7,
              backgroundColor: enrollmentStatus === 'completed' ? '#16A34A' : c.primary,
              borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3,
              flexDirection: 'row', alignItems: 'center', gap: 4,
            }}>
              <CheckCircle size={10} color="#fff" />
              <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>
                {enrollmentStatus === 'completed' ? 'Completed' : 'Enrolled'}
              </Text>
            </View>
          )}
        </CourseThumbnailBanner>

        <View style={{ padding: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }} numberOfLines={2}>
            {title}
          </Text>

          {doctorName ? (
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, marginBottom: 4 }}>
              Dr. {doctorName}
            </Text>
          ) : null}

          {description ? (
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, lineHeight: 16, marginBottom: 5 }} numberOfLines={1}>
              {description}
            </Text>
          ) : null}

          {priceEgp !== undefined && !isEnrolled ? (
            <View style={{ alignSelf: 'flex-start', marginBottom: 5 }}>
              <Text style={{ fontSize: 12, fontWeight: '800',
                color: (!priceEgp || priceEgp === 0) ? '#16A34A' : c.primary }}>
                {(!priceEgp || priceEgp === 0) ? 'Free' : `EGP ${Number(priceEgp).toFixed(0)}`}
              </Text>
            </View>
          ) : null}

          {progress !== undefined ? (
            <View style={{ marginBottom: 5 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Progress</Text>
                <Text style={{ fontSize: 10, color: PROGRESS_COLOR_DIM, fontWeight: '600' }}>{progress}%</Text>
              </View>
              <View style={{ height: 3, backgroundColor: isDark ? '#1a3a2a' : '#dcfce7', borderRadius: 2, overflow: 'hidden' }}>
                <LinearGradient
                  colors={['#34D399', PROGRESS_COLOR]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={{ height: 3, width: `${progress}%` as `${number}%`, borderRadius: 2 }}
                />
              </View>
            </View>
          ) : null}

          {status && !showEnrollmentUI ? (
            <View style={{ marginTop: 3, alignSelf: 'flex-start',
              backgroundColor: legacyStatusColor(status, c.primary),
              paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 }}>
              <Text style={{ fontSize: 9, color: '#fff', fontWeight: '600', textTransform: 'uppercase' }}>{status}</Text>
            </View>
          ) : null}

          {showEnrollmentUI ? (
            isEnrolled ? (
              <Pressable
                onPress={(e) => { e.stopPropagation(); if (onAction) { onAction(); } else { onPress(); } }}
                style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  gap: 6, paddingVertical: 8, borderRadius: 10, backgroundColor: `${c.primary}18` }}
              >
                <Play size={12} color={c.primary} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Continue Learning</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={(e) => { e.stopPropagation(); if (onSubscribe) { onSubscribe(); } else { onPress(); } }}
                style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  gap: 6, paddingVertical: 8, borderRadius: 10, backgroundColor: c.primary,
                  shadowColor: c.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 5 }}
              >
                <Bell size={12} color="#fff" />
                <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Subscribe</Text>
              </Pressable>
            )
          ) : null}
        </View>
      </NeuCard>
    </Pressable>
    </Reanimated.View>
  );
}

function legacyStatusColor(status: string, primary: string) {
  if (status === 'published') return '#16A34A';
  if (status === 'hidden') return '#D97706';
  if (status === 'archived') return '#6B7280';
  return primary;
}

// ── Compact thumbnail: fixed square with optional enrollment badge ─────────
interface CompactThumbProps {
  imageUrl?: string | null;
  primary: string;
  size: number;
  badge?: 'enrolled' | 'done';
}

function CompactThumb({ imageUrl, primary, size, badge }: CompactThumbProps) {
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const showImage = !!imageUrl && !failed;
  return (
    <View style={{ width: size, height: size, backgroundColor: `${primary}12`,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {/* Skeleton shimmer shown until image loads or on error */}
      {showImage && !loaded && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          <SkeletonShimmer width={size} height={size} />
        </View>
      )}
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          contentFit="cover"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          recyclingKey={imageUrl}
          transition={300}
        />
      ) : (
        <BookOpen size={28} color={primary} opacity={0.22} />
      )}
      {badge ? (
        <View style={{ position: 'absolute', bottom: 4, right: 4,
          backgroundColor: badge === 'done' ? '#16A34A' : primary,
          borderRadius: 12, padding: 3 }}>
          <CheckCircle size={10} color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

// ── Full-width banner thumbnail (non-compact default card) ────────────────
interface BannerProps {
  imageUrl?: string | null;
  height: number;
  primary: string;
  children?: React.ReactNode;
}

function CourseThumbnailBanner({ imageUrl, height, primary, children }: BannerProps) {
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const showImage = !!imageUrl && !failed;
  return (
    <View style={{ width: '100%', height, backgroundColor: `${primary}12`,
      alignItems: 'center', justifyContent: 'center' }}>
      {/* Skeleton shimmer while image is loading */}
      {showImage && !loaded && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          <SkeletonShimmer width="100%" height={height} />
        </View>
      )}
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          contentFit="cover"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          recyclingKey={imageUrl}
          transition={300}
        />
      ) : (
        <BookOpen size={40} color={primary} opacity={0.22} />
      )}
      {children}
    </View>
  );
}