/**
 * Force Password Change — shown on first login when force_password_change=true.
 * Student enters their current temp password, picks a new password, confirms it.
 * On success: clears the flag, logs audit event, redirects to student dashboard.
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, ScrollView, KeyboardAvoidingView,
  Pressable, useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import { Lock, Eye, EyeOff, ShieldCheck } from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { neuColors, neuFlatStyle, useLayout, safeBottom } from '@/lib/neu';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { useProfileStore } from '@/lib/store';
import { friendlyError } from '@/lib/validation';
import { NeuInputRow } from '@/components/NeuInputRow';

export default function ForcePasswordChangeScreen() {
  const scheme = useColorScheme();
  const layout = useLayout();
  const insets = layout.insets;
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const router = useRouter();
  const { showToast } = useToast();
  const { profile, setProfile } = useProfileStore();

  const [currentPass,  setCurrentPass]  = useState('');
  const [newPass,      setNewPass]      = useState('');
  const [confirmPass,  setConfirmPass]  = useState('');
  const [showCurrent,  setShowCurrent]  = useState(false);
  const [showNew,      setShowNew]      = useState(false);
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');

  const validate = (): string | null => {
    if (!currentPass) return 'Please enter your current temporary password.';
    if (!newPass || newPass.length < 8) return 'New password must be at least 8 characters.';
    if (newPass !== confirmPass) return 'New passwords do not match.';
    if (newPass === currentPass) return 'New password must be different from your temporary password.';
    return null;
  };

  const handleChange = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setLoading(true); setError('');
    try {
      // 1. Re-authenticate to verify current temp password
      const userEmail = profile?.email;
      if (!userEmail) throw new Error('Session error. Please log in again.');

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: currentPass,
      });
      if (signInErr) throw new Error('Incorrect current password. Please try again.');

      // 2. Update to new password
      const { error: updateErr } = await supabase.auth.updateUser({ password: newPass });
      if (updateErr) throw updateErr;

      // 3. Clear force_password_change flag on profile
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ force_password_change: false })
        .eq('id', profile?.id ?? '');
      if (profileErr) console.warn('[ForcePasswordChange] Failed to clear flag:', profileErr);

      // 4. Write audit log (non-blocking — fire and forget)
      void supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: 'password_changed_first_login',
        resource_type: 'profile',
        resource_id: profile?.id,
        details: { method: 'force_password_change_screen' },
      });

      // 5. Update local profile so layout doesn't redirect again
      if (profile) setProfile({ ...profile, force_password_change: false } as any);

      showToast({ type: 'success', message: 'Password changed successfully! Welcome.' });

      // 6. Navigate to student dashboard
      router.replace('/(app)/(student)/dashboard' as RelativePathString);
    } catch (e) {
      setError(friendlyError(e, 'Password change failed. Please try again.'));
    }
    setLoading(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: layout.screenPx,
            paddingTop: layout.pad.xxl,
            paddingBottom: layout.scrollBottom(),
            gap: layout.pad.lg,
            justifyContent: 'center',
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={{ alignItems: 'center', gap: layout.pad.md, marginBottom: layout.pad.sm }}>
            <View style={[flat, {
              width: layout.heroIconSize,
              height: layout.heroIconSize,
              borderRadius: layout.heroIconRadius,
              alignItems: 'center', justifyContent: 'center',
            }]}>
              <ShieldCheck size={Math.round(layout.heroIconSize * 0.5)} color={c.primary} />
            </View>
            <Text style={{ fontSize: layout.titleSize, fontWeight: '800', color: c.text, textAlign: 'center' }}>
              Change Your Password
            </Text>
            <Text style={{ fontSize: layout.bodySize, color: `${c.text}88`, textAlign: 'center', lineHeight: layout.bodySize * 1.6 }}>
              Your account was created with a temporary password.{'\n'}
              Please set a new password to continue.
            </Text>
          </View>

          <NeuCard>
            <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text, marginBottom: layout.pad.lg }}>
              Set New Password
            </Text>
            <View style={{ gap: layout.pad.md }}>
              <NeuInputRow c={c} placeholder="Current Temporary Password" secureTextEntry={!showCurrent}
                value={currentPass} onChangeText={setCurrentPass} autoCapitalize="none"
                containerStyle={{ marginBottom: 0 }}
                leftIcon={<Lock size={layout.bodySize + 2} color={`${c.text}77`} />}
                rightElement={
                  <Pressable onPress={() => setShowCurrent(p => !p)}>
                    {showCurrent ? <EyeOff size={layout.bodySize + 2} color={`${c.text}55`} /> : <Eye size={layout.bodySize + 2} color={`${c.text}55`} />}
                  </Pressable>
                }
              />
              <NeuInputRow c={c} placeholder="New Password (min 8 characters)" secureTextEntry={!showNew}
                value={newPass} onChangeText={setNewPass} autoCapitalize="none"
                containerStyle={{ marginBottom: 0 }}
                leftIcon={<Lock size={layout.bodySize + 2} color={c.primary} />}
                rightElement={
                  <Pressable onPress={() => setShowNew(p => !p)}>
                    {showNew ? <EyeOff size={layout.bodySize + 2} color={`${c.text}55`} /> : <Eye size={layout.bodySize + 2} color={`${c.text}55`} />}
                  </Pressable>
                }
              />
              <NeuInputRow c={c} placeholder="Confirm New Password" secureTextEntry={!showConfirm}
                value={confirmPass} onChangeText={setConfirmPass} autoCapitalize="none"
                containerStyle={{ marginBottom: 0 }}
                leftIcon={<Lock size={layout.bodySize + 2} color={c.primary} />}
                rightElement={
                  <Pressable onPress={() => setShowConfirm(p => !p)}>
                    {showConfirm ? <EyeOff size={layout.bodySize + 2} color={`${c.text}55`} /> : <Eye size={layout.bodySize + 2} color={`${c.text}55`} />}
                  </Pressable>
                }
              />
            </View>

            {/* Password rules */}
            <View style={{ marginTop: layout.pad.md, gap: layout.pad.xs }}>
              {[
                ['✓', 'At least 8 characters',            newPass.length >= 8],
                ['✓', 'Different from temporary password', newPass !== currentPass && newPass.length > 0],
                ['✓', 'Passwords match',                   newPass === confirmPass && confirmPass.length > 0],
              ].map(([mark, rule, ok]) => (
                <Text key={String(rule)} style={{ fontSize: layout.captionSize, color: ok ? '#22C55E' : `${c.text}55` }}>
                  {ok ? mark : '○'} {String(rule)}
                </Text>
              ))}
            </View>
          </NeuCard>

          {error ? (
            <Text style={{ color: '#EF4444', fontSize: layout.bodySize, textAlign: 'center' }}>{error}</Text>
          ) : null}

          <NeuButton label={loading ? 'Changing Password…' : 'Change Password & Continue'} onPress={handleChange} loading={loading} />

          <Text style={{ fontSize: layout.captionSize, color: `${c.text}55`, textAlign: 'center' }}>
            {"Contact your doctor or administrator if you don't know your temporary password."}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
