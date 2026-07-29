/**
 * ChangePasswordModal — Super Admin direct password change
 * No email sent. No old password required.
 * Shows strength indicator + confirm match validation.
 */
import { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, useColorScheme } from 'react-native';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react-native';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors } from '@/lib/neu';
import { changeAdminPassword } from '@/lib/api';
import { useToast } from '@/components/Toast';

// ── Password strength ────────────────────────────────────────────────────────

type StrengthLevel = 0 | 1 | 2 | 3 | 4;

interface StrengthResult {
  level: StrengthLevel;
  label: string;
  color: string;
}

function getStrength(pw: string): StrengthResult {
  if (!pw) return { level: 0, label: '', color: '#E5E7EB' };
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const clamped = Math.min(score, 4) as StrengthLevel;
  const map: Record<StrengthLevel, { label: string; color: string }> = {
    0: { label: '',       color: '#E5E7EB' },
    1: { label: 'Weak',   color: '#EF4444' },
    2: { label: 'Fair',   color: '#F97316' },
    3: { label: 'Good',   color: '#EAB308' },
    4: { label: 'Strong', color: '#22C55E' },
  };
  return { level: clamped, ...map[clamped] };
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  targetUserId: string;
  targetName: string;
  targetRole?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ChangePasswordModal({ visible, onClose, targetUserId, targetName, targetRole }: Props) {
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();

  // Derived semantic values from the actual neuColors shape
  const mutedText   = isDark ? 'rgba(221,230,240,0.55)' : 'rgba(28,45,74,0.45)';
  const borderColor = isDark ? 'rgba(48,68,100,0.6)'    : 'rgba(174,190,208,0.6)';
  const cardBg      = isDark ? 'rgba(255,255,255,0.04)'  : 'rgba(255,255,255,0.7)';

  const [newPw,     setNewPw]     = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showNew,   setShowNew]   = useState(false);
  const [showConf,  setShowConf]  = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setNewPw(''); setConfirmPw('');
      setError(''); setShowNew(false); setShowConf(false);
    }
  }, [visible]);

  const strength = getStrength(newPw);

  const validate = (): string | null => {
    if (!newPw)             return 'Please enter a new password.';
    if (newPw.length < 8)   return 'Password must be at least 8 characters.';
    if (!confirmPw)         return 'Please confirm the password.';
    if (newPw !== confirmPw) return 'Passwords do not match.';
    if (strength.level < 2) return 'Password is too weak. Add uppercase, numbers, or symbols.';
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setError('');
    setLoading(true);
    try {
      await changeAdminPassword(targetUserId, newPw);
      showToast({ type: 'success', message: `Password updated for ${targetName}.` });
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to change password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const inputWrap = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderWidth: 1.5,
    borderColor,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: cardBg,
    minWidth: 0,
    gap: 10,
  };

  return (
    <ResponsiveModal
      visible={visible}
      onClose={onClose}
      title="Change Password"
      subtitle={targetName}
    >
      <View style={{ gap: 20 }}>

        {/* Role badge */}
        {targetRole && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={16} color={mutedText} />
            <Text style={{ fontSize: 13, color: mutedText, textTransform: 'capitalize' }}>
              {targetRole.replace('_', ' ')} account
            </Text>
          </View>
        )}

        {/* New password */}
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: mutedText }}>New Password</Text>
          <View style={inputWrap}>
            <Lock size={16} color={mutedText} />
            <TextInput
              value={newPw}
              onChangeText={t => { setNewPw(t); setError(''); }}
              placeholder="Enter new password"
              placeholderTextColor={mutedText}
              secureTextEntry={!showNew}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }}
            />
            <Pressable onPress={() => setShowNew(v => !v)} hitSlop={8}>
              {showNew
                ? <EyeOff size={18} color={mutedText} />
                : <Eye    size={18} color={mutedText} />
              }
            </Pressable>
          </View>

          {/* Strength bar */}
          {newPw.length > 0 && (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                {([1, 2, 3, 4] as StrengthLevel[]).map(seg => (
                  <View
                    key={seg}
                    style={{
                      flex: 1, height: 4, borderRadius: 4,
                      backgroundColor: strength.level >= seg ? strength.color : borderColor,
                    }}
                  />
                ))}
              </View>
              {strength.label ? (
                <Text style={{ fontSize: 12, color: strength.color, fontWeight: '600' }}>
                  {strength.label}
                </Text>
              ) : null}
            </View>
          )}
        </View>

        {/* Confirm password */}
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: mutedText }}>Confirm Password</Text>
          <View style={{
            ...inputWrap,
            borderColor: confirmPw && confirmPw !== newPw ? '#EF4444' : borderColor,
          }}>
            <Lock size={16} color={mutedText} />
            <TextInput
              value={confirmPw}
              onChangeText={t => { setConfirmPw(t); setError(''); }}
              placeholder="Confirm new password"
              placeholderTextColor={mutedText}
              secureTextEntry={!showConf}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }}
            />
            <Pressable onPress={() => setShowConf(v => !v)} hitSlop={8}>
              {showConf
                ? <EyeOff size={18} color={mutedText} />
                : <Eye    size={18} color={mutedText} />
              }
            </Pressable>
          </View>
          {confirmPw.length > 0 && confirmPw !== newPw && (
            <Text style={{ fontSize: 12, color: '#EF4444' }}>Passwords do not match.</Text>
          )}
          {confirmPw.length > 0 && confirmPw === newPw && (
            <Text style={{ fontSize: 12, color: '#22C55E', fontWeight: '600' }}>✓ Passwords match</Text>
          )}
        </View>

        {/* Inline error */}
        {!!error && (
          <View style={{
            backgroundColor: '#FEF2F2', borderRadius: 10,
            padding: 12, borderWidth: 1, borderColor: '#FECACA',
          }}>
            <Text style={{ fontSize: 13, color: '#DC2626' }}>{error}</Text>
          </View>
        )}

        {/* Security note */}
        <View style={{ backgroundColor: `${c.primary}18`, borderRadius: 10, padding: 12 }}>
          <Text style={{ fontSize: 12, color: mutedText, lineHeight: 18 }}>
            The new password takes effect immediately. No email notification will be sent.
          </Text>
        </View>

        {/* Actions */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            onPress={onClose}
            disabled={loading}
            style={{
              flex: 1, paddingVertical: 14, borderRadius: 12,
              borderWidth: 1.5, borderColor,
              alignItems: 'center', justifyContent: 'center',
              opacity: loading ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: mutedText }}>Cancel</Text>
          </Pressable>

          <Pressable
            onPress={handleSubmit}
            disabled={loading}
            style={{
              flex: 1, paddingVertical: 14, borderRadius: 12,
              backgroundColor: loading ? `${c.primary}88` : c.primary,
              alignItems: 'center', justifyContent: 'center',
              flexDirection: 'row', gap: 8,
            }}
          >
            {loading && <ActivityIndicator size="small" color="#fff" />}
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
              {loading ? 'Saving…' : 'Set Password'}
            </Text>
          </Pressable>
        </View>

      </View>
    </ResponsiveModal>
  );
}
