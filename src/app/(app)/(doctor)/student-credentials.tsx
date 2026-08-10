/**
 * Student Credentials — shown after doctor successfully creates a student account.
 * Displays: student info, temp password, assigned course (if any), activation method.
 * Actions: Copy Credentials, Share, Done (returns to students list).
 */
/**
 * Student Credentials — shown after doctor successfully creates a student account.
 *
 * Smart login display (v69):
 *  - phone-only  → shows "Login Method: Phone Number" — NEVER exposes internal email
 *  - email-only  → shows "Login Method: Email"
 *  - both        → shows both Phone (primary) + Email (alternative)
 *
 * Copy / Share uses the VISIBLE identifier, not the internal email.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, Share, useColorScheme } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CheckCircle, Copy, Share2, ArrowRight,
  User, Mail, Phone, Lock, BookOpen, CreditCard, Ticket,
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { neuColors, useLayout, neuFlatStyle, safeBottom } from '@/lib/neu';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/Toast';

type LoginType = 'email' | 'phone' | 'both';

export default function StudentCredentialsScreen() {
  const scheme = useColorScheme();
  const layout = useLayout();
  const insets = layout.insets;
  const isDark = scheme === 'dark';
  const c    = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const router = useRouter();
  const { showToast } = useToast();

  const {
    full_name,
    email,
    phone,
    login_type,
    temp_password,
    course_name,
    activation_method,
    remaining_credits,
  } = useLocalSearchParams<{
    full_name: string;
    email?: string;
    phone?: string;
    login_type?: string;
    temp_password: string;
    course_name?: string;
    activation_method?: string;
    remaining_credits?: string;
  }>();

  const loginType: LoginType =
    (login_type as LoginType | undefined) ??
    (email && !email.includes('@medacademy.internal') ? 'email' : 'phone');

  // The visible login identifier — NEVER the internal email
  const visibleLogin = loginType === 'phone' ? (phone ?? '')
                     : loginType === 'email' ? (email ?? '')
                     : (phone ?? '');  // 'both': phone is primary

  // Login method label
  const loginMethodLabel = loginType === 'phone' ? 'Phone Number'
                         : loginType === 'email' ? 'Email'
                         : 'Phone Number';   // primary for 'both'

  // ── Build clipboard / share text using VISIBLE identifiers only ─────────────
  const buildCredText = () => {
    const lines = ['── Student Account Created ──', `Name:     ${full_name ?? ''}`];

    if (loginType === 'phone' || loginType === 'both') {
      lines.push(`Phone:    ${phone ?? ''}`);
    }
    if (loginType === 'email' || loginType === 'both') {
      lines.push(`Email:    ${email ?? ''}`);
    }
    lines.push(`Password: ${temp_password ?? ''}`);

    if (course_name) lines.push(`Course:   ${course_name}`);
    if (activation_method && activation_method !== 'account_only') {
      lines.push(`Method:   ${activation_method === 'credits' ? 'Doctor Credits' : 'Activation Code'}`);
    }
    if (remaining_credits && activation_method === 'credits') {
      lines.push(`Remaining Credits: ${remaining_credits}`);
    }
    lines.push('─────────────────────────────');
    lines.push('⚠️  Student must change password on first login.');
    return lines.join('\n');
  };

  const handleCopy = async () => {
    try {
      if (process.env.EXPO_OS === 'web') {
        await navigator.clipboard.writeText(buildCredText());
      } else {
        await Clipboard.setStringAsync(buildCredText());
      }
      showToast({ type: 'success', message: 'Credentials copied to clipboard.' });
    } catch {
      showToast({ type: 'error', message: 'Copy not supported on this device.' });
    }
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: buildCredText(), title: 'Student Credentials' });
    } catch { /* user dismissed */ }
  };

  const handleDone = () => { if (router.canGoBack()) router.back(); };

  const methodLabel =
    activation_method === 'credits' ? 'Doctor Credits'
    : activation_method === 'code'  ? 'Activation Code'
    : 'Account Only';

  // ── Credential rows ─────────────────────────────────────────────────────────
  type CredRow = [React.ComponentType<{ size: number; color: string }>, string, string];

  const rows: CredRow[] = [
    [User, 'Name', full_name ?? ''],
  ];

  // Login method block — smart display, never show internal email
  if (loginType === 'phone') {
    rows.push([Phone, 'Login Method', 'Phone Number']);
    rows.push([Phone, 'Phone Number', phone ?? '']);
  } else if (loginType === 'email') {
    rows.push([Mail, 'Login Method', 'Email']);
    rows.push([Mail, 'Email', email ?? '']);
  } else {
    // both
    rows.push([Phone, 'Primary Login', `Phone: ${phone ?? ''}`]);
    rows.push([Mail,  'Alt Login',     `Email: ${email ?? ''}`]);
  }

  rows.push([Lock, 'Temp Password', temp_password ?? '']);

  if (course_name) rows.push([BookOpen, 'Course', course_name]);
  if (activation_method && activation_method !== 'account_only') {
    rows.push([activation_method === 'credits' ? CreditCard : Ticket, 'Method', methodLabel]);
  }
  if (activation_method === 'credits' && remaining_credits) {
    rows.push([CreditCard, 'Remaining Credits', `${remaining_credits} Credits`]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>
        <PageHeader title="Student Created" onBack={handleDone} />

        {/* Success banner */}
        <View style={[flat, { borderRadius: 20, padding: 24, alignItems: 'center', gap: 12 }]}>
          <CheckCircle size={56} color="#22C55E" />
          <Text style={{ fontSize: 22, fontWeight: '800', color: c.text }}>
            Student Created Successfully
          </Text>
          <Text style={{ fontSize: 14, color: `${c.text}88`, textAlign: 'center' }}>
            The student can now log in with these credentials.{'\n'}
            They will be required to change their password on first login.
          </Text>
        </View>

        {/* Login method highlight pill */}
        <View style={[flat, {
          borderRadius: 14, padding: 14,
          flexDirection: 'row', alignItems: 'center', gap: 10,
        }]}>
          {loginType === 'phone' || loginType === 'both'
            ? <Phone size={20} color={c.primary} />
            : <Mail  size={20} color={c.primary} />}
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, color: `${c.text}66` }}>Login Method</Text>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>
              {loginMethodLabel}
            </Text>
            <Text style={{ fontSize: 14, color: c.primary, fontWeight: '600', marginTop: 2 }} selectable>
              {visibleLogin}
            </Text>
          </View>
        </View>

        {/* Credentials card */}
        <NeuCard>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 16 }}>
            Account Details
          </Text>
          {rows.map(([Icon, label, value]) => (
            <View key={label} style={{
              flexDirection: 'row', alignItems: 'center', gap: 12,
              paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}12`,
            }}>
              <View style={[flat, {
                width: 36, height: 36, borderRadius: 10,
                alignItems: 'center', justifyContent: 'center',
              }]}>
                <Icon size={18} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: `${c.text}66` }}>{label}</Text>
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }} selectable>
                  {value}
                </Text>
              </View>
            </View>
          ))}
        </NeuCard>

        {/* Password notice */}
        <View style={[flat, { borderRadius: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }]}>
          <Lock size={18} color="#F59E0B" style={{ marginTop: 2 }} />
          <Text style={{ flex: 1, fontSize: 13, color: c.text }}>
            <Text style={{ fontWeight: '700' }}>Important: </Text>
            Share these credentials securely. The student must change their password on first login.
          </Text>
        </View>

        {/* Actions */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Pressable onPress={handleCopy}
            style={[flat, { flex: 1, borderRadius: 16, padding: 14, alignItems: 'center', gap: 6 }]}>
            <Copy size={22} color={c.primary} />
            <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Copy</Text>
          </Pressable>
          <Pressable onPress={handleShare}
            style={[flat, { flex: 1, borderRadius: 16, padding: 14, alignItems: 'center', gap: 6 }]}>
            <Share2 size={22} color={c.primary} />
            <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Share</Text>
          </Pressable>
        </View>

        <NeuButton label="Done" onPress={handleDone} icon={<ArrowRight size={16} color="#fff" />} />
      </ScrollView>
    </View>
  );
}
