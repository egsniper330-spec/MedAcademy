import React, { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { BookOpen } from 'lucide-react-native';
import { useColorScheme } from 'react-native';
import { neuColors } from '@/lib/neu';

interface CourseThumbnailProps {
  /** Full URL of the course cover image (image_url / cover_url / thumbnail_url) */
  imageUrl?: string | null;
  /** Width of the thumbnail in logical pixels */
  width: number;
  /** Height of the thumbnail in logical pixels */
  height: number;
  /** Border radius applied to all corners */
  borderRadius?: number;
  /** Icon size for the BookOpen fallback — defaults to ~30% of width */
  iconSize?: number;
}

/**
 * CourseThumbnail
 *
 * Renders the course cover image when available; falls back gracefully to a
 * Book icon on a tinted background when:
 *   - no imageUrl is provided, or
 *   - the image fails to load.
 *
 * Usage:
 *   <CourseThumbnail imageUrl={course.image_url} width={44} height={44} borderRadius={12} />
 */
export function CourseThumbnail({
  imageUrl,
  width,
  height,
  borderRadius = 12,
  iconSize,
}: CourseThumbnailProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [failed, setFailed] = useState(false);

  const resolvedIconSize = iconSize ?? Math.round(width * 0.38);
  const showImage = !!imageUrl && !failed;

  return (
    <View
      style={{
        width,
        height,
        borderRadius,
        overflow: 'hidden',
        backgroundColor: `${c.primary}15`,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ width, height }}
          contentFit="cover"
          onError={() => setFailed(true)}
          // Efficient memory usage: recycle off-screen tiles
          recyclingKey={imageUrl}
          // Fade in smoothly
          transition={200}
        />
      ) : (
        <BookOpen size={resolvedIconSize} color={c.primary} opacity={0.35} />
      )}
    </View>
  );
}
