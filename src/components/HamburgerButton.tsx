import { Pressable, Platform, useColorScheme } from 'react-native';
import { Menu } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { iconContainer, iconSize } from '@/lib/ds';
import { useDrawer } from './DrawerContext';

interface Props {
  color?: string;
  /**
   * Plain variant — no raised box (background/border/shadow). Used inside
   * compact page headers where the button should read as part of the header
   * row, not as a separate card. Touch target and behaviour are unchanged.
   */
  plain?: boolean;
}

export default function HamburgerButton({ color, plain = false }: Props) {
  const { openDrawer } = useDrawer();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const iconColor = color ?? c.text;

  const base = {
    ...iconContainer.md,
    backgroundColor: plain ? 'transparent' : c.base,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  if (plain) {
    return (
      <Pressable
        onPress={openDrawer}
        hitSlop={12}
        accessibilityLabel="Open navigation menu"
        accessibilityRole="button"
        style={base}
      >
        <Menu size={iconSize.md} color={iconColor} />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={openDrawer}
      hitSlop={8}
      accessibilityLabel="Open navigation menu"
      accessibilityRole="button"
      style={Platform.select({
        ios: {
          ...base,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 3, height: 3 },
          shadowOpacity: 0.5,
          shadowRadius: 6,
        },
        android: {
          ...base,
          elevation: 0,
          borderWidth: 1,
          borderColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(160,185,215,0.55)',
        },
        web: {
          ...base,
          // @ts-ignore web-only
          boxShadow: `3px 3px 6px ${c.shadowDark}, -2px -2px 5px ${c.shadowLight}`,
        },
      })}
    >
      <Menu size={iconSize.md} color={iconColor} />
    </Pressable>
  );
}
