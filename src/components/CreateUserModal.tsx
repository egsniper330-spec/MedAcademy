/**
 * CreateUserModal — Super Admin "Add User" flow
 *
 * Step 1: Choose Account Type (Student / Doctor / Admin)
 * Step 2: Fill in details + role-specific fields (Doctor: initial credits, unlimited devices)
 *
 * Uses existing API primitives:
 *   • createManagedUser()  — Edge Function 'user-management'
 *   • allocateCredits()    — Edge Function 'credits'  (Doctor only)
 *   • getUniversities() / getFaculties() — for optional dropdowns
 */
import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable,
  ActivityIndicator, useColorScheme, Switch,
} from 'react-native';
import {
  GraduationCap, Stethoscope, ShieldCheck,
  ChevronLeft, User, Mail, Phone, Lock, Eye, EyeOff,
  Layers, Zap, CheckCircle2, UserPlus,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors } from '@/lib/neu';
import {
  createManagedUser, allocateCredits,
  getUniversities, getFaculties,
  type CreateUserPayload,
} from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type UserRole = 'student' | 'doctor' | 'admin';
type Step = 'role' | 'form';

interface RoleOption {
  key:         UserRole;
  label:       string;
  description: string;
  Icon:        React.ComponentType<{ size: number; color: string }>;
  color:       string;
}

const ROLE_OPTIONS: RoleOption[] = [
  {
    key:         'student',
    label:       'Student',
    description: 'Can purchase and access courses.',
    Icon:        GraduationCap,
    color:       '#7C3AED',
  },
  {
    key:         'doctor',
    label:       'Doctor',
    description: 'Can publish and manage courses.',
    Icon:        Stethoscope,
    color:       '#16A34A',
  },
  {
    key:         'admin',
    label:       'Admin',
    description: 'Can manage platform operations.',
    Icon:        ShieldCheck,
    color:       '#EF4444',
  },
];

interface FormState {
  fullName:        string;
  email:           string;
  phone:           string;
  password:        string;
  confirmPassword: string;
  universityId:    string;
  facultyId:       string;
  academicLevelId: string;
  // Doctor-only
  initialCredits:  string;
  unlimitedDevices: boolean;
}

