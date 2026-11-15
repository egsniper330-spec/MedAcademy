/**
 * sa-admin-permissions.tsx — "Edit Permissions — [Admin Name]".
 *
 * Loads the admin's effective permissions and the catalog from the backend,
 * lets the operator toggle keys, pick a template or clone another admin, and
 * saves the complete desired set. The server re-checks every change
 * (`manage_permissions`, delegation scope, protected Super Admin accounts)
 * and writes the audit log.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, useColorScheme } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronRight, Check, X } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import {
  getAdminPermissionDetail, saveAdminPermissions, cloneAdminPermissions, getAdminAccounts,
  type AdminPermissionDetail, type AdminAccountSummary,
} from '@/lib/api';
import { useAdminPermissions } from '@/hooks/useAdminPermissions';
import { logAndParse } from '@/lib/parseError';

export default function SaAdminPermissions() {
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { showToast } = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const adminId = String(id ?? '');
  const perms = useAdminPermissions();

  const [detail, setDetail] = useState<AdminPermissionDetail | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [cloneOptions, setCloneOptions] = useState<AdminAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adminId) return;
    try {
      const [d, list] = await Promise.all([getAdminPermissionDetail(adminId), getAdminAccounts()]);
      setDetail(d);
      setDraft(new Set(d.permissions));
      setTemplateId(d.template?.id ?? null);
      setCloneOptions(list.admins.filter((a) => a.id !== adminId && !a.is_super_admin));
      setError(null);
    } catch (e) {
      setError(logAndParse(e, 'admin-permissions'));
    } finally {
      setLoading(false);
    }
  }, [adminId]);

  useEffect(() => {
    if (!perms.loading) void load();
  }, [perms.loading, load]);

  const canEdit = detail?.can_edit === true;
  const granted = draft.size;
  const catalogTotal = detail?.catalog_total ?? 0;

  const isDirty = useMemo(() => {
    if (!detail) return false;
    const base = new Set(detail.permissions);
    if (base.size !== draft.size) return true;
    for (const k of draft) if (!base.has(k)) return true;
    return false;
  }, [detail, draft]);

  const toggleKey = (key: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGroup = (groupKeys: string[], grant: boolean) => {
    setDraft((prev) => {
      const next = new Set(prev);
      for (const k of groupKeys) {
        if (grant) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveAdminPermissions(adminId, { permissions: Array.from(draft), template_id: templateId });
      showToast({ type: 'success', message: 'Permissions saved.' });
      router.back();
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'admin-permissions-save') });
    } finally {
      setSaving(false);
    }
  };

  const cloneFrom = async (sourceId: string) => {
    setSaving(true);
    try {
      await cloneAdminPermissions(adminId, sourceId);
      showToast({ type: 'success', message: 'Permissions cloned. Review and save.' });
      await load();
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'admin-permissions-clone') });
    } finally {
      setSaving(false);
    }
  };

  if (!perms.loading && !(perms.isSuperAdmin || perms.has('manage_permissions'))) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <PageHeader title="Permissions" showBack navMode="back" backFallback="/sa-admin-management" />
        <View style={{ padding: 16 }}>
          <NeuCard>
            <Text style={{ color: c.text, fontSize: 15 }}>You do not have permission to change administrator permissions.</Text>
          </NeuCard>
        </View>
      </View>
    );
  }

  const title = detail ? `Edit Permissions — ${detail.admin.full_name || detail.admin.email || 'Administrator'}` : 'Edit Permissions';
  const busy = saving;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={title} showBack navMode="back" backFallback="/sa-admin-management" />
      {loading ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : error || !detail ? (
        <View style={{ padding: 16 }}>
          <NeuCard>
            <Text style={{ color: '#EF4444', fontSize: 14, marginBottom: 10 }}>{error ?? 'Administrator not found.'}</Text>
            <NeuButton label="Retry" variant="secondary" onPress={() => { setLoading(true); void load(); }} />
          </NeuCard>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
          <NeuCard>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }}>
              {`${granted} of ${catalogTotal} permissions granted`}
            </Text>
            <Text style={{ color: c.textMuted ?? '#6B7280', fontSize: 13, marginTop: 4 }}>
              {canEdit ? 'Toggle permissions, then save.' : 'Read-only: you cannot change this administrator.'}
            </Text>
          </NeuCard>

          <Text style={{ color: c.text, fontWeight: '700' }}>Template</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label="Custom" active={templateId === null} disabled={!canEdit || busy} onPress={() => setTemplateId(null)} colors={c} />
            {detail.templates.map((t) => (
              <Chip
                key={t.id}
                label={t.name}
                active={templateId === t.id}
                disabled={!canEdit || busy}
                onPress={() => {
                  setTemplateId(t.id);
                  setDraft(new Set(t.permissions));
                }}
                colors={c}
              />
            ))}
          </View>

          {canEdit && cloneOptions.length > 0 && (
            <>
              <Text style={{ color: c.text, fontWeight: '700' }}>Clone permissions from</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {cloneOptions.map((a) => (
                  <Chip
                    key={a.id}
                    label={a.full_name || a.email || a.id}
                    active={false}
                    disabled={busy}
                    onPress={() => void cloneFrom(a.id)}
                    colors={c}
                  />
                ))}
              </View>
            </>
          )}

          {detail.groups.map((g) => {
            const keys = g.permissions.map((p) => p.key);
            const grantedInGroup = keys.filter((k) => draft.has(k)).length;
            const open = expanded.has(g.key);
            return (
              <NeuCard key={g.key}>
                <Pressable
                  onPress={() => toggleExpanded(g.key)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Text style={{ color: c.text, fontSize: 15, fontWeight: '700', flex: 1 }}>{g.label}</Text>
                  <Text style={{ color: c.textMuted ?? '#6B7280', fontSize: 13, marginRight: 8 }}>
                    {`${grantedInGroup}/${keys.length}`}
                  </Text>
                  {open ? <ChevronDown size={18} color={c.text} /> : <ChevronRight size={18} color={c.text} />}
                </Pressable>
                {open && (
                  <View style={{ marginTop: 12, gap: 8 }}>
                    {canEdit && (
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <NeuButton label="Select All" variant="secondary" disabled={busy} onPress={() => toggleGroup(keys, true)} />
                        <NeuButton label="Deselect All" variant="secondary" disabled={busy} onPress={() => toggleGroup(keys, false)} />
                      </View>
                    )}
                    {g.permissions.map((p) => {
                      const on = draft.has(p.key);
                      return (
                        <Pressable
                          key={p.key}
                          disabled={!canEdit || busy}
                          onPress={() => toggleKey(p.key)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: on, disabled: !canEdit || busy }}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}
                        >
                          <View style={{
                            width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
                            borderColor: on ? c.primary : c.textMuted ?? '#6B7280',
                            backgroundColor: on ? c.primary : 'transparent',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            {on ? <Check size={14} color="#fff" /> : <X size={12} color={c.textMuted ?? '#6B7280'} />}
                          </View>
                          <Text style={{ color: on ? c.text : c.textMuted ?? '#6B7280', fontSize: 14, flex: 1 }}>{p.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </NeuCard>
            );
          })}

          {canEdit && (
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
              <NeuButton label="Cancel" variant="secondary" disabled={busy} onPress={() => router.back()} />
              <NeuButton label="Save Changes" onPress={save} disabled={busy || !isDirty} loading={busy} />
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Chip({ label, active, disabled, onPress, colors: c }: {
  label: string; active: boolean; disabled?: boolean; onPress: () => void; colors: typeof neuColors.light;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      style={({ pressed }) => ({
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
        backgroundColor: active ? c.primary : 'transparent',
        borderWidth: 1, borderColor: active ? c.primary : c.border ?? '#D1D5DB',
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: active ? '#fff' : c.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
