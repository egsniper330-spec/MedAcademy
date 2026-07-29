import React from 'react';
import {
  View, Text, Modal, Pressable, Linking,
  useColorScheme, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageCircle, Send, Phone, X, UserCheck } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';

export interface SubscribeSheetContact {
  whatsapp?: string | null;
  telegram?: string | null;
  phone?: string | null;
}

interface Props {
  visible: boolean;
  courseTitle: string;
  contact: SubscribeSheetContact;
  onClose: () => void;
}

// ── URL builders ──────────────────────────────────────────────────────────────

function whatsappUrl(number: string): string {
  // Strip everything except digits and leading +
  const clean = number.replace(/[^\d+]/g, '');
  return `https://wa.me/${clean}`;
}

function telegramUrl(handle: string): string {
  const t = handle.trim();
  // Already a full URL
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  // @username or plain username
  const username = t.startsWith('@') ? t.slice(1) : t;
  return `https://t.me/${username}`;
}

function phoneUrl(number: string): string {
  return `tel:${number.replace(/\s/g, '')}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SubscribeSheet({ visible, courseTitle, contact, onClose }: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const insets = useSafeAreaInsets();

  const hasWhatsApp = !!contact.whatsapp?.trim();
  const hasTelegram = !!contact.telegram?.trim();
  const hasPhone    = !!contact.phone?.trim();
  const hasAny      = hasWhatsApp || hasTelegram || hasPhone;

  const open = (url: string) => {
    Linking.openURL(url).catch(() => {});
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      {/* Scrim */}
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }}
        onPress={onClose}
      />

      {/* Sheet */}
      <View style={{
        backgroundColor: c.base,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        paddingTop: 12,
        paddingBottom: Math.max(insets.bottom, 24),
        shadowColor: c.shadowDark,
        shadowOffset: { width: 0, height: -6 },
        shadowOpacity: 0.18,
        shadowRadius: 20,
      }}>
        {/* Drag handle */}
        <View style={{
          width: 40, height: 4, borderRadius: 2,
          backgroundColor: `${c.text}22`,
          alignSelf: 'center', marginBottom: 20,
        }} />

        {/* Header row */}
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 24, marginBottom: 6,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: c.text }}>
              Subscribe to this Course
            </Text>
            <Text style={{
              fontSize: 13, color: c.text, opacity: 0.5,
              marginTop: 3, lineHeight: 18,
            }} numberOfLines={2}>
              {courseTitle}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={{
              marginLeft: 12,
              width: 34, height: 34, borderRadius: 17,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: c.base,
              shadowColor: c.shadowDark,
              shadowOffset: { width: 2, height: 2 },
              shadowOpacity: 0.5, shadowRadius: 4,
            }}
          >
            <X size={16} color={c.text} opacity={0.5} />
          </Pressable>
        </View>

        {/* Sub-label */}
        <Text style={{
          fontSize: 13, color: c.text, opacity: 0.45,
          paddingHorizontal: 24, marginBottom: 24, lineHeight: 18,
        }}>
          {hasAny
            ? 'Choose how you would like to contact the instructor.'
            : undefined}
        </Text>

        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
          scrollEnabled={false}
        >
          {hasAny ? (
            <>
              {/* WhatsApp */}
              {hasWhatsApp && (
                <ContactButton
                  label="WhatsApp"
                  icon={<MessageCircle size={20} color="#25D366" />}
                  accentColor="#25D366"
                  c={c}
                  isDark={isDark}
                  onPress={() => open(whatsappUrl(contact.whatsapp!))}
                />
              )}

              {/* Telegram */}
              {hasTelegram && (
                <ContactButton
                  label="Telegram"
                  icon={<Send size={20} color="#229ED9" />}
                  accentColor="#229ED9"
                  c={c}
                  isDark={isDark}
                  onPress={() => open(telegramUrl(contact.telegram!))}
                />
              )}

              {/* Phone */}
              {hasPhone && (
                <ContactButton
                  label="Call Doctor"
                  icon={<Phone size={20} color={c.primary} />}
                  accentColor={c.primary}
                  c={c}
                  isDark={isDark}
                  onPress={() => open(phoneUrl(contact.phone!))}
                />
              )}
            </>
          ) : (
            /* Fallback — no contact methods configured */
            <View style={{
              alignItems: 'center', paddingVertical: 32, gap: 12,
            }}>
              <UserCheck size={44} color={c.text} opacity={0.15} />
              <Text style={{
                fontSize: 14, color: c.text, opacity: 0.4,
                textAlign: 'center', lineHeight: 20,
              }}>
                No contact methods are available{'\n'}for this course.
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── ContactButton ─────────────────────────────────────────────────────────────

interface ButtonProps {
  label: string;
  icon: React.ReactNode;
  accentColor: string;
  c: typeof neuColors.light;
  isDark: boolean;
  onPress: () => void;
}

function ContactButton({ label, icon, accentColor, c, onPress }: ButtonProps) {
  const [pressed, setPressed] = React.useState(false);
  return (
    <Pressable
      cssInterop={false}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 15,
        paddingHorizontal: 20,
        borderRadius: 18,
        backgroundColor: c.base,
        shadowColor: c.shadowDark,
        shadowOffset: pressed ? { width: 1, height: 1 } : { width: 4, height: 4 },
        shadowOpacity: pressed ? 0.35 : 0.55,
        shadowRadius: pressed ? 3 : 8,
        opacity: pressed ? 0.88 : 1,
        borderWidth: 1,
        borderColor: `${accentColor}18`,
      }}
    >
      {/* Icon pill */}
      <View style={{
        width: 40, height: 40, borderRadius: 12,
        backgroundColor: `${accentColor}14`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </View>

      <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: c.text }}>
        {label}
      </Text>

      {/* Chevron hint */}
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: `${accentColor}12`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{ fontSize: 14, color: accentColor, fontWeight: '800' }}>›</Text>
      </View>
    </Pressable>
  );
}
