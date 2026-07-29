/**
 * PageHeader — reusable neumorphic page header with safe-area awareness.
 *
 * Navigation model:
 *  • Root pages inside a drawer layout (showBack=false, DrawerContext present):
 *    — HamburgerButton auto-shown on the left so the drawer is always reachable.
 *  • Root pages without a drawer layout (showBack=false, no DrawerContext):
 *    — only title + subtitle + optional rightAction shown.
 *  • Secondary pages pushed onto the Stack (showBack=true):
 *    — a neumorphic ArrowLeft button is prepended; taps router.back() or the
 *      optional onBack override.
 */
import { View, Text, Pressable, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { neuColors, neuMicroStyle } from '@/lib/neu';
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

export function PageHeader({ title, subtitle, accentColor, showBack = false, onBack, rightAction }: PageHeaderProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const drawerCtx = useDrawer();
  const insideDrawer = drawerCtx._mounted;

  const handleBack = () => {
    if (onBack) { onBack(); return; }
    if (router.canGoBack()) router.back();
  };

  const showHamburger = !showBack && insideDrawer;

  // Safe-area rule: only consume the device top inset once.
  // When the header is the first element of a plain View/screen (not inside a
  // ScrollView with contentInsetAdjustmentBehavior), we need insets.top so
  // content clears the Dynamic Island / notch.  We add a fixed 10pt breathing
  // room (instead of 12) so the total is slightly tighter on large-inset
  // devices (iPhone 15 Pro: insets.top ≈ 59 → total 69) while still generous
  // on older iPhones (insets.top ≈ 44 → total 54) and Android (≈ 24 → 34).
  const topPad = insets.top > 0 ? insets.top + 10 : 20;

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      paddingTop: topPad,
      paddingBottom: 16,
      paddingHorizontal: 20,
      marginBottom: 4,
    }}>
      {showBack ? (
        <Pressable
          onPress={handleBack}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={{
            width: 40, height: 40, borderRadius: 13,
            marginRight: 12,
            ...neuMicroStyle(isDark),
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <ArrowLeft size={19} color={c.text} opacity={0.7} />
        </Pressable>
      ) : showHamburger ? (
        <View style={{ marginRight: 12 }}>
          <HamburgerButton />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        <Text style={{
          fontSize: 22, fontWeight: '800',
          color: accentColor ?? c.text,
          lineHeight: 26,
        }} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2, lineHeight: 16 }}>
            {subtitle}
          </Text>
        )}
      </View>

      {!!rightAction && (
        <View style={{ marginLeft: 10 }}>
          {rightAction}
        </View>
      )}
    </View>
  );
}
