/**
 * Activation Codes — full batch generator + inline batch management.
 * Replaces the old simple "Generate Code" dialog and the separate Batch Management page.
 */
import { useCallback, useState, useMemo } from 'react';
import {
  View, Text, ScrollView, FlatList, Pressable, TextInput,
  ActivityIndicator, RefreshControl, useColorScheme,
  KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Ticket, Plus, CheckCircle, Clock, XCircle, UserCheck, Trash2,
  Square, SquareCheck, ToggleLeft, ToggleRight, ChevronRight,
  ChevronDown, Copy, AlertCircle, Layers, Hash, BookOpen,
  Calendar, FileText, Info, Download, Search, X, MoreVertical,
  Eye, FilePlus, FileSpreadsheet, FileDown,
} from 'lucide-react-native';
import DateTimePicker from 'react-native-ui-datepicker';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout , zIndex} from '@/lib/neu';
import { useProfileStore } from '@/lib/store';
import { UserSearchInput, type SearchedUser } from '@/components/UserSearchInput';
import { displayPhoneNational } from '@/lib/phone';
import {
  getActivationCodes, deactivateActivationCode, deleteActivationCode,
  reactivateActivationCode, bulkDeleteActivationCodes, bulkDisableActivationCodes,
  bulkEnableActivationCodes, getCourses, getContactDisplay, getCodeBatches,
  getActivationLedger, invokeEdgeFunction, batchCreateActivationCodes,
} from '@/lib/api';
import { backendApiBase, backendClient } from '@/client/backendClient';
import { validateRequired, friendlyError } from '@/lib/validation';
import { useDebounce } from '@/lib/useDebounce';
import {
  exportCSV, exportXLSX, BATCH_CODE_COLUMNS, buildExportFilename,
} from '@/lib/exportUtils';

