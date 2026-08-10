/**
 * SectionTitle — standardised section heading row.
 *
 * Provides a consistent visual separator between content sections,
 * with an optional right-side "See All" / action link.
 *
 * Usage:
 *   <SectionTitle title="My Courses" />
 *   <SectionTitle title="Featured" action={{ label: 'See All', onPress: ... }} />
 *   <SectionTitle title="Recent" icon={<Clock size={16} color={c.primary} />} />
 */
import React from 'react';
import { View, Text, Pressable, useColorScheme } from 'react-native';
import { neuColors } from '@/lib/neu';
import { spacing, typography } from '@/lib/ds';

interface SectionTitleProps {
  title: string;
  /** Optional left-side decorative icon */
  icon?: React.ReactNode;
  /** Optional right-side action (e.g. "See All") */
  action?: { label: string; onPress: () => void };
  /** Extra top margin — defaults to spacing.xl (20dp) */
  marginTop?: number;
  /** Extra bottom margin — defaults to spacing.md (12dp) */
  marginBottom?: number;
}

export function SectionTitle({
  title,
  icon,
  action,
  marginTop = spacing.xl,
  marginBottom = spacing.md,
}: SectionTitleProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginTop,
        marginBottom,
        gap: spacing.xs,
      }}
    >
      {!!icon && <View style={{ flexShrink: 0 }}>{icon}</View>}

      <Text
        style={{
          ...typography.h4,
          color: c.text,
          flex: 1,
        }}
        numberOfLines={1}
      >
        {title}
      </Text>

      {!!action && (
        <Pressable
          onPress={action.onPress}
          hitSlop={spacing.sm}
          accessibilityRole="button"
        >
          <Text
            style={{
              ...typography.labelSm,
              color: c.primary,
            }}
          >
            {action.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
