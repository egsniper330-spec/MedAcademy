import React, { useState } from 'react';
import {
  View, Text, ScrollView, KeyboardAvoidingView,
  Pressable, useColorScheme, ActivityIndicator, FlatList, Modal, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Mail, Lock, User, Phone, Eye, EyeOff, ChevronDown, Building2, GraduationCap, BookOpen, Search } from 'lucide-react-native';
import { BrandLogo } from '@/components/BrandLogo';
import { backendClient } from '@/client/backendClient';
import { getUniversities, getFaculties, getAcademicLevels } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { normalizePhoneE164 } from '@/lib/identifier';
import { useBranding } from '@/lib/branding';
import { COUNTRIES, DEFAULT_COUNTRY, buildE164, validateNationalNumber, type Country } from '@/lib/phone';
import { NeuInputRow } from '@/components/NeuInputRow';
import { isFeatureEnabled } from '@/lib/featureFlags';
import { t } from '@/lib/i18n';

interface PickerOption { id: string; name: string; }

function SelectPicker({
  label, icon, value, options, onSelect, loading, disabled, placeholder, c, layout,
}: {
  label: string;
  icon: 'university' | 'faculty' | 'level';
  value: PickerOption | null;
  options: PickerOption[];
  onSelect: (o: PickerOption) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder: string;
  c: typeof neuColors.light;
  layout: ReturnType<typeof useLayout>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginBottom: layout.pad.md }}>
      <Text style={{
        fontSize: layout.captionSize,
        fontWeight: '600',
        ...mutedTextStyle(c, 0.55),
        marginBottom: layout.pad.xs,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
      }}>{label}</Text>
      <Pressable
        onPress={() => { if (!disabled && !loading) setOpen(v => !v); }}
        style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: c.base,
          borderRadius: layout.cardRadius / 2,
          paddingHorizontal: layout.pad.lg,
          paddingVertical: layout.pad.md,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 2, height: 2 },
          shadowOpacity: disabled ? 0.2 : 0.6,
          shadowRadius: 5,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {loading
          ? <ActivityIndicator size="small" color={c.primary} style={{ marginRight: layout.pad.sm }} />
          : <View style={{ marginRight: layout.pad.sm }}>
              {icon === 'university' ? <Building2 size={layout.bodySize} color={c.text} opacity={0.4} />
                : icon === 'faculty' ? <GraduationCap size={layout.bodySize} color={c.text} opacity={0.4} />
                : <BookOpen size={layout.bodySize} color={c.text} opacity={0.4} />}
            </View>
        }
        <Text style={{ flex: 1, fontSize: layout.bodySize, color: value ? c.text : `${c.text}55` }}>
          {value?.name ?? placeholder}
        </Text>
        <ChevronDown size={layout.captionSize + 2} color={c.text} opacity={0.4}
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open && (
        <NeuCard radius={layout.cardRadius / 2} style={{ marginTop: layout.pad.xs, padding: layout.pad.xs, maxHeight: 220 }}>
          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {options.length === 0
              ? <Text style={{ ...mutedTextStyle(c, 0.4), fontSize: layout.captionSize, padding: layout.pad.md, textAlign: 'center' }}>{t('signUp.noOptions')}</Text>
              : options.map(opt => (
                <Pressable key={opt.id} onPress={() => { onSelect(opt); setOpen(false); }}
                  style={{
                    paddingHorizontal: layout.pad.lg,
                    paddingVertical: layout.pad.md,
                    borderBottomWidth: 1, borderBottomColor: `${c.text}08`,
                    backgroundColor: value?.id === opt.id ? `${c.primary}12` : 'transparent',
                    borderRadius: layout.pad.sm,
                  }}>
                  <Text style={{ fontSize: layout.bodySize - 1, fontWeight: value?.id === opt.id ? '700' : '400', color: value?.id === opt.id ? c.primary : c.text }}>
                    {opt.name}
                  </Text>
                </Pressable>
              ))
            }
          </ScrollView>
        </NeuCard>
      )}
    </View>
  );
}

