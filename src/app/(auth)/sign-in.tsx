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

  // ── TEMP-DIAG (iOS auth investigation — remove after root cause confirmed) ──
  // Logs every boundary of the sign-in chain with platform + timings + full error
  // detail (name/message/code/status/cause/first stack line) so the REAL runtime
  // failure on iOS is captured instead of a generic message.
  const _diagT0 = Date.now();
  const _diag = (stage: string, info?: Record<string, unknown>) => {
    console.log('[SIGNIN-DIAG]', JSON.stringify({
      platform: process.env.EXPO_OS ?? 'unknown',
      stage,
      elapsedMs: Date.now() - _diagT0,
      ...(info ?? {}),
    }));
  };
  const _diagErr = (stage: string, err: unknown) => {
    const e = (err ?? {}) as { name?: string; message?: string; code?: string; status?: number; cause?: unknown };
    const stack0 = err instanceof Error ? (err.stack?.split('\n')[1]?.trim() ?? 'n/a') : 'n/a';
    console.log('[SIGNIN-DIAG-ERR]', JSON.stringify({
      platform: process.env.EXPO_OS ?? 'unknown',
      stage,
      elapsedMs: Date.now() - _diagT0,
      name:    e?.name    ?? 'n/a',
      message: e?.message ?? String(err ?? 'n/a'),
      code:    e?.code    ?? 'n/a',
      status:  e?.status  ?? 'n/a',
      cause:   e?.cause instanceof Error ? `${e.cause.name}: ${e.cause.message}` : String(e?.cause ?? 'n/a'),
      stack0,
    }));
  };

  const handleSignIn = async () => {
    const trimmed = identifier.trim();
    if (!trimmed || !password) { setError('Email or phone number and password are required.'); return; }
    setLoading(true);
    setError('');
    _diag('start', { urlPresent: !!process.env.EXPO_PUBLIC_SUPABASE_URL, anonPresent: !!process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY });

    try {
      // Step 1: Run security checks BEFORE creating any session
      _diag('install-id-before');
      const installationId = await getInstallationId();
      _diag('install-id-after', { hasId: !!installationId });
      _diag('security-before');
      const secResult = await check(installationId);
      _diag('security-after', { blocksLogin: secResult.blocksLogin, riskScore: secResult.riskScore });

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
      _diag('lookup-before');
      const email = await resolveEmailFromIdentifier(trimmed);
      _diag('lookup-after', { found: !!email });
      if (!email) {
        setError('No account found for this email or phone number.');
        setLoading(false);
        return;
      }

      // Step 3: PRE-LOGIN device check — BEFORE creating any Supabase session
      _diag('precheck-before');
      const { data: checkData, error: checkError } = await supabase
        .rpc('pre_login_device_check', {
          p_email: email,
          p_installation_id: installationId,
        });
      _diag('precheck-after', { allowed: checkData?.allowed ?? null, checkErr: checkError?.message ?? null });

      if (checkError) {
        // Non-fatal: allow login attempt if the check itself fails (network issue, etc.)
      } else if (checkData && checkData.allowed === false) {
        const reason: string = checkData.reason ??
          'This account is already active on another authorized device.';
        setError(reason);
        setLoading(false);
        return;
      }

      // Step 4: Create auth session (only after device check passes).
      // Compute the device metadata ONCE here so the same fingerprint is sent
      // at login and reused for the post-login device registration below.
      const deviceMeta = {
        installation_id:   installationId,
        device_fingerprint: buildFingerprint(),
        device_name:       [Device.modelName, Device.osName].filter(Boolean).join(' ') || 'Unknown Device',
        platform:          process.env.EXPO_OS ?? 'unknown',
        device_model:      Device.modelName    ?? undefined,
        os:                Device.osName       ?? undefined,
        os_version:        Device.osVersion    ?? undefined,
        app_version:       Constants.expoConfig?.version ?? undefined,
        manufacturer:      Device.manufacturer ?? undefined,
      };
      _diag('signin-before', { email });
      const signInStart = Date.now();
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password, ...deviceMeta });
      const signInMs = Date.now() - signInStart;
      _diag('signin-after', { elapsedMs: signInMs, hasSession: !!data?.session });
      if (authError) _diagErr('signin-error', authError);

      if (authError) {
        const msg = authError.message ?? '';

        // Distinguish network failures from credential failures.
        // On iOS JSC a network-layer failure produces "Network request failed"
        // (from whatwg-fetch / NSURLSession) — this is NOT a bad-credentials error.
        const isNetworkFailure =
          msg.toLowerCase().includes('network request failed') ||
          msg.toLowerCase().includes('failed to fetch') ||
          msg.toLowerCase().includes('network') ||
          msg.toLowerCase().includes('timeout') ||
          (authError.status === undefined || authError.status === 0);

        if (isNetworkFailure && signInMs > 5000) {
          // Long delay + network error = connection timeout, not bad password.
          setError(`Network error: request timed out after ${Math.round(signInMs/1000)}s. Check your connection and try again.`);
          setLoading(false);
          return;
        }
        if (isNetworkFailure) {
          setError('Network error: could not connect to the server. Please check your connection.');
          setLoading(false);
          return;
        }

        if (/banned/i.test(msg)) {
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
        } else if (/invalid.*login|invalid.*credential|invalid.*password|wrong.*password/i.test(msg)) {
          setError('Incorrect email or password. Please try again.');
        } else {
          setError(msg);
        }
        setLoading(false);
        return;
      }

      // Step 5: Register / update device record (now we have a valid session)
      // Reuse the exact same fingerprint/metadata that was sent at login.
      const { platform, device_fingerprint: fingerprint, device_name: deviceName } = deviceMeta;

      _diag('register-device-before');
      try {
        const result = await registerDevice({
          fingerprint,
          installation_id: installationId,
          device_name:     deviceName,
          platform,
          device_model:    deviceMeta.device_model,
          os:              deviceMeta.os,
          os_version:      deviceMeta.os_version,
          app_version:     deviceMeta.app_version,
          manufacturer:    deviceMeta.manufacturer,
        });

        if (result?.error) {
          if (result.limit_reached) {
            setError(result.error as string);
            await supabase.auth.signOut();
            setLoading(false);
            return;
          }
          if (result.device_blocked) {
            console.error('[SignIn] BLOCKED DEVICE — signing out immediately. device_id:', result.device_id);
            setError(result.error as string);
            await supabase.auth.signOut();
            setLoading(false);
            return;
          }
          console.error('[SignIn] registerDevice returned error (non-limit):', result.error);
          setError(`Device registration warning: ${result.error}`);
        } else {
          await storeDeviceFingerprint(fingerprint);
          registerPushToken(installationId).catch(() => {});
        }
      } catch (devErr: unknown) {
        const msg = devErr instanceof Error ? devErr.message : String(devErr);
        console.error('[SignIn] registerDevice EXCEPTION (device not registered!):', msg, devErr);
        _diagErr('register-device-exception', devErr);
      }
      _diag('register-device-after');

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
      _diagErr('handleSignIn-catch', e);
      const errMsg = (e as Error)?.message ?? 'Sign-in failed. Please try again.';

      // Surface network failures with a clear, actionable message.
      const msgLower = errMsg.toLowerCase();
      if (
        msgLower.includes('network request failed') ||
        msgLower.includes('failed to fetch') ||
        msgLower.includes('network')
      ) {
        setError('Network error: could not connect to the server. Please check your connection and try again.');
      } else {
        setError(errMsg);
      }
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
