/**
 * sa-admin-management.tsx — dedicated Admin Management page.
 *
 * Lists admin accounts with search and filters, creates and edits admins,
 * changes account status, and opens each admin's permission editor. This is
 * separate from the student/doctor Users screen (sa-users). Every action is
 * re-checked by the backend (`manage_admins`, delegation and protected-account
 * rules); the UI only hides or disables controls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import { Search, Plus, Shield, ChevronRight, Pencil } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import {
  getAdminAccounts, createAdminAccount, updateAdminAccount, getPermissionTemplates,
  type AdminAccountSummary, type PermissionTemplateSummary,
} from '@/lib/api';
import { useAdminPermissions } from '@/hooks/useAdminPermissions';
import { useDebounce } from '@/lib/useDebounce';
import { logAndParse } from '@/lib/parseError';

type StatusFilter = 'all' | 'active' | 'suspended' | 'blocked';
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'blocked', label: 'Blocked' },
];

const STATUS_COLORS: Record<string, string> = {
  active: '#16A34A',
  suspended: '#D97706',
  blocked: '#EF4444',
};

type FormState = { mode: 'create' } | { mode: 'edit'; admin: AdminAccountSummary } | null;

export default function SaAdminManagement() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { showToast } = useToast();
  const perms = useAdminPermissions();

  const [admins, setAdmins] = useState<AdminAccountSummary[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [templates, setTemplates] = useState<PermissionTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [form, setForm] = useState<FormState>(null);

  const canManage = perms.isSuperAdmin || perms.has('manage_admins');
  const canPermissions = perms.isSuperAdmin || perms.has('manage_permissions');

  const load = useCallback(async () => {
    try {
      const [list, tpls] = await Promise.all([
        getAdminAccounts({
          search: debouncedSearch || undefined,
          status: status === 'all' ? undefined : status,
        }),
        getPermissionTemplates(),
      ]);
      setAdmins(list.admins);
      setCatalogTotal(list.catalog_total);
      setTemplates(tpls);
      setError(null);
    } catch (e) {
      setError(logAndParse(e, 'admin-management'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [debouncedSearch, status]);

  useEffect(() => {
    if (!perms.loading && canManage) void load();
    else if (!perms.loading) setLoading(false);
  }, [perms.loading, canManage, load]);

  useFocusEffect(
    useCallback(() => {
      if (!perms.loading && canManage) void load();
    }, [perms.loading, canManage, load]),
  );

  const templateName = useMemo(() => {
    const map = new Map(templates.map((t) => [t.id, t.name]));
    return (id: string | null | undefined) => (id ? map.get(id) ?? null : null);
  }, [templates]);

  if (!perms.loading && !canManage) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <PageHeader title="Admin Management" showBack navMode="back" backFallback="/sa-platform" />
        <View style={{ padding: 16 }}>
          <NeuCard>
            <Text style={{ color: c.text, fontSize: 15 }}>You do not have permission to manage administrators.</Text>
          </NeuCard>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="Admin Management" subtitle={`${admins.length} administrator${admins.length === 1 ? '' : 's'}`} showBack navMode="back" backFallback="/sa-platform" />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />
        }
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderWidth: 1, borderColor: c.border ?? '#D1D5DB', paddingHorizontal: 12, backgroundColor: c.surface ?? c.base }}>
            <Search size={16} color={c.textMuted ?? '#6B7280'} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search by name or email"
              placeholderTextColor={c.textMuted ?? '#6B7280'}
              style={{ flex: 1, color: c.text, paddingVertical: 10, fontSize: 15 }}
              autoCapitalize="none"
              accessibilityLabel="Search administrators"
            />
          </View>
          {canManage && (
            <NeuButton label="Add Admin" icon={<Plus size={16} color="#fff" />} onPress={() => setForm({ mode: 'create' })} />
          )}
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {STATUS_FILTERS.map((f) => {
            const active = status === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setStatus(f.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => ({
                  paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
                  backgroundColor: active ? c.primary : c.surface ?? c.base,
                  borderWidth: 1, borderColor: active ? c.primary : c.border ?? '#D1D5DB',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: active ? '#fff' : c.text, fontSize: 13, fontWeight: '600' }}>{f.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={c.primary} />
          </View>
        ) : error ? (
          <NeuCard>
            <Text style={{ color: '#EF4444', fontSize: 14, marginBottom: 10 }}>{error}</Text>
            <NeuButton label="Retry" variant="secondary" onPress={() => { setLoading(true); void load(); }} />
          </NeuCard>
        ) : admins.length === 0 ? (
          <NeuCard>
            <Text style={{ color: c.text, fontSize: 15, textAlign: 'left' }}>
              {debouncedSearch || status !== 'all' ? 'No administrators match these filters.' : 'No administrators yet.'}
            </Text>
          </NeuCard>
        ) : (
          admins.map((a) => {
            const tName = a.is_super_admin ? 'Super Admin' : a.template?.name ?? templateName(a.template?.id) ?? 'Custom';
            const statusColor = STATUS_COLORS[a.status] ?? '#6B7280';
            return (
              <NeuCard key={a.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
                      {a.full_name || 'Unnamed'}
                    </Text>
                    <Text style={[mutedTextStyle(c), { fontSize: 13 }]} numberOfLines={1}>{a.email ?? ''}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: statusColor + '22' }}>
                        <Text style={{ color: statusColor, fontSize: 12, fontWeight: '600' }}>{a.status}</Text>
                      </View>
                      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: c.primary + '22' }}>
                        <Text style={{ color: c.primary, fontSize: 12, fontWeight: '600' }}>{tName}</Text>
                      </View>
                      <Text style={[mutedTextStyle(c), { fontSize: 12, alignSelf: 'center' }]}>
                        {`${a.permission_count} of ${a.catalog_total ?? catalogTotal} permissions`}
                      </Text>
                    </View>
                  </View>
                  <View style={{ gap: 8 }}>
                    {canManage && !a.is_super_admin && (
                      <Pressable
                        onPress={() => setForm({ mode: 'edit', admin: a })}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${a.full_name ?? a.email ?? 'administrator'}`}
                        style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.6 : 1 })}
                      >
                        <Pencil size={18} color={c.text} />
                      </Pressable>
                    )}
                    {canPermissions && !a.is_super_admin && (
                      <Pressable
                        onPress={() => router.push({ pathname: '/sa-admin-permissions', params: { id: a.id } } as never)}
                        accessibilityRole="button"
                        accessibilityLabel={`Permissions for ${a.full_name ?? a.email ?? 'administrator'}`}
                        style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.6 : 1 })}
                      >
                        <Shield size={18} color={c.primary} />
                      </Pressable>
                    )}
                  </View>
                </View>
              </NeuCard>
            );
          })
        )}
      </ScrollView>

      {form && (
        <AdminFormModal
          key={form.mode === 'edit' ? form.admin.id : 'create'}
          state={form}
          templates={templates}
          canChangeStatus={canManage}
          colors={c}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); void load(); }}
          onToast={showToast}
        />
      )}
    </View>
  );
}

// ── Create / edit form ─────────────────────────────────────────────────────

function AdminFormModal({
  state, templates, canChangeStatus, colors: c, onClose, onSaved, onToast,
}: {
  state: NonNullable<FormState>;
  templates: PermissionTemplateSummary[];
  canChangeStatus: boolean;
  colors: typeof neuColors.light;
  onClose: () => void;
  onSaved: () => void;
  onToast: (o: { type: 'success' | 'error'; message: string }) => void;
}) {
  const editing = state.mode === 'edit' ? state.admin : null;
  const [fullName, setFullName] = useState(editing?.full_name ?? '');
  const [email, setEmail] = useState(editing?.email ?? '');
  const [password, setPassword] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(editing?.template?.id ?? null);
  const [adminStatus, setAdminStatus] = useState<AdminAccountSummary['status']>(editing?.status ?? 'active');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await updateAdminAccount(editing.id, {
          full_name: fullName.trim(),
          template_id: templateId,
          ...(canChangeStatus ? { status: adminStatus } : {}),
        });
        onToast({ type: 'success', message: 'Administrator updated.' });
      } else {
        await createAdminAccount({
          email: email.trim(),
          full_name: fullName.trim(),
          password,
          template_id: templateId,
        });
        onToast({ type: 'success', message: 'Administrator created.' });
      }
      onSaved();
    } catch (e) {
      setFormError(logAndParse(e, 'admin-form'));
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = !saving && fullName.trim().length > 0 && (editing ? true : email.trim().length > 0 && password.length >= 8);

  return (
    <ResponsiveModal
      visible
      onClose={onClose}
      title={editing ? 'Edit Administrator' : 'Create Administrator'}
      subtitle={editing?.email ?? undefined}
      footer={
        <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
          <NeuButton label="Cancel" variant="secondary" onPress={onClose} />
          <NeuButton label={editing ? 'Save Changes' : 'Create'} onPress={submit} disabled={!canSubmit} loading={saving} />
        </View>
      }
    >
      <View style={{ gap: 12 }}>
        <Field label="Full name" value={fullName} onChangeText={setFullName} colors={c} />
        {!editing && <Field label="Email" value={email} onChangeText={setEmail} colors={c} keyboardType="email-address" autoCapitalize="none" />}
        {!editing && <Field label="Temporary password (min 8 characters)" value={password} onChangeText={setPassword} colors={c} secureTextEntry />}
        <Text style={{ color: c.text, fontWeight: '600' }}>Permission template</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip label="Custom" active={templateId === null} onPress={() => setTemplateId(null)} colors={c} />
          {templates.map((t) => (
            <Chip key={t.id} label={t.name} active={templateId === t.id} onPress={() => setTemplateId(t.id)} colors={c} />
          ))}
        </View>
        {editing && canChangeStatus && (
          <>
            <Text style={{ color: c.text, fontWeight: '600' }}>Status</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(['active', 'suspended', 'blocked'] as const).map((s) => (
                <Chip key={s} label={s} active={adminStatus === s} onPress={() => setAdminStatus(s)} colors={c} />
              ))}
            </View>
          </>
        )}
        {formError && <Text style={{ color: '#EF4444', fontSize: 13 }}>{formError}</Text>}
      </View>
    </ResponsiveModal>
  );
}

function Field({
  label, value, onChangeText, colors: c, ...rest
}: {
  label: string; value: string; onChangeText: (v: string) => void; colors: typeof neuColors.light;
} & Partial<React.ComponentProps<typeof TextInput>>) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.text, fontWeight: '600' }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={c.textMuted ?? '#6B7280'}
        style={{ color: c.text, borderWidth: 1, borderColor: c.border ?? '#D1D5DB', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 }}
        {...rest}
      />
    </View>
  );
}

function Chip({ label, active, onPress, colors: c }: { label: string; active: boolean; onPress: () => void; colors: typeof neuColors.light }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
        backgroundColor: active ? c.primary : 'transparent',
        borderWidth: 1, borderColor: active ? c.primary : c.border ?? '#D1D5DB',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: active ? '#fff' : c.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