// ─── Country Code Picker ──────────────────────────────────────────────────────

function CountryCodePicker({
  value, onChange, c, layout,
}: {
  value: Country;
  onChange: (country: Country) => void;
  c: typeof neuColors.light;
  layout: ReturnType<typeof useLayout>;
}) {
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState('');

  const filtered = searchText.trim()
    ? COUNTRIES.filter(ct =>
        ct.name.toLowerCase().includes(searchText.toLowerCase()) ||
        ct.callingCode.includes(searchText) ||
        ct.iso.toLowerCase().includes(searchText.toLowerCase())
      )
    : COUNTRIES;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: c.base,
          borderRadius: layout.cardRadius / 2,
          paddingHorizontal: layout.pad.md,
          paddingVertical: layout.pad.md,
          marginRight: layout.pad.sm,
          shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
          shadowOpacity: 0.6, shadowRadius: 5,
          // minWidth scales with device: compact needs less, tablet can show more
          minWidth: layout.isTablet ? 110 : layout.isCompact ? 80 : 88,
        }}
      >
        {/* Flag emoji — always 20dp for legibility */}
        <Text style={{ fontSize: 20, marginRight: layout.pad.xs }}>{value.flag}</Text>
        <Text style={{ fontSize: layout.bodySize - 1, fontWeight: '700', color: c.text, marginRight: 2 }}>
          {value.callingCode}
        </Text>
        <ChevronDown size={layout.captionSize} color={c.text} opacity={0.4} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: c.base,
              borderTopLeftRadius: layout.cardRadius,
              borderTopRightRadius: layout.cardRadius,
              maxHeight: '70%',
              padding: layout.cardPx,
            }}
            onPress={() => {/* prevent dismiss */}}
          >
            <Text style={{ fontSize: layout.headingSize, fontWeight: '800', color: c.text, marginBottom: layout.pad.md, textAlign: 'center' }}>
              {t('signUp.selectCountry')}
            </Text>
            {/* Search */}
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: c.base, borderRadius: layout.cardRadius / 2,
              paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm,
              marginBottom: layout.pad.md,
              shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 1 },
              shadowOpacity: 0.4, shadowRadius: 3,
            }}>
              <Search size={layout.captionSize + 2} color={c.text} opacity={0.4} />
              <TextInput
                value={searchText}
                onChangeText={setSearchText}
                placeholder={t('signUp.searchCountry')}
                placeholderTextColor={`${c.text}55`}
                autoCapitalize="none"
                style={{ flex: 1, marginLeft: layout.pad.sm, fontSize: layout.bodySize - 1, color: c.text }}
              />
            </View>

            <FlatList
              data={filtered}
              keyExtractor={item => item.iso}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { onChange(item); setOpen(false); setSearchText(''); }}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingVertical: layout.pad.md, paddingHorizontal: layout.pad.xs,
                    borderBottomWidth: 1, borderBottomColor: `${c.text}08`,
                    backgroundColor: item.iso === value.iso ? `${c.primary}10` : 'transparent',
                    borderRadius: layout.pad.sm,
                  }}
                >
                  {/* Flag always 22dp for list legibility */}
                  <Text style={{ fontSize: 22, marginRight: layout.pad.md }}>{item.flag}</Text>
                  <Text style={{ flex: 1, fontSize: layout.bodySize, color: c.text, fontWeight: item.iso === value.iso ? '700' : '400' }}>
                    {item.name}
                  </Text>
                  <Text style={{ fontSize: layout.bodySize - 1, color: c.primary, fontWeight: '600' }}>
                    {item.callingCode}
                  </Text>
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// ─── Main Registration Screen ─────────────────────────────────────────────────

