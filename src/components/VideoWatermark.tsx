/**
 * VideoWatermark.tsx
 *
 * Static semi-transparent identity watermark rendered as an absolute overlay
 * above the video player. Created once, never moves, starts no timers.
 *
 * Positioned at the top-right corner. pointerEvents="none" — fully
 * non-interactive. No Animated values, no useEffect, no setInterval.
 */

import { Text, View } from 'react-native';

export interface VideoWatermarkProps {
  /** Student full name, e.g. "Ahmed Mohamed" */
  name: string;
  /** Student / forensic watermark ID, e.g. "20251234" */
  studentId: string;
  /**
   * Optional timestamp string — shown below the ID when provided.
   * e.g. "2024-03-15 14:32"
   */
  timestamp?: string;
  /**
   * Opacity of the watermark text.
   * Spec: 20–30%. Default: 0.25.
   */
  opacity?: number;
}

export function VideoWatermark({
  name,
  studentId,
  timestamp,
  opacity = 0.25,
}: VideoWatermarkProps) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        maxWidth: '55%',
        zIndex: 10,
        opacity,
        pointerEvents: 'none' as const,
      }}
    >
      <View pointerEvents="none" style={{ pointerEvents: 'none' as const, flexDirection: 'column' }}>
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{
            color: '#ffffff',
            fontSize: 11,
            fontWeight: '600',
            letterSpacing: 0.3,
            lineHeight: 16,
            textShadowColor: 'rgba(0,0,0,0.7)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 3,
          }}
        >
          {name}
        </Text>
        <Text
          style={{
            color: '#ffffff',
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.8,
            lineHeight: 15,
            flexShrink: 0,
            flexWrap: 'wrap',
            textShadowColor: 'rgba(0,0,0,0.7)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 3,
          }}
        >
          {studentId}
        </Text>
        {timestamp && (
          <Text
            style={{
              color: '#ffffff',
              fontSize: 9,
              fontWeight: '300',
              letterSpacing: 0.1,
              lineHeight: 13,
              marginTop: 1,
              textShadowColor: 'rgba(0,0,0,0.7)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 3,
            }}
          >
            {timestamp}
          </Text>
        )}
      </View>
    </View>
  );
}

