import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, Pressable, useColorScheme } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, Bell, CheckCircle, BookOpen } from 'lucide-react-native';
import Reanimated, { FadeInDown } from 'react-native-reanimated';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout } from '@/lib/neu';

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
  const layout = useLayout();

  // Fluid thumb size: ~20% of available width on phones, ~15% on tablets, min 64dp, max 100dp
  const availW     = layout.width - layout.screenPx * 2;
  const thumbSize  = Math.round(Math.max(64, Math.min(100, availW * (layout.isTablet ? 0.13 : 0.20))));
  const contentPx  = layout.pad.md;
  const contentPy  = layout.pad.sm + 2;

  // Fluid banner height (non-compact): 16:9 of card width, clamped
  const bannerH    = Math.round(Math.max(90, Math.min(160, availW * 0.42)));

  // Font sizes from adaptive tokens
  const titleFs    = layout.bodySize + 1;
  const metaFs     = layout.captionSize;
  const priceFs    = layout.captionSize + 1;
  const badgeFs    = layout.captionSize - 2;
  const btnFs      = layout.captionSize;
  const progressFs = layout.captionSize - 2;

  const showEnrollmentUI = isEnrolled !== undefined;

  // ── Compact: horizontal card (thumbnail left, content right) ─────────────
  if (compact) {
    return (
      <Reanimated.View entering={FadeInDown.delay(index * 60).springify().damping(14)}>
        <Pressable onPress={onPress} style={{ marginBottom: layout.pad.sm }}>
          <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
            {/* Thumbnail — fluid square */}
            <CompactThumb imageUrl={imageUrl} primary={c.primary} size={thumbSize}
              badge={showEnrollmentUI && isEnrolled ? (enrollmentStatus === 'completed' ? 'done' : 'enrolled') : undefined}
            />

            {/* Content */}
            <View style={{ flex: 1, paddingHorizontal: contentPx, paddingVertical: contentPy, justifyContent: 'space-between' }}>
              {/* Title */}
              <Text style={{ fontSize: titleFs, fontWeight: '700', color: c.text, lineHeight: titleFs * 1.3 }} numberOfLines={2}>
                {title}
              </Text>

              {/* Doctor */}
              {doctorName ? (
                <Text style={{ fontSize: metaFs, color: c.text, opacity: 0.5, marginTop: layout.pad.xs }} numberOfLines={1}>
                  Dr. {doctorName}
                </Text>
              ) : null}

              {/* Price */}
              {priceEgp !== undefined && !isEnrolled ? (
                <Text style={{ fontSize: priceFs, fontWeight: '800', marginTop: layout.pad.xs,
                  color: (!priceEgp || priceEgp === 0) ? '#16A34A' : c.primary }}>
                  {(!priceEgp || priceEgp === 0) ? 'Free' : `EGP ${Number(priceEgp).toFixed(0)}`}
                </Text>
              ) : null}

              {/* Progress bar */}
              {progress !== undefined ? (
                <View style={{ marginTop: layout.pad.xs }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                    <Text style={{ fontSize: progressFs, color: c.text, opacity: 0.45 }}>Progress</Text>
                    <Text style={{ fontSize: progressFs, color: PROGRESS_COLOR_DIM, fontWeight: '600' }}>{progress}%</Text>
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
                <View style={{ marginTop: layout.pad.xs, alignSelf: 'flex-start',
                  backgroundColor: legacyStatusColor(status, c.primary),
                  paddingHorizontal: layout.pad.sm, paddingVertical: 2, borderRadius: layout.cardRadius }}>
                  <Text style={{ fontSize: badgeFs, color: '#fff', fontWeight: '600', textTransform: 'uppercase' }}>{status}</Text>
                </View>
              ) : null}

              {/* Action buttons */}
              {showEnrollmentUI ? (
                isEnrolled ? (
                  <Pressable
                    onPress={(e) => { e.stopPropagation(); if (onAction) { onAction(); } else { onPress(); } }}
                    style={{ marginTop: layout.pad.xs, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      gap: layout.pad.xs, paddingVertical: layout.pad.sm, borderRadius: layout.cardRadius / 1.5,
                      backgroundColor: `${c.primary}18` }}
                  >
                    <Play size={btnFs} color={c.primary} />
                    <Text style={{ fontSize: btnFs, fontWeight: '700', color: c.primary }}>Continue</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={(e) => { e.stopPropagation(); if (onSubscribe) { onSubscribe(); } else { onPress(); } }}
                    style={{ marginTop: layout.pad.xs, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      gap: layout.pad.xs, paddingVertical: layout.pad.sm, borderRadius: layout.cardRadius / 1.5,
                      backgroundColor: c.primary }}
                  >
                    <Bell size={btnFs} color="#fff" />
                    <Text style={{ fontSize: btnFs, fontWeight: '700', color: '#fff' }}>Subscribe</Text>
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
      <Pressable onPress={onPress} style={{ marginBottom: layout.pad.md }}>
        <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
        {/* Thumbnail banner — fluid height */}
        <CourseThumbnailBanner imageUrl={imageUrl} height={bannerH} primary={c.primary}>
          {showEnrollmentUI && isEnrolled && (
            <View style={{
              position: 'absolute', top: layout.pad.sm, right: layout.pad.sm,
              backgroundColor: enrollmentStatus === 'completed' ? '#16A34A' : c.primary,
              borderRadius: layout.cardRadius, paddingHorizontal: layout.pad.sm, paddingVertical: 3,
              flexDirection: 'row', alignItems: 'center', gap: layout.pad.xs,
            }}>
              <CheckCircle size={badgeFs + 1} color="#fff" />
              <Text style={{ fontSize: badgeFs + 1, color: '#fff', fontWeight: '700' }}>
                {enrollmentStatus === 'completed' ? 'Completed' : 'Enrolled'}
              </Text>
            </View>
          )}
        </CourseThumbnailBanner>

        <View style={{ padding: contentPx }}>
          <Text style={{ fontSize: titleFs, fontWeight: '700', color: c.text, marginBottom: 2 }} numberOfLines={2}>
            {title}
          </Text>

          {doctorName ? (
            <Text style={{ fontSize: metaFs, color: c.text, opacity: 0.55, marginBottom: layout.pad.xs }}>
              Dr. {doctorName}
            </Text>
          ) : null}

          {description ? (
            <Text style={{ fontSize: metaFs, color: c.text, opacity: 0.5, lineHeight: metaFs * 1.4, marginBottom: layout.pad.xs }} numberOfLines={1}>
              {description}
            </Text>
          ) : null}

          {priceEgp !== undefined && !isEnrolled ? (
            <View style={{ alignSelf: 'flex-start', marginBottom: layout.pad.xs }}>
              <Text style={{ fontSize: priceFs, fontWeight: '800',
                color: (!priceEgp || priceEgp === 0) ? '#16A34A' : c.primary }}>
                {(!priceEgp || priceEgp === 0) ? 'Free' : `EGP ${Number(priceEgp).toFixed(0)}`}
              </Text>
            </View>
          ) : null}

          {progress !== undefined ? (
            <View style={{ marginBottom: layout.pad.xs }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                <Text style={{ fontSize: progressFs, color: c.text, opacity: 0.5 }}>Progress</Text>
                <Text style={{ fontSize: progressFs, color: PROGRESS_COLOR_DIM, fontWeight: '600' }}>{progress}%</Text>
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
            <View style={{ marginTop: layout.pad.xs, alignSelf: 'flex-start',
              backgroundColor: legacyStatusColor(status, c.primary),
              paddingHorizontal: layout.pad.sm, paddingVertical: 2, borderRadius: layout.cardRadius }}>
              <Text style={{ fontSize: badgeFs, color: '#fff', fontWeight: '600', textTransform: 'uppercase' }}>{status}</Text>
            </View>
          ) : null}

          {showEnrollmentUI ? (
            isEnrolled ? (
              <Pressable
                onPress={(e) => { e.stopPropagation(); if (onAction) { onAction(); } else { onPress(); } }}
                style={{ marginTop: layout.pad.xs, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  gap: layout.pad.sm, paddingVertical: layout.pad.md, borderRadius: layout.cardRadius / 1.5,
                  backgroundColor: `${c.primary}18` }}
              >
                <Play size={btnFs + 1} color={c.primary} />
                <Text style={{ fontSize: btnFs + 1, fontWeight: '700', color: c.primary }}>Continue Learning</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={(e) => { e.stopPropagation(); if (onSubscribe) { onSubscribe(); } else { onPress(); } }}
                style={{ marginTop: layout.pad.xs, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  gap: layout.pad.sm, paddingVertical: layout.pad.md, borderRadius: layout.cardRadius / 1.5,
                  backgroundColor: c.primary,
                  shadowColor: c.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 5 }}
              >
                <Bell size={btnFs + 1} color="#fff" />
                <Text style={{ fontSize: btnFs + 1, fontWeight: '700', color: '#fff' }}>Subscribe</Text>
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

// ── Compact thumbnail: fluid square with optional enrollment badge ─────────
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
  const iconSz = Math.round(size * 0.35);
  return (
    <View style={{ width: size, height: size, backgroundColor: `${primary}12`,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
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
        <BookOpen size={iconSz} color={primary} opacity={0.22} />
      )}
      {badge ? (
        <View style={{ position: 'absolute', bottom: 4, right: 4,
          backgroundColor: badge === 'done' ? '#16A34A' : primary,
          borderRadius: size / 4, padding: 3 }}>
          <CheckCircle size={Math.round(size * 0.14)} color="#fff" />
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