const BLANK_FORM: FormState = {
  fullName:         '',
  email:            '',
  phone:            '',
  password:         '',
  confirmPassword:  '',
  universityId:     '',
  facultyId:        '',
  academicLevelId:  '',
  initialCredits:   '',
  unlimitedDevices: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Password strength
// ─────────────────────────────────────────────────────────────────────────────

function passwordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8)            score++;
  if (/[A-Z]/.test(pw))         score++;
  if (/[0-9]/.test(pw))         score++;
  if (/[^A-Za-z0-9]/.test(pw))  score++;
  const map = [
    { label: '',        color: 'transparent' },
    { label: 'Weak',    color: '#DC2626' },
    { label: 'Fair',    color: '#D97706' },
    { label: 'Good',    color: '#16A34A' },
    { label: 'Strong',  color: '#2DA8FF' },
  ];
  return { score, ...map[score] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function FieldInput({
  icon, placeholder, value, onChangeText, secureTextEntry,
  keyboardType, autoCapitalize, rightNode, error, isDark,
}: {
  icon: React.ReactNode; placeholder: string; value: string;
  onChangeText: (v: string) => void; secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric';
  autoCapitalize?: 'none' | 'words';
  rightNode?: React.ReactNode; error?: string; isDark: boolean;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={{ marginBottom: error ? 4 : 14 }}>
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: `${c.text}08`, borderRadius: 13,
        paddingHorizontal: 14, paddingVertical: 13,
        borderWidth: error ? 1 : 0, borderColor: error ? '#DC2626' : 'transparent',
      }}>
        <View style={{ opacity: 0.4 }}>{icon}</View>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={`${c.text}45`}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize={autoCapitalize ?? 'none'}
          style={{ flex: 1, fontSize: 15, color: c.text }}
        />
        {rightNode}
      </View>
      {!!error && (
        <Text style={{ fontSize: 11, color: '#DC2626', marginTop: 4, marginLeft: 4 }}>{error}</Text>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface CreateUserModalProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the newly-created user object after successful creation */
  onCreated: (user: { id: string; full_name: string; role: string; email: string }) => void;
}

export function CreateUserModal({ visible, onClose, onCreated }: CreateUserModalProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [step,         setStep]         = useState<Step>('role');
  const [selectedRole, setSelectedRole] = useState<UserRole | null>(null);
  const [form,         setForm]         = useState<FormState>(BLANK_FORM);
  const [errors,       setErrors]       = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting,   setSubmitting]   = useState(false);
  const [showPw,       setShowPw]       = useState(false);
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [globalError,  setGlobalError]  = useState('');
  const [success,      setSuccess]      = useState(false);

  // Optional look-up data
  const [universities, setUniversities] = useState<{ id: string; name: string }[]>([]);
  const [faculties,    setFaculties]    = useState<{ id: string; name: string }[]>([]);

  // Reset everything when modal opens/closes
  useEffect(() => {
    if (!visible) {
      setTimeout(() => {
        setStep('role');
        setSelectedRole(null);
        setForm(BLANK_FORM);
        setErrors({});
        setGlobalError('');
        setSuccess(false);
        setShowPw(false);
        setShowConfirm(false);
      }, 300);
    }
  }, [visible]);

  // Load universities once modal opens
  useEffect(() => {
    if (visible) {
      getUniversities().then(setUniversities).catch(() => {});
    }
  }, [visible]);

  // Load faculties when university changes
  useEffect(() => {
    if (!form.universityId) { setFaculties([]); return; }
    getFaculties(form.universityId).then(setFaculties).catch(() => {});
  }, [form.universityId]);

  const set = useCallback((key: keyof FormState, val: string | boolean) => {
    setForm(f => ({ ...f, [key]: val }));
    setErrors(e => ({ ...e, [key]: undefined }));
    setGlobalError('');
  }, []);

  // ── Validation ────────────────────────────────────────────────────────────

  const validate = (): boolean => {
    const errs: typeof errors = {};
    if (!form.fullName.trim())          errs.fullName       = 'Full name is required.';
    if (!form.email.trim())             errs.email          = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
                                        errs.email          = 'Enter a valid email address.';
    if (!form.password)                 errs.password       = 'Password is required.';
    else if (form.password.length < 8)  errs.password       = 'Password must be at least 8 characters.';
    if (!form.confirmPassword)          errs.confirmPassword = 'Please confirm your password.';
    else if (form.password !== form.confirmPassword)
                                        errs.confirmPassword = 'Passwords do not match.';
    if (selectedRole === 'doctor' && form.initialCredits && isNaN(Number(form.initialCredits)))
                                        errs.initialCredits  = 'Enter a valid number.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!validate() || !selectedRole) return;
    setSubmitting(true);
    setGlobalError('');
    try {
      const actionMap: Record<UserRole, CreateUserPayload['action']> = {
        student: 'create_user',
        doctor:  'create_doctor',
        admin:   'create_admin',
      };
      const payload: CreateUserPayload = {
        action:          actionMap[selectedRole],
        full_name:       form.fullName.trim(),
        email:           form.email.trim().toLowerCase(),
        password:        form.password,
        ...(form.phone.trim()        && { phone:             form.phone.trim() }),
        ...(form.universityId        && { university_id:     form.universityId }),
        ...(form.facultyId           && { faculty_id:        form.facultyId }),
        ...(form.academicLevelId     && { academic_level_id: form.academicLevelId }),
      };

      const result = await createManagedUser(payload);
      const newUserId = result.user_id;

      // Doctor: allocate initial credits if specified
      if (selectedRole === 'doctor' && form.initialCredits && Number(form.initialCredits) > 0) {
        await allocateCredits(newUserId, Number(form.initialCredits), 'Initial allocation on account creation');
      }

      setSuccess(true);
      // Small delay so success state is visible before closing
      setTimeout(() => {
        onCreated({
          id:        newUserId,
          full_name: form.fullName.trim(),
          role:      selectedRole,
          email:     form.email.trim().toLowerCase(),
        });
        onClose();
      }, 1200);
    } catch (e: any) {
      const msg: string = e?.message ?? 'Failed to create account.';
      // Surface known API errors as field-level hints
      if (/email.*already|already.*email/i.test(msg))
        setErrors(prev => ({ ...prev, email: 'This email is already in use.' }));
      else if (/phone.*already|already.*phone/i.test(msg))
        setErrors(prev => ({ ...prev, phone: 'This phone number is already registered.' }));
      else
        setGlobalError(msg);
    }
    setSubmitting(false);
  };

  // ── Dirty state — block accidental close mid-form ─────────────────────────
  const isDirty = step === 'form' && (
    form.fullName !== '' || form.email !== '' || form.password !== ''
  );

  const pw = passwordStrength(form.password);

  // ── Role picker step ──────────────────────────────────────────────────────

  const RoleStep = (
    <View style={{ paddingTop: 8, paddingBottom: 12 }}>
      {ROLE_OPTIONS.map(opt => {
        const active = selectedRole === opt.key;
        return (
          <Pressable
            key={opt.key}
            onPress={() => setSelectedRole(opt.key)}
            style={{ marginBottom: 12 }}
          >
            <NeuCard radius={18} style={{
              padding: 18, flexDirection: 'row', alignItems: 'center', gap: 16,
              borderWidth: active ? 2 : 1.5,
              borderColor: active ? opt.color : `${c.text}12`,
              backgroundColor: active ? `${opt.color}10` : undefined,
            }}>
              <View style={{
                width: 52, height: 52, borderRadius: 16,
                backgroundColor: `${opt.color}18`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <opt.Icon size={26} color={opt.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: active ? opt.color : c.text }}>
                  {opt.label}
                </Text>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginTop: 2, lineHeight: 18 }}>
                  {opt.description}
                </Text>
              </View>
              {active && (
                <CheckCircle2 size={22} color={opt.color} />
              )}
            </NeuCard>
          </Pressable>
        );
      })}

      <NeuButton
        label="Continue"
        onPress={() => { if (selectedRole) setStep('form'); }}
        disabled={!selectedRole}
        style={{ marginTop: 4 }}
      />
    </View>
  );

  // ── Form step ─────────────────────────────────────────────────────────────

  const selectedOpt = ROLE_OPTIONS.find(o => o.key === selectedRole);

  const FormStep = (
    <View style={{ paddingTop: 4, paddingBottom: 8 }}>
      {/* Back to role picker */}
      <Pressable
        onPress={() => setStep('role')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 18, alignSelf: 'flex-start' }}
      >
        <ChevronLeft size={16} color={c.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Change Role</Text>
      </Pressable>

      {/* Role badge */}
      {selectedOpt && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: `${selectedOpt.color}14`, borderRadius: 12,
          paddingHorizontal: 14, paddingVertical: 10, marginBottom: 20,
        }}>
          <selectedOpt.Icon size={16} color={selectedOpt.color} />
          <Text style={{ fontSize: 13, fontWeight: '700', color: selectedOpt.color }}>
            Creating {selectedOpt.label} account
          </Text>
        </View>
      )}

      {/* — Core fields — */}
      <FieldInput
        isDark={isDark}
        icon={<User size={17} color={c.text} />}
        placeholder="Full Name *"
        value={form.fullName}
        onChangeText={v => set('fullName', v)}
        autoCapitalize="words"
        error={errors.fullName}
      />
      <FieldInput
        isDark={isDark}
        icon={<Mail size={17} color={c.text} />}
        placeholder="Email Address *"
        value={form.email}
        onChangeText={v => set('email', v)}
        keyboardType="email-address"
        error={errors.email}
      />
      <FieldInput
        isDark={isDark}
        icon={<Phone size={17} color={c.text} />}
        placeholder="Phone Number (optional)"
        value={form.phone}
        onChangeText={v => set('phone', v)}
        keyboardType="phone-pad"
        error={errors.phone}
      />

      {/* Password */}
      <FieldInput
        isDark={isDark}
        icon={<Lock size={17} color={c.text} />}
        placeholder="Password *"
        value={form.password}
        onChangeText={v => set('password', v)}
        secureTextEntry={!showPw}
        error={errors.password}
        rightNode={
          <Pressable onPress={() => setShowPw(v => !v)} hitSlop={8}>
            {showPw
              ? <EyeOff size={17} color={c.text} opacity={0.4} />
              : <Eye    size={17} color={c.text} opacity={0.4} />}
          </Pressable>
        }
      />
      {/* Password strength bar */}
      {form.password.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10, marginTop: -6 }}>
          {[1,2,3,4].map(i => (
            <View key={i} style={{
              flex: 1, height: 3, borderRadius: 2,
              backgroundColor: i <= pw.score ? pw.color : `${c.text}15`,
            }} />
          ))}
          <Text style={{ fontSize: 10, color: pw.color, fontWeight: '700', minWidth: 46 }}>{pw.label}</Text>
        </View>
      )}

      <FieldInput
        isDark={isDark}
        icon={<Lock size={17} color={c.text} />}
        placeholder="Confirm Password *"
        value={form.confirmPassword}
        onChangeText={v => set('confirmPassword', v)}
        secureTextEntry={!showConfirm}
        error={errors.confirmPassword}
        rightNode={
          <Pressable onPress={() => setShowConfirm(v => !v)} hitSlop={8}>
            {showConfirm
              ? <EyeOff size={17} color={c.text} opacity={0.4} />
              : <Eye    size={17} color={c.text} opacity={0.4} />}
          </Pressable>
        }
      />

      {/* — Optional: University / Faculty — */}
      {universities.length > 0 && (
        <>
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.35, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
            Optional
          </Text>

          {/* University picker */}
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            style={{ marginBottom: 10 }}
            contentContainerStyle={{ gap: 8 }}
          >
            {universities.map(u => (
              <Pressable
                key={u.id}
                onPress={() => set('universityId', form.universityId === u.id ? '' : u.id)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                  backgroundColor: form.universityId === u.id ? `${c.primary}20` : `${c.text}0A`,
                  borderWidth: 1,
                  borderColor: form.universityId === u.id ? c.primary : 'transparent',
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '600', color: form.universityId === u.id ? c.primary : c.text, opacity: form.universityId === u.id ? 1 : 0.6 }}>
                  {u.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Faculty picker — shown only if university selected */}
          {form.universityId && faculties.length > 0 && (
            <ScrollView
              horizontal showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 14 }}
              contentContainerStyle={{ gap: 8 }}
            >
              {faculties.map(f => (
                <Pressable
                  key={f.id}
                  onPress={() => set('facultyId', form.facultyId === f.id ? '' : f.id)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                    backgroundColor: form.facultyId === f.id ? '#2DA8FF20' : `${c.text}0A`,
                    borderWidth: 1,
                    borderColor: form.facultyId === f.id ? '#2DA8FF' : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '600', color: form.facultyId === f.id ? '#2DA8FF' : c.text, opacity: form.facultyId === f.id ? 1 : 0.6 }}>
                    {f.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </>
      )}

      {/* — Doctor-only fields — */}
      {selectedRole === 'doctor' && (
        <>
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#16A34A', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10, marginTop: 4 }}>
            Doctor Settings
          </Text>

          <FieldInput
            isDark={isDark}
            icon={<Zap size={17} color="#16A34A" />}
            placeholder="Initial Credits (optional)"
            value={form.initialCredits}
            onChangeText={v => set('initialCredits', v)}
            keyboardType="numeric"
            error={errors.initialCredits}
          />

          {/* Unlimited devices toggle */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            backgroundColor: `${c.text}08`, borderRadius: 13,
            paddingHorizontal: 16, paddingVertical: 14, marginBottom: 14,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Layers size={17} color={c.text} opacity={0.45} />
              <View>
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>Unlimited Devices</Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Allow login from any number of devices</Text>
              </View>
            </View>
            <Switch
              value={form.unlimitedDevices}
              onValueChange={v => set('unlimitedDevices', v)}
              trackColor={{ false: `${c.text}20`, true: `${c.primary}80` }}
              thumbColor={form.unlimitedDevices ? c.primary : `${c.text}60`}
            />
          </View>
        </>
      )}

      {/* Global error */}
      {!!globalError && (
        <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 12, marginBottom: 14 }}>
          <Text style={{ fontSize: 13, color: '#DC2626', lineHeight: 18 }}>{globalError}</Text>
        </View>
      )}

      {/* Success state */}
      {success && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#16A34A14', borderRadius: 12, padding: 12, marginBottom: 14 }}>
          <CheckCircle2 size={18} color="#16A34A" />
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>Account created successfully!</Text>
        </View>
      )}

      {/* Submit */}
      <NeuButton
        label={submitting ? 'Creating…' : `Create ${selectedOpt?.label ?? ''} Account`}
        onPress={handleSubmit}
        disabled={submitting || success}
        style={{ marginTop: 4 }}
      />
    </View>
  );

  return (
    <ResponsiveModal
      visible={visible}
      onClose={onClose}
      title={step === 'role' ? 'Choose Account Type' : 'New Account'}
      subtitle={step === 'role' ? 'Select the role for the new user' : undefined}
      icon={
        step === 'role'
          ? <UserPlus size={20} color={c.primary} />
          : selectedOpt
            ? <selectedOpt.Icon size={20} color={selectedOpt.color} />
            : undefined
      }
      isDirty={isDirty}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 2, paddingBottom: 16 }}
      >
        {step === 'role' ? RoleStep : FormStep}
      </ScrollView>
    </ResponsiveModal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// End of file
