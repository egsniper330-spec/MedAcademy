/**
 * Redeem Codes — Super Admin management for the Credit Redeem Code system.
 *
 * Credit Redeem Code is a CREDIT TOP-UP system ONLY: super admin mints a code
 * carrying a credit amount, an eligible doctor redeems it and the amount is
 * added to the doctor's existing credit balance. Codes never activate courses
 * and never enroll students.
 *
 * Features: create (amount / optional doctor assignment / optional expiry),
 * list with status filter + search, copy code, revoke unused codes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, Pressable,
  ActivityIndicator, RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Ticket, Copy, Plus, Search, X, User, RefreshCw, Trash2, CalendarClock, CheckCircle,
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import {
  getRedeemCodes, createRedeemCode, revokeRedeemCode, archiveRedeemCode, getDoctors,
  type RedeemCode,
} from '@/lib/api';
import { friendlyError } from '@/lib/validation';
import { useDebounce } from '@/lib/useDebounce';

const STATUS_FILTERS = ['all', 'unused', 'redeemed', 'expired', 'revoked'] as const;

const STATUS_META: Record<string, { label: string; color: string }> = {
  unused:   { label: 'Unused',   color: '#2DA8FF' },
  redeemed: { label: 'Redeemed', color: '#16A34A' },
  expired:  { label: 'Expired',  color: '#D97706' },
  revoked:  { label: 'Revoked',  color: '#DC2626' },
};

function fmt(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function RedeemCodesScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [rows, setRows] = useState<RedeemCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Create modal state
  const [createModal, setCreateModal] = useState(false);
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [doctorQuery, setDoctorQuery] = useState('');
  const [selectedDoctor, setSelectedDoctor] = useState<{ id: string; full_name: string } | null>(null);
  const [doctors, setDoctors] = useState<{ id: string; full_name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdCodes, setCreatedCodes] = useState<RedeemCode[]>([]);

  // Parsed creation inputs for the live preview.
  const qtyNum = Math.max(1, Math.min(200, parseInt(quantity, 10) || 1));
  const amtNum = parseInt(amount, 10) || 0;
  const validAmount = Number.isInteger(amtNum) && amtNum > 0;

  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5,
    fontSize: 14, color: c.text,
  } as const;

  const load = useCallback(async () => {
    try {
      const res = await getRedeemCodes({ status: statusFilter, search: debouncedSearch });
      setRows((res as { redeem_codes?: RedeemCode[] })?.redeem_codes ?? []);
    } catch { /* keep last known */ }
    setLoading(false);
  }, [statusFilter, debouncedSearch]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  useEffect(() => { if (!loading) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [statusFilter, debouncedSearch]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: rows.length, unused: 0, redeemed: 0, expired: 0, revoked: 0 };
    for (const r of rows) m[r.status] = (m[r.status] ?? 0) + 1;
    return m;
  }, [rows]);

  const openCreate = async () => {
    setAmount(''); setQuantity('1'); setExpiry(''); setDoctorQuery(''); setSelectedDoctor(null); setCreatedCodes([]);
    setCreateModal(true);
    try {
      const docs = await getDoctors();
      setDoctors(
        (docs as { id: string; full_name: string }[]).map(d => ({ id: d.id, full_name: d.full_name })),
      );
    } catch { setDoctors([]); }
  };

  const handleCreate = async () => {
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt <= 0) {
      showToast({ type: 'error', message: 'Enter a valid positive credit amount.' });
      return;
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 200) {
      showToast({ type: 'error', message: 'Number of codes must be between 1 and 200.' });
      return;
    }
    if (expiry.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(expiry.trim())) {
      showToast({ type: 'error', message: 'Expiry must be YYYY-MM-DD (or leave empty).' });
      return;
    }
    setCreating(true);
    try {
      const res = await createRedeemCode({
        credit_amount: amt,
        quantity: qty,
        assigned_doctor_id: selectedDoctor?.id ?? null,
        expires_at: expiry.trim() !== '' ? `${expiry.trim()}T23:59:59Z` : null,
      });
      setCreateModal(false);
      setCreatedCodes(res.redeem_codes ?? [res.redeem_code]);
      await load();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Could not create the redeem code(s).') });
    }
    setCreating(false);
  };

  // Revoke on an UNUSED code = permanent delete (audit log keeps evidence).
  const handleRevoke = async (row: RedeemCode) => {
    try {
      await revokeRedeemCode(row.id);
      showToast({ type: 'success', message: `Code ${row.code} permanently removed.` });
      await load();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Could not remove the redeem code.') });
    }
  };

  // Remove on a REDEEMED code = archive (hide; financial history intact).
  const [archiveTarget, setArchiveTarget] = useState<RedeemCode | null>(null);
  const [archiving, setArchiving] = useState(false);
  const handleArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await archiveRedeemCode(archiveTarget.id);
      showToast({ type: 'success', message: `Code ${archiveTarget.code} removed from the active list. History preserved.` });
      setArchiveTarget(null);
      await load();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Could not remove the redeem code.') });
    }
    setArchiving(false);
  };

  const copyCode = async (code: string) => {
    await Clipboard.setStringAsync(code);
    showToast({ type: 'success', message: 'Code copied.' });
  };

  const filteredDoctors = useMemo(() => {
    const q = doctorQuery.trim().toLowerCase();
    if (!q) return doctors.slice(0, 30);
    return doctors.filter(d => d.full_name?.toLowerCase().includes(q)).slice(0, 30);
  }, [doctors, doctorQuery]);

  const chip = (active: boolean) => ({
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    backgroundColor: active ? c.primary : c.base,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 5,
  });

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
      >
        <View style={{ padding: layout.screenPx, paddingBottom: 40 }}>
          <PageHeader title="Redeem Codes" subtitle="Credit top-up codes for doctors" accentColor="#7C3AED" />

          {/* Toolbar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 12 }}>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
              <Search size={14} color={`${c.text}55`} />
              <TextInput
                value={search} onChangeText={setSearch}
                placeholder="Search code, doctor, ID..."
                placeholderTextColor={`${c.text}55`}
                style={{ ...inp, flex: 1, minWidth: 0, paddingLeft: 34 }}
              />
              {search !== '' && (
                <Pressable onPress={() => setSearch('')} hitSlop={8}>
                  <X size={13} color={`${c.text}55`} />
                </Pressable>
              )}
            </View>
            <NeuButton label="New Code" icon={<Plus size={14} color="#fff" />} onPress={openCreate} />
          </View>

          {/* Status filter chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
            {STATUS_FILTERS.map(s => (
              <Pressable key={s} onPress={() => setStatusFilter(s)} style={chip(statusFilter === s)}>
                <Text style={{ fontSize: 11, fontWeight: '600', color: statusFilter === s ? '#fff' : c.text }}>
                  {s === 'all' ? 'All' : STATUS_META[s].label}
                  {s !== 'all' && counts[s] !== undefined && counts[s] !== null && counts[s] > 0 ? ` (${counts[s]})` : ''}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 30 }} />}

          {/* Code list */}
          {!loading && rows.map(row => {
            const meta = STATUS_META[row.status] ?? STATUS_META.unused;
            const inactive = row.status === 'redeemed'; // no longer usable → struck through
            return (
              <NeuCard key={row.id} style={{ padding: 14, marginBottom: 12, opacity: inactive ? 0.72 : 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${meta.color}18`,
                    alignItems: 'center', justifyContent: 'center' }}>
                    <Ticket size={18} color={meta.color} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Text
                        selectable={!inactive}
                        style={{
                          fontSize: 15, fontWeight: '800', color: c.text, letterSpacing: 0.5,
                          textDecorationLine: inactive ? 'line-through' : 'none',
                          opacity: inactive ? 0.55 : 1,
                        }}
                      >
                        {row.code}
                      </Text>
                      {!inactive && (
                        <Pressable onPress={() => { void copyCode(row.code); }} hitSlop={6}>
                          <Copy size={14} color={c.primary} />
                        </Pressable>
                      )}
                      {inactive && (
                        <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.45, letterSpacing: 0.6 }}>
                          INACTIVE
                        </Text>
                      )}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#16A34A' }}>+{row.credit_amount} credits</Text>
                      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: `${meta.color}20` }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: meta.color }}>{meta.label}</Text>
                      </View>
                    </View>
                    {row.assigned_doctor_name && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, marginTop: 4 }}>
                        For: {row.assigned_doctor_name} ({row.assigned_doctor_public_id ?? '—'})
                      </Text>
                    )}
                    {row.status === 'redeemed' && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, marginTop: 4 }}>
                        Redeemed by {row.redeemed_by_name ?? '—'} · {fmt(row.redeemed_at)}
                      </Text>
                    )}
                    {row.expires_at && row.status !== 'redeemed' && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 4 }}>
                        Expires: {fmt(row.expires_at)}
                      </Text>
                    )}
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.35, marginTop: 4 }}>Created: {fmt(row.created_at)}</Text>
                  </View>
                  {row.status === 'unused' && (
                    <Pressable
                      onPress={() => handleRevoke(row)}
                      accessibilityLabel="Permanently remove unused redeem code"
                      accessibilityRole="button"
                      style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: '#DC262618',
                        alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Trash2 size={15} color="#DC2626" />
                    </Pressable>
                  )}
                  {row.status === 'redeemed' && (
                    <Pressable
                      onPress={() => setArchiveTarget(row)}
                      accessibilityLabel="Remove redeemed code from active list"
                      accessibilityRole="button"
                      style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: '#DC262618',
                        alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Trash2 size={15} color="#DC2626" opacity={0.7} />
                    </Pressable>
                  )}
                </View>
              </NeuCard>
            );
          })}

          {!loading && rows.length === 0 && (
            <NeuCard style={{ padding: 40, alignItems: 'center' }}>
              <Ticket size={38} color={c.primary} opacity={0.2} />
              <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No redeem codes found</Text>
            </NeuCard>
          )}
        </View>
      </ScrollView>

      {/* Create modal */}
      <ResponsiveModal
        visible={createModal} onClose={() => setCreateModal(false)}
        title="New Redeem Code"
        subtitle="Credit top-up code for a doctor"
        icon={<Ticket size={18} color="#7C3AED" />}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setCreateModal(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Create" onPress={handleCreate} loading={creating} disabled={creating} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Credits per Code
        </Text>
        <TextInput
          value={amount} onChangeText={setAmount}
          placeholder="e.g. 50" placeholderTextColor={`${c.text}55`}
          keyboardType="number-pad" style={{ ...inp, marginBottom: 14 }}
        />

        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Number of Codes
        </Text>
        <TextInput
          value={quantity} onChangeText={setQuantity}
          placeholder="1" placeholderTextColor={`${c.text}55`}
          keyboardType="number-pad" style={{ ...inp, marginBottom: 14 }}
        />

        {/* Live preview — credits are PER CODE, never pooled into one code. */}
        {validAmount && (
          <NeuCard style={{ padding: 12, marginBottom: 14, backgroundColor: '#7C3AED10' }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
              {qtyNum} code{qtyNum > 1 ? 's' : ''} × {amtNum} credits each
            </Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 2 }}>
              Total: {qtyNum * amtNum} credits · {qtyNum > 1 ? `${qtyNum} separate redeem codes` : '1 redeem code'}
            </Text>
          </NeuCard>
        )}

        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Expires (optional)
        </Text>
        <TextInput
          value={expiry} onChangeText={setExpiry}
          placeholder="YYYY-MM-DD" placeholderTextColor={`${c.text}55`}
          autoCapitalize="none" style={{ ...inp, marginBottom: 14 }}
        />

        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Assign to Doctor (optional)
        </Text>
        {selectedDoctor ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <User size={16} color={c.primary} />
            <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: c.text }}>{selectedDoctor.full_name}</Text>
            <Pressable onPress={() => setSelectedDoctor(null)} hitSlop={8}>
              <X size={15} color="#DC2626" />
            </Pressable>
          </View>
        ) : (
          <>
            <TextInput
              value={doctorQuery} onChangeText={setDoctorQuery}
              placeholder="Search doctors..." placeholderTextColor={`${c.text}55`}
              style={{ ...inp, marginBottom: 8 }}
            />
            <ScrollView style={{ maxHeight: 180, marginBottom: 14 }} nestedScrollEnabled>
              {filteredDoctors.map(d => (
                <Pressable
                  key={d.id} onPress={() => setSelectedDoctor(d)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
                    borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}
                >
                  <User size={14} color={`${c.text}55`} />
                  <Text style={{ flex: 1, fontSize: 13, color: c.text }}>{d.full_name}</Text>
                </Pressable>
              ))}
              {filteredDoctors.length === 0 && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, paddingVertical: 10 }}>No doctors found</Text>
              )}
            </ScrollView>
          </>
        )}
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
          Leave empty for a code any doctor can redeem.
        </Text>
      </ResponsiveModal>

      {/* Created-success modal — single code or whole batch */}
      <ResponsiveModal
        visible={createdCodes.length > 0} onClose={() => setCreatedCodes([])}
        title={createdCodes.length > 1 ? `Created ${createdCodes.length} Redeem Codes` : 'Redeem Code Created'}
        icon={<CheckCircle size={18} color="#16A34A" />}
        footer={
          <NeuButton label="Done" onPress={() => setCreatedCodes([])} style={{ flex: 1 }} />
        }
      >
        {createdCodes.length > 0 && (
          <>
            <NeuCard style={{ padding: 14, marginBottom: 12, backgroundColor: '#16A34A10' }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#16A34A' }}>
                Each: {createdCodes[0].credit_amount} credits
              </Text>
              {createdCodes.length > 1 && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 2 }}>
                  Total potential: {createdCodes.length * createdCodes[0].credit_amount} credits
                </Text>
              )}
              {createdCodes[0].assigned_doctor_name && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 2 }}>
                  Assigned: {createdCodes[0].assigned_doctor_name}
                </Text>
              )}
              {createdCodes[0].expires_at && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 2 }}>
                  Expires: {fmt(createdCodes[0].expires_at)}
                </Text>
              )}
            </NeuCard>
            <ScrollView style={{ maxHeight: 320, marginBottom: 8 }} nestedScrollEnabled>
              {createdCodes.map((cd, idx) => (
                <View
                  key={cd.id ?? idx}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}
                >
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, width: 20 }}>
                    {idx + 1}
                  </Text>
                  <Text selectable style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: '800', color: c.primary, letterSpacing: 0.5 }}>
                    {cd.code}
                  </Text>
                  <Pressable onPress={() => { void copyCode(cd.code); }} hitSlop={6} accessibilityLabel={`Copy code ${idx + 1}`}>
                    <Copy size={15} color={c.primary} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            {createdCodes.length > 1 && (
              <NeuButton
                label="Copy All Codes"
                icon={<Copy size={14} color="#fff" />}
                onPress={() => { void copyCode(createdCodes.map(cd => cd.code).join('\n')); }}
                style={{ marginTop: 8 }}
              />
            )}
          </>
        )}
      </ResponsiveModal>

      {/* Remove redeemed code — confirmation (archive: history preserved) */}
      <ResponsiveModal
        visible={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title="Remove Redeemed Code?"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setArchiveTarget(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Remove" onPress={handleArchive} loading={archiving} disabled={archiving} style={{ flex: 1 }} />
          </View>
        }
      >
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, textDecorationLine: 'line-through', opacity: 0.7 }}>
            {archiveTarget?.code}
          </Text>
          <Text style={{ fontSize: 14, color: c.text, opacity: 0.7, lineHeight: 21 }}>
            This code was already redeemed — it can never be used again. Removing it hides it from the active list, but the redemption record and credit history are permanently preserved.
          </Text>
        </View>
      </ResponsiveModal>
    </View>
  );
}
