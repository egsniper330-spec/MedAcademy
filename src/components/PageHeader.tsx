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
import { neuColors, useNeuSpacing } from '@/lib/neu';
import { spacing, iconContainer, iconSize, typography, safeArea, safeTop, safeLeft, safeRight } from '@/lib/ds';
import HamburgerButton from '@/components/HamburgerButton';
import { useDrawer } from '@/components/DrawerContext';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  accentColor?: string;
  showBack?: boolean;
  onBack?: () => void;
  /**
   * Route used when there is nothing to pop (e.g. a hidden tab screen entered
   * straight from the drawer, where `router.back()` would be a no-op). Lets
   * detail pages shared by several hubs declare a safe terminal fallback
   * instead of hardcoding a possibly-wrong parent in `onBack`.
   */
  backFallback?: string;
  rightAction?: React.ReactNode;
}

export function PageHeader({
  title, subtitle, accentColor, showBack = false, onBack, backFallback, rightAction,
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
    if (router.canGoBack()) { router.back(); return; }
    if (backFallback) router.push(backFallback as never);
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
      paddingLeft: leftPad + spacing.sm,
      paddingRight: rightPad,
    }}>
      {/* ── Left control ── */}
      {showBack ? (
        // Integrated back button: the icon IS the control (touch target comes
        // from the fixed 40dp box + hitSlop, not a visible container). The old
        // raised-chrome icon container (base-fill + border = the "white box")
        // is gone — every stack-pushed header now reads `←  Title`, matching
        // the app's standard header pattern on all pages.
        <Pressable
          onPress={handleBack}
          hitSlop={spacing.sm}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={{
            width: iconContainer.md.width,
            height: iconContainer.md.height,
            marginRight: spacing.sm + spacing.xs,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <ArrowLeft size={iconSize.lg} color={c.text} opacity={0.75} />
        </Pressable>
      ) : showHamburger ? (
        <HamburgerButton plain />
      ) : null}

      {/* ── Title block ── */}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontSize: sp.isTablet ? typography.h1.fontSize : typography.h2.fontSize,
            fontWeight: '800',
            color: accentColor ?? c.text,
            lineHeight: sp.isTablet ? typography.h1.lineHeight : typography.h2.lineHeight,
            marginLeft: spacing.sm + spacing.xs,
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

