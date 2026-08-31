/**
 * Create Student — Doctor flow
 * Step 1: Student info (name, email/phone, academic, temp password)
 * Step 2: Mode — Account Only  OR  Account + Activate Course
 *   Mode B sub-steps: pick course → pick method (Code or Credits) → confirm
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, ScrollView, KeyboardAvoidingView,
  Pressable, useColorScheme,
} from 'react-native';
import { useRouter, RelativePathString } from 'expo-router';
import {
  User, Mail, Phone, Lock, Eye, EyeOff,
  Building2, GraduationCap, BookOpen, ChevronDown,
  CreditCard, Ticket, CheckCircle, ArrowLeft, ArrowRight,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { neuColors, useLayout, neuFlatStyle, safeBottom , zIndex} from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { friendlyError } from '@/lib/validation';
import {
  getUniversities, getFaculties, getAcademicLevels,
  getCourses, processStudentOperation,
} from '@/lib/api';
import { invalidateCreditCache, getCreditBalance, type CreditBalance } from '@/lib/creditService';

interface PickerOption { id: string; name: string; }

// ── Inline picker component ─────────────────────────────────────────────────
function FieldPicker({
  label, icon: Icon, value, onPress, loading, disabled, c,
}: {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  value: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  c: typeof neuColors.light;
}) {
  const flat = neuFlatStyle(useColorScheme() === 'dark');
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={[flat, { borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: disabled ? 0.5 : 1 }]}
    >
      <Icon size={18} color={c.primary} />
      <Text style={{ flex: 1, color: value ? c.text : `${c.text}66`, fontSize: 15 }} numberOfLines={1}>
        {loading ? 'Loading…' : (value || label)}
      </Text>
      <ChevronDown size={16} color={`${c.text}66`} />
    </Pressable>
  );
}

function PickerSheet({
  visible, title, options, selected, onSelect, onClose, c,
}: {
  visible: boolean; title: string; options: PickerOption[];
  selected: string; onSelect: (o: PickerOption) => void; onClose: () => void;
  c: typeof neuColors.light;
}) {
  const flat = neuFlatStyle(useColorScheme() === 'dark');
  if (!visible) return null;
  return (
    <View style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.35)', zIndex: zIndex.modal, justifyContent: 'flex-end',
    }}>
      <View style={[flat, { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '60%' }]}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 16 }}>{title}</Text>
        <ScrollView>
          {options.map(o => (
            <Pressable key={o.id} onPress={() => { onSelect(o); onClose(); }}
              style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: `${c.text}18`, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ flex: 1, fontSize: 15, color: c.text }}>{o.name}</Text>
              {selected === o.id && <CheckCircle size={18} color={c.primary} />}
            </Pressable>
          ))}
        </ScrollView>
        <NeuButton label="Cancel" onPress={onClose} variant="secondary" style={{ marginTop: 12 }} />
      </View>
    </View>
  );
}

// ── Shared input row: flat shadow on wrapper View, plain style on TextInput ──
function InputRow({
  icon: Icon, placeholder, value, onChangeText, secureTextEntry, keyboardType,
  autoCapitalize, suffix, flat, c,
}: {
  icon: React.ComponentType<{ size: number; color: string }>;
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'words' | 'characters';
  suffix?: React.ReactNode;
  flat: object;
  c: typeof neuColors.light;
}) {
  return (
    <View style={[flat, { borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, minWidth: 0 }]}>
      <Icon size={18} color={c.primary} />
      <TextInput
        style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0, paddingHorizontal: 10 }}
        placeholder={placeholder}
        placeholderTextColor={`${c.text}66`}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
      />
      {suffix}
    </View>
  );
}

// ── Main Screen ────────────────────────────────────────────────────────────
export default function CreateStudentScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const flat = neuFlatStyle(isDark);
  const router = useRouter();
  const { profile } = useProfileStore();
  const { showToast } = useToast();

  // ── Step state ────────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2>(1);

  // ── Step 1 fields ─────────────────────────────────────────────────────────
  const [fullName,  setFullName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [phone,     setPhone]     = useState('');
  const [tempPass,  setTempPass]  = useState('');
  const [showPass,  setShowPass]  = useState(false);

  // Academic pickers
  const [universities,    setUniversities]    = useState<PickerOption[]>([]);
  const [faculties,       setFaculties]       = useState<PickerOption[]>([]);
  const [academicLevels,  setAcademicLevels]  = useState<PickerOption[]>([]);
  const [university,      setUniversity]      = useState<PickerOption | null>(null);
  const [faculty,         setFaculty]         = useState<PickerOption | null>(null);
  const [academicLevel,   setAcademicLevel]   = useState<PickerOption | null>(null);
  const [loadingUni,      setLoadingUni]      = useState(false);
  const [loadingFac,      setLoadingFac]      = useState(false);
  const [loadingLvl,      setLoadingLvl]      = useState(false);
  const [openPicker,      setOpenPicker]      = useState<'uni' | 'fac' | 'lvl' | null>(null);

  // ── Step 2 fields ─────────────────────────────────────────────────────────
  type Mode = 'account_only' | 'activate';
  type Method = 'credits' | 'code';
  const [mode,             setMode]             = useState<Mode | null>(null);
  const [courses,          setCourses]          = useState<PickerOption[]>([]);
  const [courseId,         setCourseId]         = useState('');
  const [method,           setMethod]           = useState<Method | null>(null);
  const [activCode,        setActivCode]        = useState('');
  // creditBal: always from creditService — same source as every other screen
  const [creditBal,        setCreditBal]        = useState<CreditBalance | null>(null);
  const [openCoursePicker, setOpenCoursePicker] = useState(false);

  // ── Error / loading ────────────────────────────────────────────────────────
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);

  // Load universities once
  useEffect(() => {
    (async () => {
      setLoadingUni(true);
      try { const d = await getUniversities(); setUniversities(d.map((u: any) => ({ id: u.id, name: u.name }))); } catch { /* ignore */ }
      setLoadingUni(false);
    })();
  }, []);

  // Load faculties when university changes
  useEffect(() => {
    if (!university) { setFaculties([]); setFaculty(null); return; }
    (async () => {
      setLoadingFac(true);
      try { const d = await getFaculties(university.id); setFaculties(d.map((f: any) => ({ id: f.id, name: f.name }))); } catch { /* ignore */ }
      setLoadingFac(false);
    })();
  }, [university?.id]);

  // Load levels when faculty changes
  useEffect(() => {
    if (!faculty) { setAcademicLevels([]); setAcademicLevel(null); return; }
    (async () => {
      setLoadingLvl(true);
      try { const d = await getAcademicLevels(faculty.id); setAcademicLevels(d.map((l: any) => ({ id: l.id, name: l.name }))); } catch { /* ignore */ }
      setLoadingLvl(false);
    })();
  }, [faculty?.id]);

  // Load doctor's courses + credit balance when reaching step 2
  // Uses creditService — same source as every other screen
  const loadStep2Data = useCallback(async () => {
    if (!profile) return;
    try {
      const [cs, bal] = await Promise.all([
        getCourses({ doctorId: profile.id, status: 'published' }),
        getCreditBalance(),
      ]);
      setCourses(cs.map((co: any) => ({ id: co.id, name: co.title })));
      setCreditBal(bal);
    } catch { /* ignore */ }
  }, [profile?.id]);

  // ── Validation ────────────────────────────────────────────────────────────
  const validateStep1 = (): string | null => {
    if (!fullName.trim()) return 'Full name is required.';
    if (!email.trim() && !phone.trim()) return 'At least one of Email or Phone is required.';
    if (email.trim() && !email.includes('@')) return 'Enter a valid email address.';
    if (!tempPass || tempPass.length < 6) return 'Temporary password must be at least 6 characters.';
    return null;
  };

  const handleNext = () => {
    const err = validateStep1();
    if (err) { setError(err); return; }
    setError('');
    setStep(2);
    loadStep2Data();
  };

  // ── Submit — ONE atomic EF call for everything ────────────────────────────────
  const handleConfirm = async () => {
    if (!mode) { setError('Please choose a creation mode.'); return; }
    if (mode === 'activate') {
      if (!courseId) { setError('Please select a course.'); return; }
      if (!method)   { setError('Please choose an activation method.'); return; }
      if (method === 'code' && !activCode.trim()) { setError('Please enter an activation code.'); return; }
      if (method === 'credits' && (creditBal?.remaining ?? 0) < 1) { setError('Insufficient credits.'); return; }
    }
    setLoading(true); setError('');
    try {
      // Determine mode for the unified Edge Function
      type SOMode = 'create_only' | 'create_and_enroll_credits' | 'create_and_enroll_code';
      let opMode: SOMode = 'create_only';
      if (mode === 'activate' && method === 'credits') opMode = 'create_and_enroll_credits';
      if (mode === 'activate' && method === 'code')    opMode = 'create_and_enroll_code';

      // Single atomic call: student-operations EF handles everything in one transaction.
      // On any failure (credits, profile, enrollment) the EF rolls back completely.
      // We never show success until this call returns { success: true }.
      const result = await processStudentOperation({
        mode:              opMode,
        full_name:         fullName.trim(),
        email:             email.trim() || undefined,
        phone:             phone.trim() || undefined,
        password:          tempPass,
        university_id:     university?.id,
        faculty_id:        faculty?.id,
        academic_level_id: academicLevel?.id,
        course_id:         courseId || undefined,
        activation_code:   method === 'code' ? activCode.trim().toUpperCase() : undefined,
      });

      if (!result?.student_id) throw new Error('Student creation failed.');

      // Invalidate credit cache so every screen picks up the new balance
      invalidateCreditCache();

      // Only reached after ALL backend operations completed successfully
      showToast({ type: 'success', message: 'Student account created successfully!' });

      const remainingAfter = opMode === 'create_and_enroll_credits'
        ? (result.activation?.balance_after ?? (creditBal?.remaining ?? 1) - 1)
        : (creditBal?.remaining ?? 0);

      router.push({
        pathname: '/(app)/(doctor)/student-credentials' as RelativePathString,
        params: {
          full_name:         fullName.trim(),
          email:             result.email ?? '',          // null/'' for phone-only
          phone:             result.phone ?? '',          // display phone (local format)
          login_type:        result.login_type ?? 'email',
          temp_password:     tempPass,
          course_name:       mode === 'activate' ? (courses.find(co => co.id === courseId)?.name ?? '') : '',
          activation_method: opMode === 'create_only' ? 'account_only' : (method ?? 'credits'),
          remaining_credits: String(remainingAfter),
        },
      });
    } catch (e) {
      setError(friendlyError(e, 'Student creation failed. Please try again.'));
    }
    setLoading(false);
  };

  const selectedCourse = courses.find(co => co.id === courseId);

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <PageHeader title="Create Student" subtitle={step === 1 ? 'Step 1 of 2 — Student Info' : 'Step 2 of 2 — Creation Mode'} />

        <View style={{ paddingHorizontal: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>

          {/* Step indicator */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
            {[1, 2].map(s => (
              <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: step >= s ? c.primary : `${c.text}22` }} />
            ))}
          </View>

          {/* ── STEP 1 ─────────────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <NeuCard>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Student Information</Text>
                <View style={{ gap: 12 }}>
                  <InputRow icon={User}  placeholder="Full Name *"                               value={fullName} onChangeText={setFullName} autoCapitalize="words" flat={flat} c={c} />
                  <InputRow icon={Mail}  placeholder="Email (optional if phone provided)"         value={email}    onChangeText={setEmail}    keyboardType="email-address" flat={flat} c={c} />
                  <InputRow icon={Phone} placeholder="Phone (optional if email provided)"         value={phone}    onChangeText={setPhone}    keyboardType="phone-pad"     flat={flat} c={c} />
                </View>
              </NeuCard>

              {/* Academic */}
              <NeuCard>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Academic Information</Text>
                <View style={{ gap: 12 }}>
                  <FieldPicker label="University"     icon={Building2}     value={university?.name ?? ''}    onPress={() => setOpenPicker('uni')} loading={loadingUni}                 c={c} />
                  <FieldPicker label="Faculty"        icon={GraduationCap} value={faculty?.name ?? ''}       onPress={() => setOpenPicker('fac')} loading={loadingFac} disabled={!university} c={c} />
                  <FieldPicker label="Academic Level" icon={BookOpen}      value={academicLevel?.name ?? ''} onPress={() => setOpenPicker('lvl')} loading={loadingLvl} disabled={!faculty}    c={c} />
                </View>
              </NeuCard>

              {/* Temp password */}
              <NeuCard>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Temporary Password</Text>
                <View style={[flat, { borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 4 }]}>
                  <Lock size={18} color={c.primary} />
                  <TextInput
                    style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0, paddingHorizontal: 10 }}
                    placeholder="Temporary Password *"
                    placeholderTextColor={`${c.text}66`}
                    value={tempPass}
                    onChangeText={setTempPass}
                    secureTextEntry={!showPass}
                    autoCapitalize="none"
                  />
                  <Pressable onPress={() => setShowPass(p => !p)}>
                    {showPass ? <EyeOff size={18} color={`${c.text}66`} /> : <Eye size={18} color={`${c.text}66`} />}
                  </Pressable>
                </View>
                <Text style={{ fontSize: 12, color: `${c.text}66`, marginTop: 6 }}>
                  The student will be required to change this password on first login.
                </Text>
              </NeuCard>

              {error ? <Text style={{ color: '#EF4444', fontSize: 14, textAlign: 'center' }}>{error}</Text> : null}
              <NeuButton label="Next" onPress={handleNext} icon={<ArrowRight size={16} color="#fff" />} />
            </>
          )}

          {/* ── STEP 2 ─────────────────────────────────────────────────── */}
          {step === 2 && (
            <>
              <NeuCard>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Choose Creation Mode</Text>
                {(['account_only', 'activate'] as Mode[]).map(m => (
                  <Pressable key={m} onPress={() => { setMode(m); setError(''); }}
                    style={[flat, { borderRadius: 16, padding: 16, marginBottom: 12,
                      borderWidth: mode === m ? 2 : 0, borderColor: c.primary }]}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>
                      {m === 'account_only' ? '📋  Create Account Only' : '🎓  Create Account + Activate Course'}
                    </Text>
                    <Text style={{ fontSize: 13, color: `${c.text}88`, marginTop: 4 }}>
                      {m === 'account_only'
                        ? 'No course assigned. No credits consumed.'
                        : 'Assign a course immediately via activation code or credits.'}
                    </Text>
                  </Pressable>
                ))}
              </NeuCard>

              {/* Course + method (only when activate mode chosen) */}
              {mode === 'activate' && (
                <>
                  <NeuCard>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 12 }}>Select Course</Text>
                    <FieldPicker
                      label="Choose a course…" icon={BookOpen}
                      value={selectedCourse?.name ?? ''}
                      onPress={() => setOpenCoursePicker(true)}
                      c={c}
                    />
                  </NeuCard>

                  {courseId && (
                    <NeuCard>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 12 }}>Activation Method</Text>
                      {(['credits', 'code'] as Method[]).map(m => (
                        <Pressable key={m} onPress={() => setMethod(m)}
                          style={[flat, { borderRadius: 16, padding: 14, marginBottom: 10,
                            borderWidth: method === m ? 2 : 0, borderColor: c.primary, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
                          {m === 'credits' ? <CreditCard size={20} color={c.primary} /> : <Ticket size={20} color={c.primary} />}
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>
                              {m === 'credits' ? 'Doctor Credits' : 'Activation Code'}
                            </Text>
                            {m === 'credits' && (
                              <Text style={{ fontSize: 13, color: `${c.text}88` }}>
                                Cost: 1 Credit · Balance: {creditBal === null ? '…' : `${creditBal.remaining} Credits`}
                                {creditBal !== null && creditBal.remaining > 0 ? ` · After: ${creditBal.remaining - 1} Credits` : ''}
                              </Text>
                            )}
                          </View>
                        </Pressable>
                      ))}

                      {method === 'code' && (
                        <View style={[flat, { borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 4, marginTop: 8 }]}>
                          <Ticket size={18} color={c.primary} />
                          <TextInput
                            style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0, paddingHorizontal: 10 }}
                            placeholder="Activation Code"
                            placeholderTextColor={`${c.text}66`}
                            value={activCode}
                            onChangeText={t => setActivCode(t.toUpperCase())}
                            autoCapitalize="characters"
                            autoCorrect={false}
                          />
                        </View>
                      )}
                    </NeuCard>
                  )}
                </>
              )}

              {/* Summary card */}
              {mode && (
                <NeuCard>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 8 }}>Summary</Text>
                  {([
                    ['Student', fullName],
                    ['Email', email || '—'],
                    ['Phone', phone || '—'],
                    ['Mode', mode === 'account_only' ? 'Account Only' : 'Account + Activate'],
                    ...(mode === 'activate' && courseId ? [
                      ['Course', selectedCourse?.name ?? ''],
                      ['Method', method === 'credits' ? 'Doctor Credits (1 credit)' : 'Activation Code'],
                    ] : []),
                  ] as [string, string][]).map(([lbl, val]) => (
                    <View key={lbl} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                      <Text style={{ fontSize: 13, color: `${c.text}77` }}>{lbl}</Text>
                      <Text style={{ fontSize: 13, color: c.text, fontWeight: '600', flex: 1, textAlign: 'right' }}>{val}</Text>
                    </View>
                  ))}
                </NeuCard>
              )}

              {error ? <Text style={{ color: '#EF4444', fontSize: 14, textAlign: 'center' }}>{error}</Text> : null}

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <NeuButton label="Back" onPress={() => { setStep(1); setError(''); }} variant="secondary"
                  style={{ flex: 1 }} icon={<ArrowLeft size={16} color={c.text} />} />
                <NeuButton label={loading ? 'Creating…' : 'Confirm'} onPress={handleConfirm}
                  loading={loading} disabled={!mode} style={{ flex: 2 }} />
              </View>
            </>
          )}
        </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Picker sheets */}
      <PickerSheet visible={openPicker === 'uni'} title="Select University" options={universities}
        selected={university?.id ?? ''} onSelect={u => { setUniversity(u); setFaculty(null); setAcademicLevel(null); }}
        onClose={() => setOpenPicker(null)} c={c} />
      <PickerSheet visible={openPicker === 'fac'} title="Select Faculty" options={faculties}
        selected={faculty?.id ?? ''} onSelect={f => { setFaculty(f); setAcademicLevel(null); }}
        onClose={() => setOpenPicker(null)} c={c} />
      <PickerSheet visible={openPicker === 'lvl'} title="Select Level" options={academicLevels}
        selected={academicLevel?.id ?? ''}
        onSelect={setAcademicLevel} onClose={() => setOpenPicker(null)} c={c} />
      <PickerSheet visible={openCoursePicker} title="Select Course" options={courses}
        selected={courseId} onSelect={o => setCourseId(o.id)} onClose={() => setOpenCoursePicker(false)} c={c} />
    </View>
  );
}
