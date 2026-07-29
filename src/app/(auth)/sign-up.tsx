import React, { useState } from 'react';
import {
  View, Text, ScrollView, KeyboardAvoidingView,
  Pressable, useColorScheme, ActivityIndicator, FlatList, Modal, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Mail, Lock, User, Phone, Eye, EyeOff, ChevronDown, Building2, GraduationCap, BookOpen, Search } from 'lucide-react-native';
import { BrandLogo } from '@/components/BrandLogo';
import { supabase } from '@/client/supabase';
import { getUniversities, getFaculties, getAcademicLevels } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';
import { normalizePhoneE164 } from '@/lib/identifier';
import { COUNTRIES, DEFAULT_COUNTRY, buildE164, validateNationalNumber, type Country } from '@/lib/phone';
import { NeuInputRow } from '@/components/NeuInputRow';

interface PickerOption { id: string; name: string; }

function SelectPicker({
  label, value, options, onSelect, loading, disabled, placeholder, c,
}: {
  label: string;
  value: PickerOption | null;
  options: PickerOption[];
  onSelect: (o: PickerOption) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder: string;
  c: typeof neuColors.light;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>{label}</Text>
      <Pressable
        onPress={() => { if (!disabled && !loading) setOpen(v => !v); }}
        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: disabled ? `${c.base}` : c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: disabled ? 0.2 : 0.6, shadowRadius: 5, opacity: disabled ? 0.5 : 1 }}
      >
        {loading
          ? <ActivityIndicator size="small" color={c.primary} style={{ marginRight: 10 }} />
          : <View style={{ marginRight: 10 }}>{label.startsWith('Uni') ? <Building2 size={18} color={c.text} opacity={0.4} /> : label.startsWith('Fac') ? <GraduationCap size={18} color={c.text} opacity={0.4} /> : <BookOpen size={18} color={c.text} opacity={0.4} />}</View>
        }
        <Text style={{ flex: 1, fontSize: 15, color: value ? c.text : `${c.text}55` }}>
          {value?.name ?? placeholder}
        </Text>
        <ChevronDown size={16} color={c.text} opacity={0.4} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open && (
        <NeuCard radius={12} style={{ marginTop: 4, padding: 4, maxHeight: 220 }}>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {options.length === 0
              ? <Text style={{ color: c.text, opacity: 0.4, fontSize: 13, padding: 12, textAlign: 'center' }}>No options available</Text>
              : options.map(opt => (
                <Pressable key={opt.id} onPress={() => { onSelect(opt); setOpen(false); }}
                  style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}08`, backgroundColor: value?.id === opt.id ? `${c.primary}12` : 'transparent', borderRadius: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: value?.id === opt.id ? '700' : '400', color: value?.id === opt.id ? c.primary : c.text }}>{opt.name}</Text>
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
  value, onChange, c,
}: {
  value: Country;
  onChange: (country: Country) => void;
  c: typeof neuColors.light;
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
          backgroundColor: c.base, borderRadius: 12,
          paddingHorizontal: 12, paddingVertical: 13,
          marginRight: 8,
          shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
          shadowOpacity: 0.6, shadowRadius: 5,
          minWidth: 88,
        }}
      >
        <Text style={{ fontSize: 20, marginRight: 4 }}>{value.flag}</Text>
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginRight: 2 }}>
          {value.callingCode}
        </Text>
        <ChevronDown size={13} color={c.text} opacity={0.4} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={{ backgroundColor: c.base, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '70%', padding: 20 }}
            onPress={() => {/* prevent dismiss */}}
          >
            <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 12, textAlign: 'center' }}>
              Select Country
            </Text>
            {/* Search */}
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: c.base, borderRadius: 10,
              paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
              shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 1 },
              shadowOpacity: 0.4, shadowRadius: 3,
            }}>
              <Search size={15} color={c.text} opacity={0.4} />
              <TextInput
                value={searchText}
                onChangeText={setSearchText}
                placeholder="Search country or code…"
                placeholderTextColor={`${c.text}55`}
                autoCapitalize="none"
                style={{ flex: 1, marginLeft: 8, fontSize: 14, color: c.text }}
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
                    paddingVertical: 12, paddingHorizontal: 4,
                    borderBottomWidth: 1, borderBottomColor: `${c.text}08`,
                    backgroundColor: item.iso === value.iso ? `${c.primary}10` : 'transparent',
                    borderRadius: 8,
                  }}
                >
                  <Text style={{ fontSize: 22, marginRight: 12 }}>{item.flag}</Text>
                  <Text style={{ flex: 1, fontSize: 15, color: c.text, fontWeight: item.iso === value.iso ? '700' : '400' }}>
                    {item.name}
                  </Text>
                  <Text style={{ fontSize: 14, color: c.primary, fontWeight: '600' }}>
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
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const insets = useSafeAreaInsets();

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
    if (!fullName.trim()) return 'Full name is required.';
    if (!email.trim() || !email.includes('@')) return 'A valid email is required.';
    const phoneErr = validateNationalNumber(country, nationalPhone.trim());
    if (phoneErr) return phoneErr;
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

  const handleSignUp = async () => {
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
      setError('Invalid phone number. Please check and try again.');
      setLoading(false);
      return;
    }

    // Double-check with our client normalizer (should be identical)
    const normalizedPhone = normalizePhoneE164(e164) ?? e164;

    // ── Server-side uniqueness pre-check ──────────────────────────────────────
    // Calls a SECURITY DEFINER RPC so we can safely check auth.users (email)
    // and profiles (phone_e164) without RLS blocking the lookup.
    // This prevents the raw "Database error saving new user" Supabase Auth
    // error from ever reaching the user.
    try {
      const { data: conflicts, error: rpcErr } = await supabase.rpc(
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
          setEmailError('This email address is already registered.');
          hasConflict = true;
        }
        if (phone_taken) {
          setPhoneError('This phone number is already registered.');
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

    // ── Supabase Auth registration ────────────────────────────────────────────
    // Role is always 'student' on self-registration — only admins can promote
    const { error: authError } = await supabase.auth.signUp({
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
      // Sanitize raw Supabase/PostgreSQL errors — never expose internals
      const msg = authError.message ?? '';
      if (
        msg.toLowerCase().includes('database error') ||
        msg.toLowerCase().includes('unique constraint') ||
        msg.toLowerCase().includes('duplicate key') ||
        msg.toLowerCase().includes('already registered') ||
        msg.toLowerCase().includes('already exists')
      ) {
        // Treat ambiguous DB errors as a duplicate email (most common cause)
        setEmailError('This email address is already registered.');
      } else if (
        msg.toLowerCase().includes('invalid email') ||
        msg.toLowerCase().includes('email')
      ) {
        setEmailError('Please enter a valid email address.');
      } else if (msg.toLowerCase().includes('password')) {
        setError('Password must be at least 8 characters.');
      } else if (
        msg.toLowerCase().includes('rate limit') ||
        msg.toLowerCase().includes('too many')
      ) {
        setError('Too many attempts. Please wait a moment and try again.');
      } else {
        setError('Registration failed. Please check your details and try again.');
      }
      setLoading(false);
      return;
    }

    router.replace('/(auth)/sign-in');
    setLoading(false);
  };



  const labelStyle = {
    fontSize: 12, fontWeight: '600' as const, color: c.text,
    opacity: 0.55, marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: 0.8,
  };

  return (
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          padding: 24,
          paddingTop: Math.max(insets.top + 16, 40),
          paddingBottom: Math.max(insets.bottom + 16, 32),
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', marginBottom: 32 }}>
          <BrandLogo variant="auto" size={52} />
          <Text style={{ fontSize: 28, fontWeight: '800', color: c.text, marginTop: 8 }}>Create Account</Text>
          <Text style={{ fontSize: 14, color: c.text, opacity: 0.55, marginTop: 4 }}>Join MedAcademy today</Text>
        </View>

        <NeuCard radius={22} style={{ padding: 22 }}>
          {/* Full Name */}
          <Text style={labelStyle}>Full Name</Text>
          <NeuInputRow
            c={c}
            value={fullName}
            onChangeText={setFullName}
            placeholder="Ahmed Abdelfattah"
            autoCapitalize="words"
            leftIcon={<User size={18} color={c.text} opacity={0.4} />}
          />

          {/* Email */}
          <Text style={labelStyle}>Email</Text>
          <NeuInputRow
            c={c}
            hasError={!!emailError}
            value={email}
            onChangeText={(v) => { setEmail(v); if (emailError) setEmailError(''); }}
            placeholder="ahmed@gmail.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon={<Mail size={18} color={emailError ? '#DC2626' : c.text} opacity={emailError ? 1 : 0.4} />}
          />
          {emailError ? (
            <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10, marginTop: -10 }}>{emailError}</Text>
          ) : null}

          {/* Phone — country picker + national number */}
          <Text style={labelStyle}>Phone Number</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: phoneError ? 4 : 14 }}>
            {/* Country code picker button */}
            <CountryCodePicker value={country} onChange={(ct) => { setCountry(ct); setNationalPhone(''); setPhoneError(''); }} c={c} />
            {/* National number input */}
            <NeuInputRow
              c={c}
              hasError={!!phoneError}
              containerStyle={{ flex: 1, marginBottom: 0 }}
              value={nationalPhone}
              onChangeText={(v) => { setNationalPhone(v); if (phoneError) setPhoneError(''); }}
              placeholder={country.hasLeadingZero ? '01020xxxxxx' : '501234567'}
              keyboardType="phone-pad"
              leftIcon={<Phone size={16} color={phoneError ? '#DC2626' : c.text} opacity={phoneError ? 1 : 0.4} />}
            />
          </View>
          {phoneError ? (
            <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10, marginLeft: 2 }}>{phoneError}</Text>
          ) : null}
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: phoneError ? 0 : -10, marginBottom: 12, marginLeft: 2 }}>
            Will be stored as {buildE164(country, nationalPhone) ?? `${country.callingCode}…`}
          </Text>

          {/* Password */}
          <Text style={labelStyle}>Password</Text>
          <NeuInputRow
            c={c}
            value={password}
            onChangeText={setPassword}
            placeholder="Min. 8 characters"
            secureTextEntry={!showPwd}
            leftIcon={<Lock size={18} color={c.text} opacity={0.4} />}
            rightElement={
              <Pressable
                onPress={() => setShowPwd(!showPwd)}
                accessibilityLabel={showPwd ? 'Hide password' : 'Show password'}
                accessibilityRole="button"
                style={{ padding: 4 }}
              >
                {showPwd ? <EyeOff size={18} color={c.text} opacity={0.4} /> : <Eye size={18} color={c.text} opacity={0.4} />}
              </Pressable>
            }
          />

          {/* Confirm Password */}
          <Text style={labelStyle}>Confirm Password</Text>
          <NeuInputRow
            c={c}
            hasError={confirmPassword.length > 0 && confirmPassword !== password}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Re-enter your password"
            secureTextEntry={!showConfirmPwd}
            leftIcon={<Lock size={18} color={c.text} opacity={0.4} />}
            rightElement={
              <Pressable onPress={() => setShowConfirmPwd(!showConfirmPwd)}>
                {showConfirmPwd ? <EyeOff size={18} color={c.text} opacity={0.4} /> : <Eye size={18} color={c.text} opacity={0.4} />}
              </Pressable>
            }
          />
          {confirmPassword.length > 0 && confirmPassword !== password && (
            <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10, marginTop: -8 }}>Passwords do not match.</Text>
          )}

          {/* Optional Academic Info */}
          <Pressable
            onPress={() => setAcademicOpen(v => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}
          >
            <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>
              {academicOpen ? '▾ Hide' : '▸ Add'} Academic Info (optional)
            </Text>
          </Pressable>

          {academicOpen && (
            <>
              <SelectPicker label="University" value={university} options={universities} onSelect={(o) => { setUniversity(o); setFaculty(null); }} loading={loadingUni} placeholder="Select university" c={c} />
              <SelectPicker label="Faculty" value={faculty} options={faculties} onSelect={setFaculty} loading={loadingFac} disabled={!university} placeholder={university ? 'Select faculty' : 'Select university first'} c={c} />
              <SelectPicker label="Academic Level" value={academicLevel} options={academicLevels} onSelect={setAcademicLevel} loading={loadingLvl} placeholder="Select level" c={c} />
            </>
          )}

          {error ? <Text style={{ color: '#DC2626', fontSize: 13, marginBottom: 12 }}>{error}</Text> : null}

          <NeuButton label="Create Account" onPress={handleSignUp} loading={loading} fullWidth />
        </NeuCard>

        <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 24, marginBottom: 32 }}>
          <Text style={{ color: c.text, opacity: 0.55, fontSize: 14 }}>Already have an account? </Text>
          <Pressable onPress={() => router.push('/(auth)/sign-in')}>
            <Text style={{ color: c.primary, fontWeight: '700', fontSize: 14 }}>Sign In</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