// ── Types ──────────────────────────────────────────────────────────────────
type Batch = {
  id: string; label: string | null; course_id: string; created_by: string;
  total_count: number; used_count: number; expired_count: number; disabled_count: number;
  expires_at: string | null; notes: string | null; created_at: string;
  prefix: string | null; max_uses: number | null;
  course?: { title: string };
  creator?: { full_name: string; role: string };
};
type CodeRow = {
  id: string; code: string; status: string; created_at: string;
  used_by_name: string | null; used_at: string | null; expires_at: string | null;
  notes: string | null; max_uses: number | null; uses_count: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────
function statusColor(s: string) {
  if (s === 'used' || s === 'active' && false) return '#16A34A';
  if (s === 'active')   return '#2DA8FF';
  if (s === 'expired')  return '#D97706';
  if (s === 'disabled' || s === 'deactivated') return '#DC2626';
  return '#6B7280';
}
function codeStatusBg(s: string)    { return `${statusColor(s)}20`; }
function codeStatusColor(s: string) { return statusColor(s); }

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtShort(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Batch Generator Form ────────────────────────────────────────────────────
const MAX_USES_PRESETS = [1, 5, 10, 25, 50];

function BatchGeneratorModal({
  visible, onClose, courses, c, isDark, onSuccess,
}: {
  visible: boolean; onClose: () => void;
  courses: any[]; c: typeof neuColors.light; isDark: boolean;
  onSuccess: () => void;
}) {
  const { showToast } = useToast();

  // Fields
  const [courseId, setCourseId]       = useState('');
  const [batchName, setBatchName]     = useState('');
  const [count, setCount]             = useState('10');
  const [prefix, setPrefix]           = useState('');
  const [maxUses, setMaxUses]         = useState<number | 'unlimited'>(1);
  const [expiry, setExpiry]           = useState<'never' | 'date'>('never');
  const [expiryDate, setExpiryDate]   = useState<Date>(new Date(Date.now() + 30 * 86400000));
  const [notes, setNotes]             = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [generating, setGenerating]   = useState(false);
  const [errors, setErrors]           = useState<Record<string, string>>({});
  const [isDirty, setIsDirty]         = useState(false);
  const [showCourseSheet, setShowCourseSheet] = useState(false);
  const [showExpiryPicker, setShowExpiryPicker] = useState(false);

  const selectedCourse = courses.find(c => c.id === courseId);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!courseId)       e.courseId  = 'Required';
    if (!batchName.trim()) e.batchName = 'Required';
    const n = parseInt(count, 10);
    if (isNaN(n) || n < 1 || n > 500) e.count = '1–500';
    if (prefix && !/^[A-Za-z0-9]{1,8}$/.test(prefix)) e.prefix = 'Max 8 chars';
    return e;
  };

  const handleNext = () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setErrors({});
    setShowSummary(true);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const expiresAt = expiry === 'date'
        ? `${expiryDate.getFullYear()}-${String(expiryDate.getMonth() + 1).padStart(2, '0')}-${String(expiryDate.getDate()).padStart(2, '0')}T23:59:59Z`
        : undefined;
      await batchCreateActivationCodes(courseId, parseInt(count, 10), {
        batchLabel: batchName.trim(),
        notes: notes.trim() || undefined,
        prefix: prefix.trim() || undefined,
        maxUses,
        expiresAt,
      });
      showToast({ type: 'success', message: `${count} codes generated successfully.` });
      handleClose();
      onSuccess();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to generate codes.') });
    }
    setGenerating(false);
  };

  const handleClose = () => {
    setCourseId(''); setBatchName(''); setCount('10'); setPrefix('');
    setMaxUses(1); setExpiry('never'); setNotes('');
    setShowSummary(false); setShowCourseSheet(false); setShowExpiryPicker(false);
    setErrors({}); setIsDirty(false);
    onClose();
  };

  const previewCodes = useMemo(() => {
    const pfx = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return Array.from({ length: 3 }, () => {
      const token = Math.random().toString(36).substring(2, 9).toUpperCase();
      return pfx ? `${pfx}-${token}` : token;
    });
  }, [prefix]);

  const expiryLabel = expiry === 'never'
    ? 'Never Expires'
    : `${expiryDate.getFullYear()}-${String(expiryDate.getMonth() + 1).padStart(2, '0')}-${String(expiryDate.getDate()).padStart(2, '0')}`;

  const maxUsesLabel = maxUses === 'unlimited' ? 'Unlimited' : String(maxUses);

  // ── Shared styles ──────────────────────────────────────────────────────────
  const fieldBg = {
    backgroundColor: c.base,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    shadowColor: c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 6,
  };
  const dropdownStyle = {
    ...fieldBg,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
  };
  const inp = {
    ...fieldBg,
    fontSize: 14,
    color: c.text,
  };

  const FieldLabel = ({ text, error }: { text: string; error?: string }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.55 }}>{text}</Text>
      {error && <Text style={{ fontSize: 11, color: '#DC2626', fontWeight: '600' }}>{error}</Text>}
    </View>
  );

  const SummaryRow = ({ label, value }: { label: string; value: string }) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9,
      borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, flex: 1, textAlign: 'right' }}>{value}</Text>
    </View>
  );

  if (!visible) return null;

  return (
    <ResponsiveModal
      visible={visible}
      onClose={handleClose}
      isDirty={isDirty}
      title={showSummary ? 'Review & Generate' : 'Create Code Batch'}
      footer={
        showSummary ? (
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="← Back" onPress={() => setShowSummary(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton
              label={generating ? 'Generating...' : `Generate ${count} Codes`}
              onPress={handleGenerate} loading={generating} style={{ flex: 2 }} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={handleClose} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Create Batch" onPress={handleNext} style={{ flex: 2 }} />
          </View>
        )
      }
    >
      {showSummary ? (
        // ── Summary screen ───────────────────────────────────────────────────
        <View>
          <NeuCard style={{ padding: 16, marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${c.primary}18`,
                alignItems: 'center', justifyContent: 'center' }}>
                <Layers size={22} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }}>{batchName}</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{selectedCourse?.title ?? '—'}</Text>
              </View>
            </View>
          </NeuCard>
          <SummaryRow label="Course"               value={selectedCourse?.title ?? '—'} />
          <SummaryRow label="Batch Name"           value={batchName} />
          <SummaryRow label="Number of Codes"      value={count} />
          <SummaryRow label="Code Prefix"          value={prefix.trim() ? prefix.trim().toUpperCase() : 'None'} />
          <SummaryRow label="Activations Per Code" value={maxUsesLabel} />
          <SummaryRow label="Expiration"           value={expiryLabel} />
          {notes.trim() && <SummaryRow label="Notes" value={notes.trim()} />}
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4,
            marginTop: 20, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
            SAMPLE CODES
          </Text>
          <NeuCard style={{ padding: 14 }}>
            {previewCodes.map((code, i) => (
              <Text key={i} style={{ fontSize: 14, fontWeight: '700', color: c.primary,
                letterSpacing: 1.5, paddingVertical: 4, fontFamily: 'monospace' }}>{code}</Text>
            ))}
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 6 }}>
              + {Math.max(0, parseInt(count, 10) - 3)} more unique codes
            </Text>
          </NeuCard>
        </View>
      ) : (
        // ── Form screen — reference layout ──────────────────────────────────
        <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>

          {/* Row 1: Batch Name (full width) */}
          <FieldLabel text="Batch Name" error={errors.batchName} />
          <TextInput
            value={batchName}
            onChangeText={v => { setBatchName(v); setIsDirty(true); }}
            placeholder="e.g. Summer 2026 Promo"
            placeholderTextColor={`${c.text}45`}
            style={[inp, { minWidth: 0 }]}
          />

          {/* Row 2: Course | Number of Codes */}
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel text="Course" error={errors.courseId} />
              <Pressable onPress={() => setShowCourseSheet(v => !v)} style={dropdownStyle}>
                <Text style={{ fontSize: 14, color: selectedCourse ? c.text : `${c.text}45`, flex: 1 }}
                  numberOfLines={1}>
                  {selectedCourse?.title ?? 'Select Course'}
                </Text>
                <ChevronDown size={16} color={`${c.text}60`} />
              </Pressable>
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel text="Number of Codes" error={errors.count} />
              <TextInput
                value={count}
                onChangeText={v => { setCount(v); setIsDirty(true); }}
                placeholder="1"
                placeholderTextColor={`${c.text}45`}
                keyboardType="numeric"
                style={[inp, { minWidth: 0 }]}
              />
            </View>
          </View>

          {/* Course dropdown sheet (inline) */}
          {showCourseSheet && (
            <NeuCard style={{ marginTop: 4, padding: 6, maxHeight: 180, overflow: 'hidden' }}>
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 168 }}>
                {courses.map(course => (
                  <Pressable key={course.id}
                    onPress={() => { setCourseId(course.id); setIsDirty(true); setShowCourseSheet(false); }}
                    style={{ paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10,
                      backgroundColor: courseId === course.id ? `${c.primary}14` : 'transparent' }}>
                    <Text style={{ fontSize: 14, fontWeight: courseId === course.id ? '700' : '400',
                      color: courseId === course.id ? c.primary : c.text }}>
                      {course.title}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </NeuCard>
          )}

          {/* Row 3: Code Prefix | Activations Per Code */}
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel text="Code Prefix (Optional)" error={errors.prefix} />
              <TextInput
                value={prefix}
                onChangeText={v => { setPrefix(v); setIsDirty(true); }}
                placeholder="E.G. MED-"
                placeholderTextColor={`${c.text}45`}
                autoCapitalize="characters"
                style={[inp, { minWidth: 0 }]}
              />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel text="Max Activations Per Code" />
              <Pressable
                onPress={() => {
                  // Cycle through presets: 1 → 5 → 10 → 25 → 50 → unlimited → 1
                  const cycle: (number | 'unlimited')[] = [...MAX_USES_PRESETS, 'unlimited'];
                  const idx = cycle.indexOf(maxUses as number);
                  setMaxUses(cycle[(idx + 1) % cycle.length]);
                  setIsDirty(true);
                }}
                style={dropdownStyle}
              >
                <Text style={{ fontSize: 14, color: c.text, flex: 1 }}>{maxUsesLabel}</Text>
                <ChevronDown size={16} color={`${c.text}60`} />
              </Pressable>
            </View>
          </View>

          {/* Prefix preview chips */}
          {prefix.trim().length > 0 && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {previewCodes.slice(0, 2).map((code, i) => (
                <View key={i} style={{ paddingHorizontal: 10, paddingVertical: 4,
                  borderRadius: 8, backgroundColor: `${c.primary}12` }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary, letterSpacing: 0.8 }}>{code}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Row 4: (Max Activations already in row 3) | Expiration */}
          <View style={{ marginTop: 18 }}>
            <FieldLabel text="Expiration" />
            <Pressable
              onPress={() => {
                if (expiry === 'never') {
                  setExpiry('date'); setShowExpiryPicker(true);
                } else {
                  setExpiry('never'); setShowExpiryPicker(false);
                }
                setIsDirty(true);
              }}
              style={dropdownStyle}
            >
              <Calendar size={15} color={`${c.text}60`} style={{ marginRight: 8 }} />
              <Text style={{ fontSize: 14, color: c.text, flex: 1 }}>{expiryLabel}</Text>
              <ChevronDown size={16} color={`${c.text}60`} />
            </Pressable>
          </View>
          {expiry === 'date' && showExpiryPicker && (
            <NeuCard style={{ padding: 8, marginTop: 6, marginBottom: 4 }}>
              <DateTimePicker
                mode="single"
                date={expiryDate}
                onChange={({ date }) => { if (date) { setExpiryDate(date as Date); setIsDirty(true); } }}
                minDate={new Date()}
                styles={{ selected: { backgroundColor: c.primary }, selected_label: { color: '#fff' } }}
              />
            </NeuCard>
          )}

          {/* Row 5: Notes (full width) */}
          <View style={{ marginTop: 18 }}>
            <FieldLabel text="Notes (Optional)" />
            <TextInput
              value={notes}
              onChangeText={v => { setNotes(v); setIsDirty(true); }}
              placeholder="Internal notes about this batch..."
              placeholderTextColor={`${c.text}45`}
              multiline
              style={{ ...inp, minHeight: 80, textAlignVertical: 'top' }}
            />
          </View>

        </KeyboardAvoidingView>
      )}
    </ResponsiveModal>
  );
}

// ── Batch Codes Modal ───────────────────────────────────────────────────────
function BatchCodesModal({
  batch, visible, onClose, c, isDark,
}: {
  batch: Batch | null; visible: boolean; onClose: () => void;
  c: typeof neuColors.light; isDark: boolean;
}) {
  const [codes, setCodes]       = useState<CodeRow[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const debouncedSearch         = useDebounce(search, 250);

  // Load codes whenever the modal opens for a batch
  useMemo(() => {
    if (!visible || !batch) { setCodes([]); setSearch(''); return; }
    setLoading(true);
    getActivationLedger({ batchId: batch.id, limit: 500 })
      .then(rows => { setCodes(rows as CodeRow[]); })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, batch?.id]);

  const filtered = useMemo(() => {
    if (!debouncedSearch) return codes;
    const q = debouncedSearch.toLowerCase();
    return codes.filter(r =>
      r.code?.toLowerCase().includes(q) ||
      r.status?.toLowerCase().includes(q) ||
      r.used_by_name?.toLowerCase().includes(q)
    );
  }, [codes, debouncedSearch]);

  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5,
    fontSize: 13, color: c.text, flex: 1,
  } as const;

  if (!batch) return null;
  const batchLabel = batch.label ?? `Batch ${batch.id.slice(0, 8)}`;

  return (
    <ResponsiveModal
      visible={visible}
      onClose={onClose}
      title="Batch Codes"
      subtitle={batchLabel}
    >
      {/* Batch summary strip */}
      <NeuCard style={{ padding: 12, marginBottom: 16, flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#16A34A' }}>{batch.used_count}</Text>
          <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Used</Text>
        </View>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#2DA8FF' }}>
            {Math.max(0, batch.total_count - batch.used_count - batch.disabled_count - batch.expired_count)}
          </Text>
          <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Unused</Text>
        </View>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#DC2626' }}>{batch.disabled_count}</Text>
          <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Disabled</Text>
        </View>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.text }}>{batch.total_count}</Text>
          <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Total</Text>
        </View>
      </NeuCard>

      {/* Search */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
        <Search size={14} color={`${c.text}55`}  />
        <TextInput
          value={search} onChangeText={setSearch}
          placeholder="Search code, status, used by..."
          placeholderTextColor={`${c.text}55`}
          style={{ ...inp, paddingLeft: 36 }}
        />
        {search !== '' && (
          <Pressable onPress={() => setSearch('')} >
            <X size={13} color={`${c.text}55`} />
          </Pressable>
        )}
      </View>

      {/* Count label */}
      <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4,
        marginBottom: 8, letterSpacing: 0.8 }}>
        {loading ? 'LOADING…' : `${filtered.length} CODE${filtered.length !== 1 ? 'S' : ''}${codes.length >= 500 ? '+' : ''}`}
      </Text>

      {/* Code list */}
      {loading ? (
        <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />
      ) : filtered.length === 0 ? (
        <View style={{ padding: 40, alignItems: 'center' }}>
          <Ticket size={36} color={c.primary} opacity={0.2} />
          <Text style={{ color: c.text, opacity: 0.4, marginTop: 12 }}>No codes found</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          style={{ maxHeight: 420 }}
          renderItem={({ item: code }) => {
            const col = statusColor(code.status);
            return (
              <View style={{
                flexDirection: 'row', alignItems: 'center',
                paddingVertical: 10, borderBottomWidth: 1,
                borderBottomColor: `${c.text}07`, gap: 10,
              }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: col, flexShrink: 0 }} />
                <Text style={{ flex: 1, fontSize: 13, fontWeight: '700', color: c.text, letterSpacing: 0.8 }}>
                  {code.code}
                </Text>
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <View style={{ backgroundColor: codeStatusBg(code.status), borderRadius: 6,
                    paddingHorizontal: 7, paddingVertical: 2 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: col, textTransform: 'uppercase' }}>
                      {code.status}
                    </Text>
                  </View>
                  {code.used_by_name && (
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.45 }}>{code.used_by_name}</Text>
                  )}
                  {code.uses_count != null && code.uses_count > 0 && (
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>×{code.uses_count} uses</Text>
                  )}
                </View>
              </View>
            );
          }}
        />
      )}
    </ResponsiveModal>
  );
}

// ── Batch Card ──────────────────────────────────────────────────────────────
function BatchCard({
  batch, c, isDark, onAction, onViewCodes,
}: {
  batch: Batch; c: typeof neuColors.light; isDark: boolean;
  onAction: (type: string, batchId: string, label: string) => void;
  onViewCodes: (batch: Batch) => void;
}) {
    const layout = useLayout();
const [menuOpen, setMenuOpen] = useState(false);
  const unused  = Math.max(0, batch.total_count - batch.used_count - batch.disabled_count - batch.expired_count);
  const usedPct = batch.total_count > 0 ? Math.round((batch.used_count / batch.total_count) * 100) : 0;

  const menuItems: { label: string; type: string; icon: React.ReactNode; color: string; dividerAbove?: boolean }[] = [
    { label: 'View Codes',              type: 'view',         icon: <Eye size={14} color="#2DA8FF" />,              color: '#2DA8FF' },
    { label: 'Generate More Codes',     type: 'generate_more',icon: <FilePlus size={14} color="#7C3AED" />,         color: '#7C3AED' },
    { label: 'Export to Excel (.xlsx)', type: 'export_xlsx',  icon: <FileSpreadsheet size={14} color="#16A34A" />,  color: '#16A34A' },
    { label: 'Export to CSV (.csv)',    type: 'export_csv',   icon: <FileDown size={14} color="#16A34A" />,         color: '#16A34A' },
    { label: 'Duplicate Batch',         type: 'clone',        icon: <Copy size={14} color="#D97706" />,             color: '#D97706', dividerAbove: true },
    { label: 'Disable Entire Batch',    type: 'disable',      icon: <XCircle size={14} color="#DC2626" />,          color: '#DC2626' },
    { label: 'Delete Batch',            type: 'delete',       icon: <Trash2 size={14} color="#DC2626" />,           color: '#DC2626' },
  ];

  const batchLabel = batch.label ?? `Batch ${batch.id.slice(0, 8)}`;

  return (
    <View style={{ paddingHorizontal: layout.screenPx, marginBottom: 12 }}>
      <NeuCard style={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          {/* Card body — tap to view codes */}
          <Pressable onPress={() => onViewCodes(batch)}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: '#D97706' + '18',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Layers size={20} color="#D97706" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>{batchLabel}</Text>
              {batch.course?.title && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>{batch.course.title}</Text>
              )}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                {batch.prefix && (
                  <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: `${c.primary}14` }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary }}>{batch.prefix}-…</Text>
                  </View>
                )}
                {batch.max_uses && (
                  <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: '#7C3AED14' }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#7C3AED' }}>×{batch.max_uses}/code</Text>
                  </View>
                )}
                {batch.expires_at && (
                  <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: '#D9770614' }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#D97706' }}>exp {fmtShort(batch.expires_at)}</Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 4 }}>
                By {batch.creator?.full_name ?? '—'} · {fmt(batch.created_at)}
              </Text>

              {/* Progress bar */}
              <View style={{ marginTop: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>
                    {batch.used_count}/{batch.total_count} used · {unused} unused
                  </Text>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>{usedPct}%</Text>
                </View>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: `${c.text}10`, overflow: 'hidden' }}>
                  <View style={{ height: '100%', width: `${usedPct}%`, backgroundColor: '#16A34A', borderRadius: 3 }} />
                </View>
              </View>

              {/* Mini stats */}
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                <Text style={{ fontSize: 11, color: '#16A34A' }}>✓ {batch.used_count}</Text>
                <Text style={{ fontSize: 11, color: '#2DA8FF' }}>◦ {unused}</Text>
                <Text style={{ fontSize: 11, color: '#D97706' }}>⏱ {batch.expired_count}</Text>
                <Text style={{ fontSize: 11, color: '#DC2626' }}>✕ {batch.disabled_count}</Text>
              </View>

              {/* View codes hint */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
                <Eye size={11} color={c.primary} opacity={0.6} />
                <Text style={{ fontSize: 11, color: c.primary, opacity: 0.7, fontWeight: '600' }}>
                  Tap to view codes
                </Text>
              </View>
            </View>
          </Pressable>

          {/* 3-dot menu */}
          <View style={{ position: 'relative' }}>
            <Pressable onPress={() => setMenuOpen(v => !v)} hitSlop={8}
              style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                backgroundColor: menuOpen ? `${c.primary}18` : `${c.text}08` }}>
              <MoreVertical size={17} color={menuOpen ? c.primary : `${c.text}80`} />
            </Pressable>
            {menuOpen && (
              <View style={{
                position: 'absolute', top: 38, right: 0, minWidth: 180, maxWidth: 260, borderRadius: 16, zIndex: zIndex.loader,
                backgroundColor: c.base,
                shadowColor: c.shadowDark, shadowOffset: { width: 4, height: 8 },
                shadowOpacity: 0.25, shadowRadius: 16,
              }}>
                {menuItems.map((item, idx) => (
                  <View key={item.type}>
                    {item.dividerAbove && (
                      <View style={{ height: 1, backgroundColor: `${c.text}10`, marginHorizontal: 12 }} />
                    )}
                    <Pressable
                      onPress={() => {
                        setMenuOpen(false);
                        onAction(item.type, batch.id, batchLabel);
                      }}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, paddingVertical: 12,
                        borderRadius: idx === 0 ? 16 : idx === menuItems.length - 1 ? 16 : 0,
                      }}
                    >
                      <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: `${item.color}14`,
                        alignItems: 'center', justifyContent: 'center' }}>
                        {item.icon}
                      </View>
                      <Text style={{ fontSize: 13, fontWeight: '600',
                        color: item.color === '#16A34A' ? c.text : item.color }}>
                        {item.label}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      </NeuCard>
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Main Screen
// ══════════════════════════════════════════════════════════════════════════
export default function AdminCodes() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  // ── Shared state ────────────────────────────────────────────────────────
  const [courses, setCourses]       = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Tab ─────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<'codes' | 'batches'>('codes');

  // ── Codes tab state ─────────────────────────────────────────────────────
  const [codes, setCodes]           = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [codeSearch, setCodeSearch] = useState('');
  const debouncedCodeSearch         = useDebounce(codeSearch, 300);

  // ── Batches tab state ───────────────────────────────────────────────────
  const [batches, setBatches]           = useState<Batch[]>([]);
  const [batchLoading, setBatchLoading] = useState(true);
  const [viewingBatch, setViewingBatch] = useState<Batch | null>(null);
  const [batchSearch, setBatchSearch]   = useState('');
  const debouncedBatchSearch            = useDebounce(batchSearch, 300);
  const [confirmModal, setConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: string; batchId: string; label: string } | null>(null);
  const [submitting, setSubmitting]     = useState(false);

  // ── Modals ──────────────────────────────────────────────────────────────
  const [showGenerator, setShowGenerator] = useState(false);
  const [showAssign, setShowAssign]       = useState(false);
  const [assignTarget, setAssignTarget]   = useState<SearchedUser | null>(null);
  const [assignCourse, setAssignCourse]   = useState('');
  const [assigning, setAssigning]         = useState(false);
  const [assignError, setAssignError]     = useState('');

  // ── Load ─────────────────────────────────────────────────────────────────
  const loadCodes = useCallback(async () => {
    try { setCodes(await getActivationCodes()); } catch (_) {}
  }, []);

  const loadBatches = useCallback(async () => {
    setBatchLoading(true);
    try { setBatches(await getCodeBatches() as Batch[]); } catch (_) {}
    setBatchLoading(false);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [, cs] = await Promise.all([loadCodes(), getCourses()]);
      // getCourses returns value via argument; capture directly
    } catch (_) {}
  }, [loadCodes]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    (async () => {
      try {
        const [codesData, coursesData] = await Promise.all([getActivationCodes(), getCourses()]);
        setCodes(codesData); setCourses(coursesData);
      } catch (_) {}
      setLoading(false);
      loadBatches();
    })();
  }, [loadBatches]));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      (async () => { try { setCodes(await getActivationCodes()); } catch (_) {} })(),
      loadBatches(),
    ]);
    setRefreshing(false);
  };

  // ── Filtered lists ────────────────────────────────────────────────────────
  const filteredCodes = useMemo(() => {
    if (!debouncedCodeSearch) return codes;
    const q = debouncedCodeSearch.toLowerCase();
    return codes.filter(code =>
      code.code?.toLowerCase().includes(q) ||
      code.course?.title?.toLowerCase().includes(q) ||
      code.status?.toLowerCase().includes(q) ||
      code.used_by_profile?.full_name?.toLowerCase().includes(q)
    );
  }, [codes, debouncedCodeSearch]);

  const filteredBatches = useMemo(() => {
    if (!debouncedBatchSearch) return batches;
    const q = debouncedBatchSearch.toLowerCase();
    return batches.filter(b =>
      b.label?.toLowerCase().includes(q) ||
      b.course?.title?.toLowerCase().includes(q) ||
      b.notes?.toLowerCase().includes(q) ||
      b.prefix?.toLowerCase().includes(q)
    );
  }, [batches, debouncedBatchSearch]);

  // ── Individual code actions ───────────────────────────────────────────────
  const handleRevoke = async (id: string) => {
    try {
      await deactivateActivationCode(id);
      setCodes(prev => prev.map(c => c.id === id ? { ...c, status: 'deactivated' } : c));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed.') }); }
  };
  const handleDelete = async (id: string) => {
    try {
      await deleteActivationCode(id);
      setCodes(prev => prev.filter(c => c.id !== id));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed.') }); }
  };

  const toggleSelect = (id: string) =>
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const selectAll  = () => setSelectedIds(new Set(codes.filter(c => c.status !== 'used').map(c => c.id)));
  const clearSel   = () => setSelectedIds(new Set());

  const handleBulkDelete = async () => {
    setShowBulkDeleteConfirm(false); setBulkLoading(true);
    try {
      await bulkDeleteActivationCodes(Array.from(selectedIds));
      setCodes(prev => prev.filter(c => !selectedIds.has(c.id)));
      setSelectedIds(new Set());
      showToast({ type: 'success', message: `${selectedIds.size} code(s) deleted.` });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed.') }); }
    setBulkLoading(false);
  };
  const handleBulkDisable = async () => {
    setBulkLoading(true);
    try {
      await bulkDisableActivationCodes(Array.from(selectedIds));
      setCodes(prev => prev.map(c => selectedIds.has(c.id) && c.status === 'active' ? { ...c, status: 'deactivated' } : c));
      clearSel();
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed.') }); }
    setBulkLoading(false);
  };
  const handleBulkEnable = async () => {
    setBulkLoading(true);
    try {
      await bulkEnableActivationCodes(Array.from(selectedIds));
      setCodes(prev => prev.map(c => selectedIds.has(c.id) && c.status === 'deactivated' ? { ...c, status: 'active' } : c));
      clearSel();
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed.') }); }
    setBulkLoading(false);
  };

  // ── Assign ────────────────────────────────────────────────────────────────
  const handleAssign = async () => {
    if (!assignTarget || !assignCourse) { setAssignError('Select a user and a course.'); return; }
    setAssigning(true); setAssignError('');
    try {
      const { data: { session } } = await backendClient.auth.getSession();
      const res = await fetch(`${backendApiBase}/activation-codes/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ target_user_id: assignTarget.id, course_id: assignCourse }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to assign code.');
      setAssignTarget(null); setAssignCourse(''); setShowAssign(false);
      showToast({ type: 'success', message: `Course assigned to ${assignTarget.full_name}.` });
      await (async () => { try { setCodes(await getActivationCodes()); } catch (_) {} })();
    } catch (e: any) {
      setAssignError(friendlyError(e, 'Assignment failed.'));
    }
    setAssigning(false);
  };

  const openConfirm = (type: string, batchId: string, label: string) => {
    setConfirmAction({ type, batchId, label }); setConfirmModal(true);
  };

  // ── Batch actions ─────────────────────────────────────────────────────────
  const handleBatchAction = async (type: string, batchId: string, label: string) => {
    const batch = batches.find(b => b.id === batchId);

    if (type === 'view') {
      if (batch) setViewingBatch(batch);
      return;
    }

    if (type === 'generate_more') {
      setShowGenerator(true);
      return;
    }

    if (type === 'export_xlsx' || type === 'export_csv') {
      let rows: CodeRow[] = [];
      try {
        rows = await getActivationLedger({ batchId, limit: 500 }) as CodeRow[];
      } catch (_) {}
      if (!rows.length) {
        showToast({ type: 'info', message: 'No codes found for this batch.' });
        return;
      }
      const filename = buildExportFilename(label);
      const exportRows = rows.map(r => ({
        code:         r.code,
        course_title: batch?.course?.title ?? '',
        batch_label:  label,
        status:       r.status,
        uses_count:   r.uses_count ?? 0,
        max_uses:     r.max_uses != null ? r.max_uses : 'Unlimited',
        expires_at:   r.expires_at ? new Date(r.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never',
        created_at:   r.created_at ? new Date(r.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '',
      }));
      if (type === 'export_xlsx') {
        await exportXLSX(exportRows as Record<string, unknown>[], BATCH_CODE_COLUMNS, filename);
        showToast({ type: 'success', message: `Exported ${rows.length} codes as Excel.` });
      } else {
        exportCSV(exportRows as Record<string, unknown>[], BATCH_CODE_COLUMNS.map(col => col.key), filename);
        showToast({ type: 'success', message: `Exported ${rows.length} codes as CSV.` });
      }
      return;
    }

    // Destructive actions that need confirm modal
    openConfirm(type, batchId, label);
  };

  const doBatchAction = async () => {
    if (!confirmAction) return;
    setSubmitting(true);
    try {
      const actionMap: Record<string, string> = {
        disable: 'disable_batch', enable: 'enable_batch',
        delete: 'hard_delete_batch', clone: 'clone_batch',
      };
      await invokeEdgeFunction('activation-codes', { action: actionMap[confirmAction.type], batch_id: confirmAction.batchId });
      showToast({ type: 'success', message: `Batch ${confirmAction.type}d.` });
      setConfirmModal(false);
      await loadBatches();
    } catch (e: any) {
      showToast({ type: 'error', message: e.message ?? 'Operation failed.' });
    }
    setSubmitting(false);
  };

  // ── Styles ───────────────────────────────────────────────────────────────
  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5,
    fontSize: 13, color: c.text, flex: 1,
  } as const;

  const TabPill = ({ id, label }: { id: 'codes' | 'batches'; label: string }) => (
    <Pressable onPress={() => setTab(id)}
      style={{ flex: 1, paddingVertical: 9, borderRadius: 12, alignItems: 'center',
        backgroundColor: tab === id ? c.primary : `${c.text}08` }}>
      <Text style={{ fontSize: 13, fontWeight: '700',
        color: tab === id ? '#fff' : c.text, opacity: tab === id ? 1 : 0.6 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      {/* PageHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <PageHeader title="Activation Codes" subtitle="Generate & manage codes" />
        <View style={{ flexDirection: 'row', gap: 10, marginRight: layout.screenPx }}>
          <Pressable onPress={() => { setShowAssign(true); setAssignError(''); }}
            style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: '#16A34A',
              alignItems: 'center', justifyContent: 'center' }}>
            <UserCheck size={20} color="#fff" />
          </Pressable>
          <Pressable onPress={() => setShowGenerator(true)}
            style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: c.primary,
              alignItems: 'center', justifyContent: 'center' }}>
            <Plus size={22} color="#fff" />
          </Pressable>
        </View>
      </View>

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* Tab switcher */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
          <TabPill id="codes"   label="Individual Codes" />
          <TabPill id="batches" label={`Batches (${batches.length})`} />
        </View>
      </View>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* CODES TAB                                                         */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {tab === 'codes' && (
        <FlatList
          data={filteredCodes}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          ListHeaderComponent={
            <View style={{ paddingHorizontal: layout.screenPx }}>
              {/* Search */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Search size={14} color={`${c.text}55`}  />
                <TextInput value={codeSearch} onChangeText={setCodeSearch}
                  placeholder="Search code, course, status..."
                  placeholderTextColor={`${c.text}55`}
                  style={{ ...inp, paddingLeft: 36 }} />
                {codeSearch !== '' && (
                  <Pressable onPress={() => setCodeSearch('')} >
                    <X size={13} color={`${c.text}55`} />
                  </Pressable>
                )}
              </View>

              {/* Bulk toolbar */}
              {codes.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                  <Pressable onPress={selectedIds.size === 0 ? selectAll : clearSel}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 5,
                      paddingVertical: 7, paddingHorizontal: 11, borderRadius: 10,
                      backgroundColor: `${c.primary}12`, borderWidth: 1, borderColor: `${c.primary}22` }}>
                    {selectedIds.size > 0 ? <SquareCheck size={14} color={c.primary} /> : <Square size={14} color={c.primary} />}
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                      {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select All'}
                    </Text>
                  </Pressable>
                  {selectedIds.size > 0 && (<>
                    <Pressable onPress={clearSel}
                      style={{ paddingVertical: 7, paddingHorizontal: 11, borderRadius: 10,
                        backgroundColor: `${c.text}09`, borderWidth: 1, borderColor: `${c.text}18` }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: `${c.text}80` }}>Clear</Text>
                    </Pressable>
                    <Pressable onPress={handleBulkEnable} disabled={bulkLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                        paddingVertical: 7, paddingHorizontal: 11, borderRadius: 10,
                        backgroundColor: '#16A34A12', borderWidth: 1, borderColor: '#16A34A30' }}>
                      {bulkLoading ? <ActivityIndicator size={12} color="#16A34A" /> : <ToggleRight size={14} color="#16A34A" />}
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Enable</Text>
                    </Pressable>
                    <Pressable onPress={handleBulkDisable} disabled={bulkLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                        paddingVertical: 7, paddingHorizontal: 11, borderRadius: 10,
                        backgroundColor: '#D9770612', borderWidth: 1, borderColor: '#D9770630' }}>
                      {bulkLoading ? <ActivityIndicator size={12} color="#D97706" /> : <ToggleLeft size={14} color="#D97706" />}
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>Disable</Text>
                    </Pressable>
                    <Pressable onPress={() => setShowBulkDeleteConfirm(true)} disabled={bulkLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                        paddingVertical: 7, paddingHorizontal: 11, borderRadius: 10,
                        backgroundColor: '#DC262612', borderWidth: 1, borderColor: '#DC262630' }}>
                      <Trash2 size={14} color="#DC2626" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
                    </Pressable>
                  </>)}
                </View>
              )}
              {loading && <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />}
            </View>
          }
          renderItem={({ item: code }) => (
            <View style={{ paddingHorizontal: layout.screenPx, marginBottom: 10 }}>
              <NeuCard style={{ padding: 14, borderWidth: selectedIds.has(code.id) ? 1.5 : 0, borderColor: c.primary }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                  {code.status !== 'used' && (
                    <Pressable onPress={() => toggleSelect(code.id)} hitSlop={8}
                      style={{ width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
                        backgroundColor: selectedIds.has(code.id) ? c.primary : `${c.text}10` }}>
                      {selectedIds.has(code.id) && <CheckCircle size={13} color="#fff" />}
                    </Pressable>
                  )}
                  <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: `${statusColor(code.status)}15`,
                    alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor(code.status) }} />
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, flex: 1, letterSpacing: 1.2 }}>
                    {code.code}
                  </Text>
                  {(code.status === 'active' || code.status === 'deactivated') && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {code.status === 'active' && (
                        <Pressable onPress={() => handleRevoke(code.id)}
                          style={{ width: 30, height: 30, borderRadius: 8,
                            backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center' }}>
                          <XCircle size={14} color="#D97706" />
                        </Pressable>
                      )}
                      <Pressable onPress={() => handleDelete(code.id)}
                        style={{ width: 30, height: 30, borderRadius: 8,
                          backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                        <Trash2 size={14} color="#DC2626" />
                      </Pressable>
                    </View>
                  )}
                </View>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                  {code.course?.title ?? 'No course'}
                </Text>
                {code.used_by_profile && (
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                    Used by: {code.used_by_profile.full_name}
                  </Text>
                )}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                  <View style={{ backgroundColor: codeStatusBg(code.status), borderRadius: 8,
                    paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700',
                      color: codeStatusColor(code.status), textTransform: 'uppercase' }}>
                      {code.status}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                    {new Date(code.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Text>
                </View>
              </NeuCard>
            </View>
          )}
          ListEmptyComponent={!loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <Ticket size={40} color={c.primary} opacity={0.2} />
              <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No codes found</Text>
            </View>
          ) : null}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* BATCHES TAB                                                        */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {tab === 'batches' && (
        <FlatList
          data={filteredBatches}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          ListHeaderComponent={
            <View style={{ paddingHorizontal: layout.screenPx, paddingBottom: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Search size={14} color={`${c.text}55`}  />
                <TextInput value={batchSearch} onChangeText={setBatchSearch}
                  placeholder="Search batch name, course, prefix..."
                  placeholderTextColor={`${c.text}55`}
                  style={{ ...inp, paddingLeft: 36 }} />
                {batchSearch !== '' && (
                  <Pressable onPress={() => setBatchSearch('')} >
                    <X size={13} color={`${c.text}55`} />
                  </Pressable>
                )}
              </View>
              {batchLoading && <ActivityIndicator color={c.primary} style={{ marginTop: 20 }} />}
            </View>
          }
          renderItem={({ item: batch }) => (
            <BatchCard
              batch={batch} c={c} isDark={isDark}
              onAction={handleBatchAction}
              onViewCodes={b => setViewingBatch(b)}
            />
          )}
          ListEmptyComponent={!batchLoading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <Layers size={40} color={c.primary} opacity={0.2} />
              <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No batches found</Text>
              <Pressable onPress={() => setShowGenerator(true)} style={{ marginTop: 16 }}>
                <Text style={{ fontSize: 13, color: c.primary, fontWeight: '700' }}>+ Generate your first batch</Text>
              </Pressable>
            </View>
          ) : null}
        />
      )}

      {/* ── Batch Codes Modal ──────────────────────────────────────────── */}
      <BatchCodesModal
        batch={viewingBatch}
        visible={viewingBatch !== null}
        onClose={() => setViewingBatch(null)}
        c={c} isDark={isDark}
      />

      {/* ── Batch Generator Modal ──────────────────────────────────────── */}
      <BatchGeneratorModal
        visible={showGenerator}
        onClose={() => setShowGenerator(false)}
        courses={courses} c={c} isDark={isDark}
        onSuccess={async () => {
          await Promise.all([
            (async () => { try { setCodes(await getActivationCodes()); } catch (_) {} })(),
            loadBatches(),
          ]);
          setTab('batches');
        }}
      />

      {/* ── Assign Modal ─────────────────────────────────────────────────── */}
      <ResponsiveModal visible={showAssign} onClose={() => setShowAssign(false)}
        title="Assign Course to User"
        subtitle="Search by name, email, phone, or user ID"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setShowAssign(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Assign" onPress={handleAssign} loading={assigning}
              disabled={!assignTarget || !assignCourse} style={{ flex: 1 }} />
          </View>
        }
      >
        <UserSearchInput
          placeholder="Name, email, +20 phone or user ID…"
          allowedRoles={['student']}
          onSelect={u => { setAssignTarget(u); setAssignError(''); }}
          onClear={() => setAssignTarget(null)}
        />
        {assignTarget && (
          <View style={{ backgroundColor: `${c.primary}12`, borderRadius: 12, padding: 10,
            marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: `${c.primary}22`,
              alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>
                {assignTarget.full_name?.[0]?.toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{assignTarget.full_name}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                {displayPhoneNational(assignTarget.phone_e164) || getContactDisplay(assignTarget)}
              </Text>
            </View>
          </View>
        )}
        {assignTarget && (
          <>
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5,
              marginTop: 16, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Select Course
            </Text>
            {courses.map(course => (
              <Pressable key={course.id} onPress={() => setAssignCourse(course.id)}
                style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, marginBottom: 6,
                  backgroundColor: assignCourse === course.id ? `${c.primary}18` : `${c.text}08` }}>
                <Text style={{ fontSize: 13, fontWeight: assignCourse === course.id ? '700' : '400',
                  color: assignCourse === course.id ? c.primary : c.text }}>{course.title}</Text>
              </Pressable>
            ))}
          </>
        )}
        {assignError ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{assignError}</Text> : null}
      </ResponsiveModal>

      {/* ── Bulk Delete Confirm ─────────────────────────────────────────── */}
      <ResponsiveModal visible={showBulkDeleteConfirm} onClose={() => setShowBulkDeleteConfirm(false)}
        title="Delete Selected Codes"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setShowBulkDeleteConfirm(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label={`Delete ${selectedIds.size}`} onPress={handleBulkDelete} loading={bulkLoading} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, lineHeight: 22 }}>
          Permanently delete <Text style={{ fontWeight: '800', color: '#DC2626' }}>{selectedIds.size}</Text> code(s).{'\n\n'}This cannot be undone.
        </Text>
      </ResponsiveModal>

      {/* ── Batch Action Confirm ────────────────────────────────────────── */}
      <ResponsiveModal visible={confirmModal} onClose={() => setConfirmModal(false)} title="Confirm Operation">
        {confirmAction && (
          <View>
            <NeuCard style={{ padding: 16, marginBottom: 20, alignItems: 'center' }}>
              <AlertCircle size={28} color="#D97706" />
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginTop: 12, textAlign: 'center' }}>
                {confirmAction.type === 'disable' && 'Disable all active codes in this batch?'}
                {confirmAction.type === 'enable'  && 'Re-enable all disabled codes?'}
                {confirmAction.type === 'delete'  && 'Permanently delete this batch and ALL its codes? This cannot be undone.'}
                {confirmAction.type === 'clone'   && 'Clone this batch? New codes will be generated.'}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 6 }}>
                {confirmAction.label}
              </Text>
            </NeuCard>
            <NeuButton
              label={submitting ? 'Processing…' : `Confirm ${confirmAction.type}`}
              onPress={doBatchAction} disabled={submitting}
            />
            <NeuButton label="Cancel" onPress={() => setConfirmModal(false)}
              variant="secondary" style={{ marginTop: 8 }} />
          </View>
        )}
      </ResponsiveModal>
    </View>
  );
}
