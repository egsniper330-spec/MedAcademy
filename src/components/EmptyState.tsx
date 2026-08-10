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
 *     description="Activate a code or explore the catalog to get started."
 *     action={{ label: 'Explore Courses', onPress: () => router.push('/explore') }}
 *   />
 */
import React from 'react';
import { View, Text, useColorScheme } from 'react-native';
import { neuColors } from '@/lib/neu';
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
        <View style={{ opacity: 0.55, marginBottom: spacing.sm }}>
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
          style={{
            ...typography.body,
            color: c.text,
            opacity: 0.5,
            textAlign: 'center',
            maxWidth: 280,
          }}
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