export default function SignUp() {
  const { branding } = useBranding(); // server-managed display name (fails safe to defaults)
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const layout = useLayout();
  const insets = layout.insets;

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  // Phone: split into country object + national number
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [nationalPhone, setNationalPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Per-field duplicate errors from server-side pre-check
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');

  // Academic selectors (optional)
  const [university, setUniversity] = useState<PickerOption | null>(null);
  const [faculty, setFaculty] = useState<PickerOption | null>(null);
  const [academicLevel, setAcademicLevel] = useState<PickerOption | null>(null);
  const [universities, setUniversities] = useState<PickerOption[]>([]);
  const [faculties, setFaculties] = useState<PickerOption[]>([]);
  const [academicLevels, setAcademicLevels] = useState<PickerOption[]>([]);
  const [loadingUni, setLoadingUni] = useState(false);
  const [loadingFac, setLoadingFac] = useState(false);
  const [loadingLvl, setLoadingLvl] = useState(false);

  const [academicOpen, setAcademicOpen] = useState(false);

  React.useEffect(() => {
    if (!academicOpen) return;
    (async () => {
      try {
        setLoadingUni(true);
        const data = await getUniversities();
        setUniversities(data.map((u: { id: string; name: string }) => ({ id: u.id, name: u.name })));
      } catch { /* ignore */ }
      finally { setLoadingUni(false); }
    })();
  }, [academicOpen]);

  React.useEffect(() => {
    if (!university) return;
    (async () => {
      try {
        setLoadingFac(true);
        const data = await getFaculties(university.id);
        setFaculties(data.map((f: { id: string; name: string }) => ({ id: f.id, name: f.name })));
      } catch { /* ignore */ }
      finally { setLoadingFac(false); }
    })();
  }, [university]);

  // Load academic levels once a faculty is selected
  React.useEffect(() => {
    if (!faculty) { setAcademicLevels([]); return; }
    (async () => {
      try {
        setLoadingLvl(true);
        const data = await getAcademicLevels(faculty.id);
        setAcademicLevels(data.map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })));
      } catch { /* ignore */ }
      finally { setLoadingLvl(false); }
    })();
  }, [faculty]);

  const validate = (): string | null => {
    if (!fullName.trim()) return t('signUp.fullNameRequired');
    if (!email.trim() || !email.includes('@')) return t('signUp.emailRequired');
    if (!nationalPhone.trim()) return t('signUp.phoneRequired');
    const phoneErr = validateNationalNumber(country, nationalPhone.trim());
    if (phoneErr) return t('signUp.invalidPhone', { country: country.name });
    if (password.length < 8) return t('signUp.passwordTooShort');
    if (password !== confirmPassword) return t('signUp.passwordMismatch');
    return null;
  };

  const handleSignUp = async () => {
    // Feature flag: user_registration. UI reflection only — the server refuses
    // the registration itself (403 feature_disabled) when the flag is off.
    if (!isFeatureEnabled('user_registration')) {
      setError(t('signUp.registrationUnavailable'));
      return;
    }
    // Clear all errors on each attempt
    setError('');
    setEmailError('');
    setPhoneError('');

    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setLoading(true);

    // Build canonical E.164 from country + national input
    const e164 = buildE164(country, nationalPhone.trim());
    if (!e164) {
      setError(t('signUp.invalidPhoneGeneric'));
      setLoading(false);
      return;
    }

    // Double-check with our client normalizer (should be identical)
    const normalizedPhone = normalizePhoneE164(e164) ?? e164;

    // ── Server-side uniqueness pre-check ──────────────────────────────────────
    // Calls a SECURITY DEFINER RPC so we can safely check auth.users (email)
    // and profiles (phone_e164) without RLS blocking the lookup.
    // This prevents the raw "Database error saving new user" backend error
    // error from ever reaching the user.
    try {
      const { data: conflicts, error: rpcErr } = await backendClient.rpc(
        'check_registration_conflicts',
        { p_email: email.trim().toLowerCase(), p_phone_e164: normalizedPhone }
      );

      if (rpcErr) {
        // RPC call itself failed — log and continue; signUp will surface any
        // real error below with sanitized messaging
        console.warn('[signUp] conflict check RPC failed:', rpcErr.message);
      } else if (conflicts && conflicts.length > 0) {
        const { email_taken, phone_taken } = conflicts[0] as {
          email_taken: boolean;
          phone_taken: boolean;
        };
        let hasConflict = false;
        if (email_taken) {
          setEmailError(t('signUp.emailTaken'));
          hasConflict = true;
        }
        if (phone_taken) {
          setPhoneError(t('signUp.phoneTaken'));
          hasConflict = true;
        }
        if (hasConflict) {
          setLoading(false);
          return;
        }
      }
    } catch (e) {
      console.warn('[signUp] conflict check exception:', e);
      // Non-fatal: continue to signUp; errors will be sanitized below
    }

    // ── PHP backend registration ──────────────────────────────────────────────
    // Role is always 'student' on self-registration — only admins can promote
    const { error: authError } = await backendClient.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone: normalizedPhone,   // stored as E.164 in user_metadata
          phone_country_code: country.callingCode,
          phone_national: nationalPhone.replace(/\D/g, ''),
          role: 'student',
          university_id: university?.id ?? null,
          faculty_id: faculty?.id ?? null,
          academic_level_id: academicLevel?.id ?? null,
        },
      },
    });

    if (authError) {
      // Sanitize raw backend/database errors — never expose internals
      const msg = authError.message ?? '';
      if (
        msg.toLowerCase().includes('database error') ||
        msg.toLowerCase().includes('unique constraint') ||
        msg.toLowerCase().includes('duplicate key') ||
        msg.toLowerCase().includes('already registered') ||
        msg.toLowerCase().includes('already exists')
      ) {
        // Treat ambiguous DB errors as a duplicate email (most common cause)
        setEmailError(t('signUp.emailTaken'));
      } else if (
        msg.toLowerCase().includes('invalid email') ||
        msg.toLowerCase().includes('email')
      ) {
        setEmailError(t('signUp.validEmail'));
      } else if (msg.toLowerCase().includes('password')) {
        setError(t('signUp.passwordTooShort'));
      } else if (
        msg.toLowerCase().includes('rate limit') ||
        msg.toLowerCase().includes('too many')
      ) {
        setError(t('signUp.tooManyAttempts'));
      } else {
        setError(t('signUp.registrationFailed'));
      }
      setLoading(false);
      return;
    }

    router.replace('/(auth)/sign-in');
    setLoading(false);
  };



  // Adaptive field label — replaces hardcoded fontSize:12, marginBottom:6
  const labelStyle = {
    fontSize: layout.captionSize,
    fontWeight: '600' as const,
    ...mutedTextStyle(c, 0.55),
    marginBottom: layout.pad.xs,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
  };

  // Adaptive icon size for form fields — scales between captionSize+4 and bodySize+2
  const fieldIconSize = layout.bodySize + 2;

  return (
    <KeyboardAvoidingView behavior={undefined} /* keyboard: native inset only */ style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        contentContainerStyle={{
          flexGrow: 1,
          // ── Vertical centring (root-cause fix) ──────────────────────────
          // `flexGrow: 1` alone stretches the content container to the full
          // viewport but leaves its children pinned to the TOP of it. On any
          // device where the form is shorter than the visible area — tall
          // iPhones especially — the whole block therefore sat immediately
          // under the status bar and all the slack collected BELOW it.
          //
          // Sign In has always carried `justifyContent: 'center'` here
          // (see src/app/(auth)/sign-in.tsx); this screen simply never got it,
          // so the two auth screens disagreed. Adding it makes the block
          // centre in the free space while it fits, and once the content is
          // TALLER than the viewport (small screens, landscape, or the keyboard
          // open) the container grows to the content height, centring becomes
          // a no-op, and the normal scroll path takes over — nothing is clipped
          // and the Create Account button always stays reachable.
          justifyContent: 'center',
          // screenPx: fluid horizontal gutter replaces hardcoded padding:24
          paddingHorizontal: layout.screenPx,
          // Top safe area (status bar / notch / camera cutout). Applied as
          // container padding, so centring always happens BELOW it — content
          // can never slide under the status bar, on any device.
          paddingTop: layout.headerTop,
          // Bottom safe area (iPhone home indicator; Android gesture and
          // 3-button navigation). Without this the "Already have an account?"
          // row finished only `pad.xl` (20 dp) from the edge — inside the
          // home-indicator strip on iOS and behind the nav bar on Android —
          // as soon as the content scrolled past the viewport.
          // safeBottom() is the design-system rule for scroll containers, and
          // unlike pageBottom/scrollBottom it deliberately excludes tab-bar
          // clearance (auth screens have no tab bar).
          paddingBottom: safeBottom(insets.bottom),
          gap: layout.pad.sm,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header — sizes from adaptive tokens */}
        <View style={{ alignItems: 'center', marginBottom: layout.pad.xl }}>
          <BrandLogo variant="auto" size={Math.round(layout.heroIconSize * 0.6)} />
          <Text style={{ fontSize: layout.titleSize, fontWeight: '800', color: c.text, marginTop: layout.pad.sm }}>
            {t('signUp.title')}
          </Text>
          <Text style={{ fontSize: layout.bodySize, ...mutedTextStyle(c, 0.55), marginTop: layout.pad.xs }}>
            {t('signUp.subtitle', { app: branding.app_name })}
          </Text>
        </View>

        {/* Form card — radius and padding from adaptive tokens */}
        <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx }}>
          {/* Full Name */}
          <Text style={labelStyle}>{t('signUp.fullName')}</Text>
          <NeuInputRow
            c={c}
            value={fullName}
            onChangeText={setFullName}
            placeholder={t('signUp.fullNamePlaceholder')}
            autoCapitalize="words"
            leftIcon={<User size={fieldIconSize} color={c.text} opacity={0.4} />}
          />

          {/* Email */}
          <Text style={labelStyle}>{t('signUp.email')}</Text>
          <NeuInputRow
            c={c}
            hasError={!!emailError}
            value={email}
            onChangeText={(v) => { setEmail(v); if (emailError) setEmailError(''); }}
            placeholder={t('signUp.emailPlaceholder')}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon={<Mail size={fieldIconSize} color={emailError ? '#DC2626' : c.text} opacity={emailError ? 1 : 0.4} />}
          />
          {emailError ? (
            <Text style={{ color: '#DC2626', fontSize: layout.captionSize, marginBottom: layout.pad.sm, marginTop: -layout.pad.sm }}>{emailError}</Text>
          ) : null}

          {/* Phone */}
          <Text style={labelStyle}>{t('signUp.phone')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: phoneError ? layout.pad.xs : layout.pad.md }}>
            <CountryCodePicker value={country} onChange={(ct) => { setCountry(ct); setNationalPhone(''); setPhoneError(''); }} c={c} layout={layout} />
            <NeuInputRow
              c={c}
              hasError={!!phoneError}
              containerStyle={{ flex: 1, marginBottom: 0 }}
              value={nationalPhone}
              onChangeText={(v) => { setNationalPhone(v); if (phoneError) setPhoneError(''); }}
              placeholder={country.hasLeadingZero ? '01020xxxxxx' : '501234567'}
              keyboardType="phone-pad"
              leftIcon={<Phone size={fieldIconSize - 2} color={phoneError ? '#DC2626' : c.text} opacity={phoneError ? 1 : 0.4} />}
            />
          </View>
          {phoneError ? (
            <Text style={{ color: '#DC2626', fontSize: layout.captionSize, marginBottom: layout.pad.sm, marginLeft: 2 }}>{phoneError}</Text>
          ) : null}
          <Text style={{ fontSize: layout.captionSize - 1, ...mutedTextStyle(c, 0.4), marginTop: phoneError ? 0 : -layout.pad.sm, marginBottom: layout.pad.md, marginLeft: 2 }}>
            {t('signUp.storedAs', { phone: buildE164(country, nationalPhone) ?? `${country.callingCode}…` })}
          </Text>

          {/* Password */}
          <Text style={labelStyle}>{t('signUp.password')}</Text>
          <NeuInputRow
            c={c}
            value={password}
            onChangeText={setPassword}
            placeholder={t('signUp.passwordPlaceholder')}
            secureTextEntry={!showPwd}
            leftIcon={<Lock size={fieldIconSize} color={c.text} opacity={0.4} />}
            rightElement={
              <Pressable
                onPress={() => setShowPwd(!showPwd)}
                accessibilityLabel={showPwd ? t('auth.hidePassword') : t('auth.showPassword')}
                accessibilityRole="button"
                style={{ padding: layout.pad.xs }}
              >
                {showPwd
                  ? <EyeOff size={fieldIconSize} color={c.text} opacity={0.4} />
                  : <Eye    size={fieldIconSize} color={c.text} opacity={0.4} />}
              </Pressable>
            }
          />

          {/* Confirm Password */}
          <Text style={labelStyle}>{t('signUp.confirmPassword')}</Text>
          <NeuInputRow
            c={c}
            hasError={confirmPassword.length > 0 && confirmPassword !== password}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder={t('signUp.confirmPlaceholder')}
            secureTextEntry={!showConfirmPwd}
            leftIcon={<Lock size={fieldIconSize} color={c.text} opacity={0.4} />}
            rightElement={
              <Pressable onPress={() => setShowConfirmPwd(!showConfirmPwd)}>
                {showConfirmPwd
                  ? <EyeOff size={fieldIconSize} color={c.text} opacity={0.4} />
                  : <Eye    size={fieldIconSize} color={c.text} opacity={0.4} />}
              </Pressable>
            }
          />
          {confirmPassword.length > 0 && confirmPassword !== password && (
            <Text style={{ color: '#DC2626', fontSize: layout.captionSize, marginBottom: layout.pad.sm, marginTop: -layout.pad.xs }}>
              {t('signUp.passwordMismatch')}
            </Text>
          )}

          {/* Optional Academic Info toggle */}
          <Pressable
            onPress={() => setAcademicOpen(v => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: layout.pad.md }}
          >
            <Text style={{ fontSize: layout.bodySize - 1, color: c.primary, fontWeight: '600' }}>
              {academicOpen ? `▾ ${t('signUp.hideAcademic')}` : `▸ ${t('signUp.addAcademic')}`} {t('signUp.academicInfo')}
            </Text>
          </Pressable>

          {academicOpen && (
            <>
              <SelectPicker label={t('signUp.university')} icon="university" value={university}    options={universities}   onSelect={(o) => { setUniversity(o); setFaculty(null); }} loading={loadingUni} placeholder={t('signUp.selectUniversity')}  c={c} layout={layout} />
              <SelectPicker label={t('signUp.faculty')} icon="faculty" value={faculty}       options={faculties}      onSelect={setFaculty}      loading={loadingFac} disabled={!university} placeholder={university ? t('signUp.selectFaculty') : t('signUp.selectUniversityFirst')} c={c} layout={layout} />
              <SelectPicker label={t('signUp.academicLevel')} icon="level" value={academicLevel} options={academicLevels} onSelect={setAcademicLevel} loading={loadingLvl} placeholder={t('signUp.selectLevel')} c={c} layout={layout} />
            </>
          )}

          {error ? (
            <Text style={{ color: '#DC2626', fontSize: layout.bodySize - 1, marginBottom: layout.pad.md }}>{error}</Text>
          ) : null}

          <NeuButton
            label={t('signUp.createAccount')}
            onPress={handleSignUp}
            loading={loading}
            disabled={!isFeatureEnabled('user_registration')}
            fullWidth
          />
        </NeuCard>

        {/* Sign-in link */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: layout.pad.xl, marginBottom: layout.pad.xl }}>
          <Text style={{ ...mutedTextStyle(c, 0.55), fontSize: layout.bodySize - 1 }}>{t('signUp.haveAccount')} </Text>
          <Pressable onPress={() => router.push('/(auth)/sign-in')}>
            <Text style={{ color: c.primary, fontWeight: '700', fontSize: layout.bodySize - 1 }}>{t('signUp.signIn')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
