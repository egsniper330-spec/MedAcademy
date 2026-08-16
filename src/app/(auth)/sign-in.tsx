import { useState } from 'react';
import {
  View, Text, ScrollView, KeyboardAvoidingView,
  Pressable, useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import { Mail, Phone, Lock, Eye, EyeOff } from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors, useLayout, safeTop, safeBottom } from '@/lib/neu';
import { detectIdentifierType, resolveEmailFromIdentifier } from '@/lib/identifier';
import { registerDevice } from '@/lib/api';
import { getInstallationId, storeDeviceFingerprint } from '@/lib/installationId';
import { registerPushToken } from '@/lib/pushTokenService';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { useSecurity } from '@/lib/SecurityContext';
import { NeuInputRow } from '@/components/NeuInputRow';

// Build a stable device fingerprint from hardware identifiers (metadata only — not for enforcement)
function buildFingerprint(): string {
  const parts = [
    Device.modelId ?? Device.modelName ?? '',
    Device.osInternalBuildId ?? '',
    Device.osBuildId ?? '',
    Constants.sessionId ?? '',
  ].filter(Boolean);
  let h = 0;
  const str = parts.join('::');
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
  return 'fp_' + Math.abs(h).toString(36) + '_' + (str.length).toString(36);
}

export default function SignIn() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const layout = useLayout();
  const insets = layout.insets;
  const { check } = useSecurity();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Derive identifier type for icon display ONLY — never use it to change keyboardType,
  // because switching keyboardType on a live TextInput forces a native remount and
  // resets the cursor position to 0 (the cursor-jump bug).
  const identifierType = detectIdentifierType(identifier);
  const IdentIcon = identifierType === 'phone' ? Phone : Mail;

  const handleSignIn = async () => {
    const trimmed = identifier.trim();
    if (!trimmed || !password) { setError('Email or phone number and password are required.'); return; }
    setLoading(true);
    setError('');

    try {
      // Step 1: Run security checks BEFORE creating any session
      const installationId = await getInstallationId();
      const secResult = await check(installationId);

      // If policy blocks login, show security warning screen immediately
      if (secResult.blocksLogin) {
        router.push({
          pathname: '/(auth)/security-warning' as RelativePathString,
          params: {
            threats:     JSON.stringify(secResult.threats),
            riskScore:   String(secResult.riskScore),
            blocksLogin: 'true',
            redirect:    '',
          },
        });
        setLoading(false);
        return;
      }

      // Step 2: Resolve to email
      const email = await resolveEmailFromIdentifier(trimmed);
      if (!email) {
        setError('No account found for this email or phone number.');
        setLoading(false);
        return;
      }

      // Step 3: PRE-LOGIN device check — BEFORE creating any Supabase session
      // Uses the anon key; no JWT needed. Blocks if device limit exceeded.
      const { data: checkData, error: checkError } = await supabase
        .rpc('pre_login_device_check', {
          p_email: email,
          p_installation_id: installationId,
        });

      if (checkError) {
        console.warn('[SignIn] pre_login_device_check RPC error:', checkError.message);
        // Non-fatal: allow login attempt if the check itself fails (network issue, etc.)
      } else if (checkData && checkData.allowed === false) {
        // Map every known rejection reason to a clear user-facing message.
        // device_blocked is caught here (pre-session) so the auth session is NEVER created.
        const reason: string = checkData.reason ??
          'This account is already active on another authorized device.';
        console.warn('[SignIn] pre_login_device_check denied:', { reason, checkData });
        setError(reason);
        setLoading(false);
        return; // ← session is NEVER created
      }

      // Step 4: Create auth session (only after device check passes)
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });

      if (authError) {
        // Safety-net: if Supabase Auth returns "User is banned." it means either:
        //   (a) The account is blocked by an admin (ban_duration set by block-user EF).
        //   (b) The auth.users row has ban_duration but the profile was already deleted.
        // For (a) — pre_login_device_check should have already blocked this with a
        // friendly message; but in case the pre-check is stale, show a clear message.
        // For (b) — never surface "banned" for a deleted account.
        const msg = authError.message ?? '';
        if (/banned/i.test(msg)) {
          // Check profile status to distinguish block vs. deleted
          const { data: profileCheck } = await supabase
            .from('profiles')
            .select('status')
            .eq('email', email.toLowerCase().trim())
            .maybeSingle();
          if (profileCheck?.status === 'blocked') {
            setError('Your account has been blocked. Please contact the administrator.');
          } else {
            setError('No account found for this email or phone number.');
          }
        } else {
          setError(msg);
        }
        setLoading(false);
        return;
      }

      // Step 5: Register / update device record (now we have a valid session)
      const platform    = process.env.EXPO_OS ?? 'unknown';
      const fingerprint = buildFingerprint();
      const deviceName  = [Device.modelName, Device.osName].filter(Boolean).join(' ') || 'Unknown Device';

      try {
        const result = await registerDevice({
          fingerprint,
          installation_id: installationId,
          device_name:     deviceName,
          platform,
          device_model:    Device.modelName    ?? undefined,
          os:              Device.osName       ?? undefined,
          os_version:      Device.osVersion    ?? undefined,
          app_version:     Constants.expoConfig?.version ?? undefined,
          manufacturer:    Device.manufacturer ?? undefined,
        });

        if (result?.error) {
          // limit_reached means another device is active — block the login
          if (result.limit_reached) {
            setError(result.error as string);
            await supabase.auth.signOut();
            setLoading(false);
            return;
          }
          // SECURITY: device_blocked means admin has blocked this specific device.
          // Must sign out immediately — never let a blocked device stay logged in.
          if (result.device_blocked) {
            console.error('[SignIn] BLOCKED DEVICE — signing out immediately. device_id:', result.device_id);
            setError(result.error as string);
            await supabase.auth.signOut();
            setLoading(false);
            return;
          }
          // Any other error from the EF — surface it, don't swallow
          console.error('[SignIn] registerDevice returned error (non-limit):', result.error);
          setError(`Device registration warning: ${result.error}`);
        } else {
          // Persist fingerprint so ctx.tsx can retrieve it for revocation checks.
          await storeDeviceFingerprint(fingerprint);
          // Register / refresh push token after successful device registration.
          // Fire-and-forget: push token failure must never block the login flow.
          registerPushToken(installationId).catch(() => {});
        }
      } catch (devErr: unknown) {
        // IMPORTANT: log the FULL error — do not silently swallow.
        // Previously this catch block was suppressing the real failure (auth.uid()=NULL).
        const msg = devErr instanceof Error ? devErr.message : String(devErr);
        console.error('[SignIn] registerDevice EXCEPTION (device not registered!):', msg, devErr);
        // Non-fatal for login flow — user gets in, but device won't show in Device Management.
        // This should NOT happen after the register_device_for_user fix.
      }

      // Step 6: Show security warning if threats detected but login is allowed
      if (secResult.hasWarnings && secResult.threats.length > 0) {
        const userRole = data.user?.user_metadata?.role ?? 'student';
        const dashboardPath = `/(app)/(${userRole === 'super_admin' ? 'superadmin' : userRole})/dashboard` as RelativePathString;
        router.push({
          pathname: '/(auth)/security-warning' as RelativePathString,
          params: {
            threats:     JSON.stringify(secResult.threats),
            riskScore:   String(secResult.riskScore),
            blocksLogin: 'false',
            redirect:    dashboardPath,
          },
        });
        setLoading(false);
        return;
      }

      // SessionProvider + layout handle routing by role.
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Sign-in failed. Please try again.');
    }
    setLoading(false);
  };



  // Adaptive label style — replaces hardcoded fontSize: 11, marginBottom: 7
  const fieldLabelStyle = {
    fontSize: layout.captionSize,
    fontWeight: '700' as const,
    color: c.text,
    opacity: 0.5,
    marginBottom: layout.pad.xs,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.9,
  };

  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: c.base }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          // screenPx: fluid horizontal gutter (14–40dp). Replaces hardcoded 24.
          paddingHorizontal: layout.screenPx,
          paddingTop: layout.headerTop,
          paddingBottom: layout.scrollBottom(),
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo + title */}
        <View style={{ alignItems: 'center', marginBottom: layout.pad.xxl }}>
          <BrandLogo variant="auto" size={Math.round(layout.heroIconSize * 0.59)} />
          <Text style={{
            fontSize: layout.titleSize,
            fontWeight: '800',
            color: c.text,
            letterSpacing: -0.3,
            marginTop: layout.pad.sm,
          }}>Welcome Back</Text>
          <Text style={{
            fontSize: layout.captionSize,
            color: c.text,
            opacity: 0.5,
            marginTop: layout.pad.xs,
            textAlign: 'center',
            lineHeight: layout.captionSize * 1.5,
          }}>
            Sign in to your MedAcademy account
          </Text>
        </View>

        {/* Card — padding from adaptive screenPx instead of hardcoded 16/24 */}
        <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx }}>
          {/* Email or Phone */}
          <Text style={fieldLabelStyle}>Email or Phone</Text>
          <NeuInputRow
            c={c}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder="user@gmail.com or 01020xxxxxxx"
            keyboardType="default"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            leftIcon={<IdentIcon size={layout.captionSize + 4} color={c.text} opacity={0.38} />}
            rightElement={identifierType === 'phone' ? (
              <View style={{
                backgroundColor: `${c.primary}18`,
                borderRadius: layout.pad.xs,
                paddingHorizontal: layout.pad.xs + 2,
                paddingVertical: 2,
              }}>
                <Text style={{ fontSize: layout.captionSize - 2, fontWeight: '800', color: c.primary }}>PHONE</Text>
              </View>
            ) : undefined}
          />

          {/* Password */}
          <Text style={fieldLabelStyle}>Password</Text>
          <NeuInputRow
            c={c}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry={!showPwd}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            leftIcon={<Lock size={layout.captionSize + 4} color={c.text} opacity={0.38} />}
            rightElement={
              <Pressable
                onPress={() => setShowPwd(!showPwd)}
                accessibilityLabel={showPwd ? 'Hide password' : 'Show password'}
                accessibilityRole="button"
                style={{ padding: layout.pad.xs }}
              >
                {showPwd
                  ? <EyeOff size={layout.captionSize + 4} color={c.text} opacity={0.38} />
                  : <Eye    size={layout.captionSize + 4} color={c.text} opacity={0.38} />}
              </Pressable>
            }
          />

          {error ? (
            <Text style={{
              color: '#DC2626',
              fontSize: layout.captionSize,
              marginBottom: layout.pad.sm,
              lineHeight: layout.captionSize * 1.5,
            }}>{error}</Text>
          ) : null}

          <NeuButton label="Sign In" onPress={handleSignIn} loading={loading} fullWidth style={{ marginTop: layout.pad.xs }} />
        </NeuCard>

        {/* Register link — gap replaces hardcoded marginTop: 16 */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: layout.pad.lg, gap: layout.pad.xs }}>
          <Text style={{ color: c.text, opacity: 0.5, fontSize: layout.captionSize }}>{"Don't have an account?"}</Text>
          <Pressable onPress={() => router.push('/(auth)/sign-up')} accessibilityLabel="Register a new account" accessibilityRole="button">
            <Text style={{ color: c.primary, fontWeight: '700', fontSize: layout.captionSize }}>Register</Text>
          </Pressable>
        </View>

        {/* Bottom breathing room */}
        <View style={{ height: layout.pad.lg }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
