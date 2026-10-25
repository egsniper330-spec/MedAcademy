/**
 * PageHeader — neumorphic page header, safe-area aware, responsive.
 *
 * Navigation model — ONE contextual resolver (see lib/navigation/navIntent.ts):
 *  • primary drawer/tab destination opened from the drawer/tab bar → hamburger
 *  • primary destination opened from a quick action / card / link → Back
 *  • nested screen (editor, detail, report, form)                 → Back
 *  • direct entry (deep link, notification, cold start)           → Back only
 *    with usable history, otherwise the role dashboard fallback / hamburger
 * `showBack` / `navMode` remain as explicit per-screen overrides.
 *
 * Safe-area contract — all values from ds.ts:
 *  • paddingTop  = safeTop(insets.top)
 *  • paddingLeft = safeLeft(insets.left, isTablet)
 *    → button sits 4–8dp from the safe-area edge (Google / Telegram standard).
 */
import { View, Text, Pressable, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ArrowRight } from 'lucide-react-native';
import { neuColors, useNeuSpacing, mutedTextStyle } from '@/lib/neu';
import { spacing, iconContainer, iconSize, typography, safeArea, safeTop, safeLeft, safeRight } from '@/lib/ds';
import HamburgerButton from '@/components/HamburgerButton';
import { useDrawer } from '@/components/DrawerContext';
import { useNavHeader } from '@/lib/navigation/useNavHeader';
import { t, useTranslation } from '@/lib/i18n';

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
  /**
   * Force the leading control. Omit for the contextual default (recommended):
   * the header decides from the navigation intent + route classification, not
   * from a hardcoded guess.
   */
  navMode?: 'menu' | 'back';
}

export function PageHeader({
  title, subtitle, accentColor, showBack, onBack, backFallback, rightAction, navMode,
}: PageHeaderProps) {
  const scheme    = useColorScheme();
  const isDark    = scheme === 'dark';
  const c         = isDark ? neuColors.dark : neuColors.light;
  const insets    = useSafeAreaInsets();
  const sp        = useNeuSpacing();
  const drawerCtx = useDrawer();
  const insideDrawer = drawerCtx._mounted;
  // "Back" points along the reading direction: left in LTR, right in RTL.
  // Icons are not mirrored by the layout engine, so this is explicit and the
  // back affordance stays a directional arrow in both directions.
  const { isRTL } = useTranslation();

  // Contextual control: intent → root classification → real history → fallback.
  const { control, handleBack } = useNavHeader({
    showBack,
    navMode,
    fallback: backFallback,
    insideDrawer,
    onBack,
  });
  const isMenu = control === 'menu';
  const showHamburger = isMenu && insideDrawer;

  const topPad   = safeTop(insets.top);
  const leftPad  = safeLeft(insets.left || 0, sp.isTablet);
  const rightPad = safeRight(insets.right || 0);

  /**
   * ── ARABIC HEADER ALIGNMENT (root cause) ─────────────────────────────────
   * The reported defect: with Arabic selected, the page title stayed against
   * the LEFT edge. Nothing here was styled wrongly — the title simply had no
   * `textAlign`, so React Native resolved it through `I18nManager.isRTL`, i.e.
   * the NATIVE layout direction. That flag only changes after the relaunch
   * `applyRTL()` schedules, so until that relaunch (and permanently on any
   * build/orientation where the native RTL state is not set) Arabic copy was
   * laid out with English direction rules.
   *
   * Fix: the header follows the APP locale it is already using for `t()` and
   * for the back-arrow glyph above, never the native flag. Mirroring the row
   * (`row-reverse`) puts the leading control on the right and keeps the title
   * block beside it, and the explicit `textAlign` / `writingDirection` make the
   * heading right-aligned in Arabic and left-aligned in English regardless of
   * `I18nManager`. Only the direction-dependent spacing is mirrored — icons,
   * the title text itself and every child component are untouched, so English
   * layouts render exactly as before.
   */
  const textAlign = isRTL ? 'right' : 'left';

  return (
    <View style={{
      flexDirection: isRTL ? 'row-reverse' : 'row',
      alignItems: 'center',
      // One gap instead of per-child margins: a physical marginLeft/Right would
      // point the wrong way as soon as the row is mirrored.
      gap: spacing.sm + spacing.xs,
      paddingTop: topPad,
      paddingBottom: spacing.md,
      paddingLeft: leftPad + spacing.sm,
      paddingRight: rightPad,
    }}>
      {/* ── Left control ── */}
      {!isMenu ? (
        // Integrated back button: the icon IS the control (touch target comes
        // from the fixed 40dp box + hitSlop, not a visible container). The old
        // raised-chrome icon container (base-fill + border = the "white box")
        // is gone — every stack-pushed header now reads `←  Title`, matching
        // the app's standard header pattern on all pages.
        <Pressable
          onPress={handleBack}
          hitSlop={spacing.sm}
          accessibilityLabel={t('common.goBack')}
          accessibilityRole="button"
          style={{
            width: iconContainer.md.width,
            height: iconContainer.md.height,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          {isRTL
            ? <ArrowRight size={iconSize.lg} color={c.text} opacity={0.75} />
            : <ArrowLeft  size={iconSize.lg} color={c.text} opacity={0.75} />}
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
            textAlign,
            writingDirection: isRTL ? 'rtl' : 'ltr',
          }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {!!subtitle && (
          <Text
            style={{
              ...typography.caption, ...mutedTextStyle(c, 0.45), marginTop: 2,
              textAlign,
              writingDirection: isRTL ? 'rtl' : 'ltr',
            }}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>

      {/* ── Right actions ── */}
      {!!rightAction && (
        <View>{rightAction}</View>
      )}
    </View>
  );
}

