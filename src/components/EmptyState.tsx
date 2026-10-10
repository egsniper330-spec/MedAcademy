/**
 * EmptyState — universal empty/placeholder component.
 *
 * Used whenever a list, search result, or data set is empty.
 * Never show a blank screen — always give the user context and a path forward.
 *
 * Usage:
 *   <EmptyState
 *     icon={<BookOpen size={48} color={c.primary} />}
 *     title="No courses yet"
 *     description="Explore the catalog to get started."
 *     action={{ label: 'Explore Courses', onPress: () => router.push('/explore') }}
 *   />
 */
import React from 'react';
import { View, Text, useColorScheme } from 'react-native';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { spacing, typography } from '@/lib/ds';

interface EmptyStateProps {
  /** Icon element — recommended size: iconSize.hero (48dp) */
  icon?: React.ReactNode;
  /** Primary message */
  title: string;
  /** Secondary explanation */
  description?: string;
  /** Optional CTA button */
  action?: { label: string; onPress: () => void };
  /** Extra container style */
  style?: object;
}

export function EmptyState({ icon, title, description, action, style }: EmptyStateProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <View
      style={[
        {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.xxl,
          paddingVertical: spacing.hero,
          gap: spacing.md,
        },
        style,
      ]}
    >
      {!!icon && (
        // Dark lifts the glyph slightly: a 55%-opacity icon on a deep navy field
        // reads as an accidental smudge rather than a deliberate illustration.
        <View style={{ opacity: isDark ? 0.72 : 0.55, marginBottom: spacing.sm }}>
          {icon}
        </View>
      )}

      <Text
        style={{
          ...typography.h3,
          color: c.text,
          textAlign: 'center',
        }}
      >
        {title}
      </Text>

      {!!description && (
        <Text
          style={[
            typography.body,
            { textAlign: 'center', maxWidth: 280 },
            mutedTextStyle(c, 0.5),
          ]}
        >
          {description}
        </Text>
      )}

      {!!action && (
        <View style={{ marginTop: spacing.md, minWidth: 160 }}>
          <NeuButton label={action.label} onPress={action.onPress} />
        </View>
      )}
    </View>
  );
}
