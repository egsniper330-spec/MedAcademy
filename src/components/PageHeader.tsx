/**
 * PageHeader — neumorphic page header, safe-area aware, responsive.
 *
 * Navigation model:
 *  • Root drawer pages  (showBack=false, DrawerContext present) → HamburgerButton on left
 *  • Root non-drawer    (showBack=false, no DrawerContext)      → title only
 *  • Stack-pushed pages (showBack=true)                        → back button on left
 *
 * Safe-area contract — all values from ds.ts:
 *  • paddingTop  = safeTop(insets.top)
 *  • paddingLeft = safeLeft(insets.left, isTablet)
 *    → button sits 4–8dp from the safe-area edge (Google / Telegram standard).
 */
import { View, Text, Pressable, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { neuColors, neuMicroStyle, useNeuSpacing } from '@/lib/neu';
import { spacing, iconContainer, iconSize, typography, safeArea, safeTop, safeLeft, safeRight } from '@/lib/ds';
import HamburgerButton from '@/components/HamburgerButton';
import { useDrawer } from '@/components/DrawerContext';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  accentColor?: string;
  showBack?: boolean;
  onBack?: () => void;
  rightAction?: React.ReactNode;
}

export function PageHeader({
  title, subtitle, accentColor, showBack = false, onBack, rightAction,
}: PageHeaderProps) {
  const scheme    = useColorScheme();
  const isDark    = scheme === 'dark';
  const c         = isDark ? neuColors.dark : neuColors.light;
  const router    = useRouter();
  const insets    = useSafeAreaInsets();
  const sp        = useNeuSpacing();
  const drawerCtx = useDrawer();
  const insideDrawer = drawerCtx._mounted;

  const handleBack = () => {
    if (onBack) { onBack(); return; }
    if (router.canGoBack()) router.back();
  };

  const showHamburger = !showBack && insideDrawer;

  const topPad   = safeTop(insets.top);
  const leftPad  = safeLeft(insets.left || 0, sp.isTablet);
  const rightPad = safeRight(insets.right || 0);

  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topPad,
      paddingBottom: spacing.md,
      paddingLeft: leftPad,
      paddingRight: rightPad,
    }}>
      {/* ── Left control ── */}
      {showBack ? (
        <Pressable
          onPress={handleBack}
          hitSlop={spacing.sm}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={{
            ...iconContainer.md,
            marginRight: spacing.sm + spacing.xs,
            alignItems: 'center', justifyContent: 'center',
            ...neuMicroStyle(isDark),
          }}
        >
          <ArrowLeft size={iconSize.lg} color={c.text} opacity={0.75} />
        </Pressable>
      ) : showHamburger ? (
        <View style={{ marginRight: spacing.sm + spacing.xs }}>
          <HamburgerButton />
        </View>
      ) : null}

      {/* ── Title block ── */}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontSize: sp.isTablet ? typography.h1.fontSize : typography.h2.fontSize,
            fontWeight: '800',
            color: accentColor ?? c.text,
            lineHeight: sp.isTablet ? typography.h1.lineHeight : typography.h2.lineHeight,
          }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {!!subtitle && (
          <Text
            style={{ ...typography.caption, color: c.text, opacity: 0.45, marginTop: 2 }}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>

      {/* ── Right actions ── */}
      {!!rightAction && (
        <View style={{ marginLeft: spacing.sm }}>{rightAction}</View>
      )}
    </View>
  );
}

