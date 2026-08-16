/**
 * ContactSheet
 *
 * Bottom sheet displayed when a student taps "Subscribe" on a course.
 * Shows only the contact methods configured for that course and launches
 * the appropriate deep link when tapped.
 *
 * Modular: the "Subscribe" action trigger can be replaced in the future
 * with Buy Now / Redeem Code / Instant Enrollment without touching this component.
 */
import { useEffect, useState } from 'react';
import {
  View, Text, Pressable, Modal, Linking, useColorScheme,
  Platform, StyleSheet, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming,
} from 'react-native-reanimated';
import { X } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CourseContact {
  whatsapp?: string | null;
  telegram?: string | null;
  phone?: string | null;
}

interface ContactSheetProps {
  visible: boolean;
  onClose: () => void;
  courseTitle: string;
  contact: CourseContact;
}

// ─── Platform config ─────────────────────────────────────────────────────────

interface PlatformOption {
  key: keyof CourseContact;
  label: string;
  color: string;
  bgColor: string;
  buildUrl: (value: string) => string;
  Icon: React.FC<{ size: number; color: string }>;
}

// SVG-free inline icon squares using Text (emoji fallback)
function PlatformIcon({ emoji, size }: { emoji: string; size: number }) {
  return <Text style={{ fontSize: size }}>{emoji}</Text>;
}

const PLATFORMS: PlatformOption[] = [
  {
    key: 'whatsapp',
    label: 'WhatsApp',
    color: '#ffffff',
    bgColor: '#25D366',
    buildUrl: (v) => {
      const num = v.replace(/[^\d+]/g, '');
      return `https://wa.me/${num.replace('+', '')}`;
    },
    Icon: ({ size, color }) => <PlatformIcon emoji="💬" size={size * 0.65} />,
  },
  {
    key: 'telegram',
    label: 'Telegram',
    color: '#ffffff',
    bgColor: '#229ED9',
    buildUrl: (v) => {
      if (v.startsWith('http')) return v;
      const handle = v.replace(/^@/, '');
      return `https://t.me/${handle}`;
    },
    Icon: ({ size, color }) => <PlatformIcon emoji="✈️" size={size * 0.65} />,
  },
  {
    key: 'phone',
    label: 'Phone Call',
    color: '#ffffff',
    bgColor: '#16A34A',
    buildUrl: (v) => `tel:${v.replace(/\s/g, '')}`,
    Icon: ({ size, color }) => <PlatformIcon emoji="📞" size={size * 0.65} />,
  },
];

// Platform button — uses useState for pressed state (NativeWind v4 cssInterop compat)
function PlatformButton({ platform, contact, colors, onPress }: {
  platform: PlatformOption;
  contact: CourseContact;
  colors: { base: string; shadowDark: string; text: string };
  onPress: (p: PlatformOption) => void;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={() => onPress(platform)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        styles.platformBtn,
        {
          backgroundColor: colors.base,
          shadowColor: colors.shadowDark,
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <View style={[styles.iconCircle, { backgroundColor: platform.bgColor }]}>
        <platform.Icon size={52} color={platform.color} />
      </View>
      <Text style={[styles.platformLabel, { color: colors.text }]}>{platform.label}</Text>
      <Text style={[styles.platformValue, { color: colors.text }]} numberOfLines={1}>
        {contact[platform.key]}
      </Text>
    </Pressable>
  );
}

export function ContactSheet({ visible, onClose, courseTitle, contact }: ContactSheetProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();

  // Available platforms for this course
  const available = PLATFORMS.filter(p => contact[p.key]);

  // Sheet slide-up animation — clamp initial offset to screen height so it
  // always animates in from off-screen regardless of device/orientation
  const slideOffset = screenH;
  const translateY = useSharedValue(slideOffset);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, { damping: 22, stiffness: 220, mass: 0.8 });
      backdropOpacity.value = withTiming(1, { duration: 220 });
    } else {
      translateY.value = withTiming(slideOffset, { duration: 260 });
      backdropOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [visible, slideOffset]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const handleOpen = async (platform: PlatformOption) => {
    const value = contact[platform.key];
    if (!value) return;
    const url = platform.buildUrl(value);
    const canOpen = await Linking.canOpenURL(url).catch(() => false);
    if (canOpen) {
      await Linking.openURL(url);
    } else {
      await Linking.openURL(url).catch(() => null);
    }
    onClose();
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Animated.View
        style={[StyleSheet.absoluteFillObject, { backgroundColor: '#000000' }, backdropStyle]}
      >
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
      </Animated.View>

      {/* Sheet — anchored to bottom, maxHeight so it never overflows in landscape */}
      <Animated.View style={[sheetStyle, styles.sheetContainer]}>
        <View style={[styles.sheet, {
          backgroundColor: c.base,
          shadowColor: c.shadowDark,
          // Bottom padding: real home-indicator / Android nav-bar inset + breathing room
          paddingBottom: Math.max(insets.bottom + 8, 20),
          // Cap height so content never runs off-screen in landscape
          maxHeight: screenH * 0.85,
        }]}>
          {/* Handle */}
          <View style={[styles.handle, { backgroundColor: `${c.text}20` }]} />

          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.text }]}>Subscribe to this course</Text>
              <Text style={[styles.subtitle, { color: c.text }]} numberOfLines={2}>
                {courseTitle}
              </Text>
            </View>
            <Pressable onPress={onClose} style={[styles.closeBtn, { backgroundColor: `${c.text}10` }]}>
              <X size={18} color={c.text} opacity={0.6} />
            </Pressable>
          </View>

          {/* Message */}
          <View style={[styles.messageBanner, { backgroundColor: `${c.primary}10` }]}>
            <Text style={[styles.messageText, { color: c.text }]}>
              To subscribe to this course, please contact the instructor using one of the methods below.
            </Text>
          </View>

          {/* Platform buttons */}
          <View style={styles.platformGrid}>
            {available.map((platform) => (
              <PlatformButton
                key={platform.key}
                platform={platform}
                contact={contact}
                colors={c}
                onPress={handleOpen}
              />
            ))}
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  sheetContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    paddingHorizontal: 20,
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 20,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    opacity: 0.5,
    lineHeight: 18,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
    marginTop: 2,
  },
  messageBanner: {
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
  },
  messageText: {
    fontSize: 13,
    lineHeight: 20,
    opacity: 0.75,
  },
  platformGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  platformBtn: {
    // 2-column grid: (screenWidth - 40 padding - 12 gap) / 2
    width: '47.5%',
    borderRadius: 20,
    padding: 16,
    alignItems: 'center',
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 0.55,
    shadowRadius: 8,
    elevation: 4,
  },
  iconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  platformLabel: {
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 3,
  },
  platformValue: {
    fontSize: 11,
    opacity: 0.45,
    textAlign: 'center',
  },
});
