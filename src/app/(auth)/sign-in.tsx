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

    // ── Release-safe auth diagnostics ─────────────────────────────────────────
    // Never logs password, tokens, keys, or full user data.
    const _t0 = Date.now();
    const _ts = () => `t=${Date.now() - _t0}ms`;
    const _authTag = '[AUTH]';
    const _authErr = '[AUTH_ERROR]';
    const _platform = process.env.EXPO_OS ?? 'unknown';
    const _isPhone = /^[\+0-9\s\-\.\(\)]{4,}$/.test(trimmed) && !/^[^@\s]+@[^@\s]+/.test(trimmed);
    const _loginMethod = _isPhone ? 'phone' : 'email';
    console.log(_authTag, `login started | platform=${_platform} method=${_loginMethod} ${_ts()}`);

    // ── SUPABASE client validation ─────────────────────────────────────────────
    // Verify URL and anon key are present and well-formed at runtime.
    // This catches misconfigured EAS environment variable injection on iOS.
    const _supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    const _anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
    let _urlValid = false;
    let _urlHost = '(none)';
    try {
      const parsed = new URL(_supabaseUrl);
      _urlValid = parsed.protocol === 'https:' && parsed.hostname.length > 0;
      _urlHost = parsed.hostname;
    } catch { _urlValid = false; }
    console.log('[SUPABASE]', `URL_HOST=${_urlHost} URL_VALID=${_urlValid} ANON_KEY_PRESENT=${_anonKey.length > 0} ${_ts()}`);

    if (!_urlValid || !_anonKey) {
      console.log(_authErr, `stage=supabase_config URL_VALID=${_urlValid} ANON_KEY_PRESENT=${_anonKey.length > 0}`);
      setError('App configuration error. Please reinstall or contact support.');
      setLoading(false);
      return;
    }

    // ── NETTEST: basic HTTPS connectivity probe (no credentials) ───────────────
    // Tests whether iOS can reach the Supabase server at all before auth.
    // If this fails, the problem is networking/ATS/TLS — not credentials.
    const _netTestUrl = `${_supabaseUrl}/rest/v1/?apikey=${_anonKey}`;
    console.log('[NETTEST]', `START host=${_urlHost} ${_ts()}`);
    try {
      const _ntController = new AbortController();
      const _ntTimeout = setTimeout(() => _ntController.abort(), 10000);
      const _ntRes = await globalThis.fetch(_netTestUrl, {
        method: 'GET',
        signal: _ntController.signal,
      });
      clearTimeout(_ntTimeout);
      console.log('[NETTEST]', `END status=${_ntRes.status} ${_ts()}`);
    } catch (_ntErr: unknown) {
      const _ntMsg = (_ntErr instanceof Error) ? _ntErr.message : String(_ntErr);
      const _ntName = (_ntErr instanceof Error) ? _ntErr.name : 'Error';
      console.log('[NETTEST_ERROR]', `name=${_ntName} message=${_ntMsg} ${_ts()}`);
      // Network is unreachable — surface a clear message immediately.
      // No point attempting auth if the server is not reachable.
      setError(`Network error: cannot reach server. Please check your connection.\n(${_ntMsg})`);
      setLoading(false);
      return;
    }

    try {
      // Step 1: Run security checks BEFORE creating any session
      const installationId = await getInstallationId();
      console.log(_authTag, `security check START ${_ts()}`);
      const _secStart = Date.now();
      const secResult = await check(installationId);
      console.log(_authTag, `security check END elapsed=${Date.now()-_secStart}ms blocksLogin=${secResult.blocksLogin} riskScore=${secResult.riskScore} ${_ts()}`);

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
      console.log(_authTag, `account lookup START method=${_loginMethod} ${_ts()}`);
      const _lookupStart = Date.now();
      const email = await resolveEmailFromIdentifier(trimmed);
      console.log(_authTag, `account lookup END elapsed=${Date.now()-_lookupStart}ms found=${!!email} ${_ts()}`);
      if (!email) {
        console.log(_authErr, `stage=account_lookup method=${_loginMethod} result=not_found ${_ts()}`);
        setError('No account found for this email or phone number.');
        setLoading(false);
        return;
      }

      // Step 3: PRE-LOGIN device check — BEFORE creating any Supabase session
      console.log(_authTag, `device pre-check START ${_ts()}`);
      const { data: checkData, error: checkError } = await supabase
        .rpc('pre_login_device_check', {
          p_email: email,
          p_installation_id: installationId,
        });

      if (checkError) {
        console.warn(_authErr, `stage=device_precheck name=${checkError.name ?? 'unknown'} message=${checkError.message} ${_ts()}`);
        // Non-fatal: allow login attempt if the check itself fails (network issue, etc.)
      } else if (checkData && checkData.allowed === false) {
        const reason: string = checkData.reason ??
          'This account is already active on another authorized device.';
        console.warn(_authErr, `stage=device_precheck result=denied reason=${reason} ${_ts()}`);
        setError(reason);
        setLoading(false);
        return;
      }

      // Step 4: Create auth session (only after device check passes)
      console.log(_authTag, `signInWithPassword START host=${_urlHost} ${_ts()}`);
      const signInStart = Date.now();
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      const signInMs = Date.now() - signInStart;

      if (authError) {
        console.log(_authErr, `stage=supabase_signin name=${authError.name ?? 'AuthError'} status=${authError.status ?? 0} message=${authError.message} elapsed=${signInMs}ms ${_ts()}`);
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

      console.log(_authTag, `signInWithPassword END session=${!!data.session} elapsed=${signInMs}ms ${_ts()}`);

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
      }

      // Step 6: Show security warning if threats detected but login is allowed
      console.log(_authTag, `navigation START hasWarnings=${secResult.hasWarnings} ${_ts()}`);
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
      const errMsg = (e as Error)?.message ?? 'Sign-in failed. Please try again.';
      const errName = (e as Error)?.name ?? 'Error';
      const firstStackLine = ((e as Error)?.stack ?? '')
        .split('\n')
        .find(l => l.includes('.tsx') || l.includes('.ts') || l.includes('.js'))
        ?.trim() ?? '';
      console.log(_authErr, `stage=unhandled name=${errName} message=${errMsg} ${_ts()}${firstStackLine ? ' stack=' + firstStackLine : ''}`);

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
