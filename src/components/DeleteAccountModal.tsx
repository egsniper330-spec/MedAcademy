/**
 * DeleteAccountModal — rich permanent-delete confirmation.
 *
 * Usage:
 *   <DeleteAccountModal
 *     userId={id}
 *     visible={show}
 *     onClose={() => setShow(false)}
 *     onDeleted={() => { remove(id); setShow(false); }}
 *   />
 *
 * Behaviour:
 *  1. On open: fetch preflight (name, role, courses, credits, devices).
 *  2. Show full account summary + final warning.
 *  3. On confirm: call deleteUser EF → emit onDeleted.
 *  4. Role guards (LAST_ADMIN, LAST_SUPER_ADMIN, DOCTOR_HAS_COURSES) surface
 *     as clear error messages — no deletion occurs.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ActivityIndicator, ScrollView, useColorScheme,
} from 'react-native';
import {
  AlertTriangle, User, Mail, Phone, BookOpen, CreditCard,
  Smartphone, Shield, Trash2,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { getDeletePreflight, deleteUser, type DeletePreflight } from '@/lib/api';
import { logAndParse } from '@/lib/parseError';
import { displayPhoneNational } from '@/lib/phone';

interface Props {
  userId: string | null;
  visible: boolean;
  onClose: () => void;
  onDeleted: (userId: string) => void;
}

const ROLE_COLOR: Record<string, string> = {
  student:     '#6366F1',
  doctor:      '#0EA5E9',
  admin:       '#F59E0B',
  super_admin: '#EF4444',
};

export function DeleteAccountModal({ userId, visible, onClose, onDeleted }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c    = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  const [loading,   setLoading]   = useState(false);
  const [deleting,  setDeleting]  = useState(false);
  const [preflight, setPreflight] = useState<DeletePreflight | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  // Fetch preflight whenever modal opens with a userId
  useEffect(() => {
    if (!visible || !userId) return;
    setPreflight(null);
    setError(null);
    setLoading(true);
    getDeletePreflight(userId)
      .then(data => setPreflight(data))
      .catch(e  => setError(logAndParse(e, 'delete.preflight')))
      .finally(() => setLoading(false));
  }, [visible, userId]);

  const handleDelete = async () => {
    if (!userId) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteUser(userId, 'Permanent delete by admin');
      onDeleted(userId);
    } catch (e) {
      setError(logAndParse(e, 'delete.execute'));
    } finally {
      setDeleting(false);
    }
  };

  const handleClose = () => {
    if (deleting) return;
    onClose();
  };

  // ── Row helper ──────────────────────────────────────────────────────────────
  type InfoRowProps = {
    icon: React.ReactNode;
    label: string;
    value: string;
    danger?: boolean;
  };
  const InfoRow = ({ icon, label, value, danger }: InfoRowProps) => (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: `${c.text}10`,
    }}>
      <View style={[flat, {
        width: 34, height: 34, borderRadius: 10,
        alignItems: 'center', justifyContent: 'center',
      }]}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: `${c.text}55` }}>{label}</Text>
        <Text style={{
          fontSize: 14, fontWeight: '600',
          color: danger ? '#EF4444' : c.text,
        }}>
          {value}
        </Text>
      </View>
    </View>
  );

  const roleColor = ROLE_COLOR[preflight?.role ?? ''] ?? c.primary;
  const roleLabel = (preflight?.role ?? '').replace('_', ' ').toUpperCase();

  // Blocking conditions the EF will also enforce — shown proactively
  const blockingReason = preflight
    ? preflight.role === 'super_admin' && !preflight.email
      ? null  // only EF knows if it's the last super_admin
    : preflight.role === 'doctor' && preflight.active_courses > 0
      ? `This doctor has ${preflight.active_courses} active course(s). Archive or transfer them first.`
    : null
    : null;

  const canDelete = !loading && !blockingReason && !!preflight;

  return (
    <ResponsiveModal
      visible={visible}
      onClose={handleClose}
      title="Delete Account"
      subtitle="This action is permanent and cannot be undone"
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <NeuButton
            label="Cancel"
            onPress={handleClose}
            variant="secondary"
            style={{ flex: 1 }}
            disabled={deleting}
          />
          <NeuButton
            label="Delete Permanently"
            onPress={handleDelete}
            loading={deleting}
            variant="danger"
            style={{ flex: 1 }}
            disabled={!canDelete || deleting}
            icon={<Trash2 size={15} color="#fff" />}
          />
        </View>
      }
    >
      <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 480 }}>
        {/* Loading */}
        {loading && (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={{ color: `${c.text}66`, marginTop: 12, fontSize: 14 }}>
              Loading account details…
            </Text>
          </View>
        )}

        {/* Preflight error */}
        {!loading && error && !preflight && (
          <View style={[flat, {
            borderRadius: 14, padding: 14, marginBottom: 12,
            flexDirection: 'row', gap: 10, alignItems: 'flex-start',
          }]}>
            <AlertTriangle size={18} color="#EF4444" style={{ marginTop: 1 }} />
            <Text style={{ flex: 1, fontSize: 14, color: '#EF4444' }}>{error}</Text>
          </View>
        )}

        {/* Account summary */}
        {!loading && preflight && (
          <View style={{ gap: 12 }}>
            {/* Role pill */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <View style={{
                backgroundColor: `${roleColor}20`, borderRadius: 10,
                paddingHorizontal: 12, paddingVertical: 4,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: roleColor }}>{roleLabel}</Text>
              </View>
            </View>

            {/* Account details */}
            <View style={[flat, { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 4 }]}>
              <InfoRow
                icon={<User size={16} color={c.primary} />}
                label="Full Name"
                value={preflight.full_name}
              />
              {preflight.email && !preflight.email.includes('@medacademy.internal') && (
                <InfoRow
                  icon={<Mail size={16} color={c.primary} />}
                  label="Email"
                  value={preflight.email}
                />
              )}
              {preflight.phone && (
                <InfoRow
                  icon={<Phone size={16} color={c.primary} />}
                  label="Phone"
                  value={displayPhoneNational(preflight.phone)}
                />
              )}
              {preflight.role === 'doctor' && (
                <InfoRow
                  icon={<BookOpen size={16} color={preflight.active_courses > 0 ? '#EF4444' : c.primary} />}
                  label="Active Courses"
                  value={String(preflight.active_courses)}
                  danger={preflight.active_courses > 0}
                />
              )}
              {preflight.credits_remaining > 0 && (
                <InfoRow
                  icon={<CreditCard size={16} color={c.primary} />}
                  label="Credits Remaining"
                  value={String(preflight.credits_remaining)}
                />
              )}
              <InfoRow
                icon={<Smartphone size={16} color={c.primary} />}
                label="Registered Devices"
                value={String(preflight.devices)}
              />
              {preflight.active_enrollments > 0 && preflight.role === 'student' && (
                <InfoRow
                  icon={<BookOpen size={16} color={c.primary} />}
                  label="Active Enrollments"
                  value={String(preflight.active_enrollments)}
                />
              )}
            </View>

            {/* Blocking warning */}
            {blockingReason && (
              <View style={[flat, {
                borderRadius: 14, padding: 14,
                flexDirection: 'row', gap: 10, alignItems: 'flex-start',
                borderWidth: 1, borderColor: '#EF444430',
              }]}>
                <AlertTriangle size={18} color="#EF4444" style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, fontSize: 13, color: '#EF4444', lineHeight: 20 }}>
                  {blockingReason}
                </Text>
              </View>
            )}

            {/* Final warning */}
            {!blockingReason && (
              <View style={[flat, {
                borderRadius: 14, padding: 14,
                flexDirection: 'row', gap: 10, alignItems: 'flex-start',
                borderWidth: 1, borderColor: '#EF444420',
              }]}>
                <Shield size={18} color="#EF4444" style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, fontSize: 13, color: c.text, lineHeight: 20 }}>
                  <Text style={{ fontWeight: '700', color: '#EF4444' }}>Warning: </Text>
                  This action permanently deletes this account and{' '}
                  <Text style={{ fontWeight: '700' }}>cannot be undone</Text>.
                  All devices, sessions, enrollments, and data will be removed immediately.
                </Text>
              </View>
            )}

            {/* Post-delete execution error */}
            {error && (
              <View style={[flat, {
                borderRadius: 14, padding: 14,
                flexDirection: 'row', gap: 10, alignItems: 'flex-start',
              }]}>
                <AlertTriangle size={18} color="#EF4444" style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, fontSize: 13, color: '#EF4444' }}>{error}</Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </ResponsiveModal>
  );
}
