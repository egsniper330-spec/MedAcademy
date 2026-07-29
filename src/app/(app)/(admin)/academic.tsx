/**
 * Academic Structure Management
 * Admin & Super Admin only — Universities → Faculties → Academic Levels
 */
import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  TextInput, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Plus, Edit2, Trash2, ChevronDown, ChevronRight, Building2, GraduationCap, BookOpen, ToggleLeft, ToggleRight } from 'lucide-react-native';
import {
  getUniversities, createUniversity, updateUniversity, deleteUniversity,
  getFaculties, createFaculty, updateFaculty, deleteFaculty,
  getAcademicLevels, createAcademicLevel, updateAcademicLevel, deleteAcademicLevel,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import { validateRequired, friendlyError } from '@/lib/validation';

type Tab = 'universities' | 'faculties' | 'levels';

// ─── Inline input modal ───────────────────────────────────────────────────────
function InputModal({
  visible, title, label, initialValue, onCancel, onConfirm, loading, c,
}: {
  visible: boolean; title: string; label: string; initialValue?: string;
  onCancel: () => void; onConfirm: (v: string) => void;
  loading: boolean; c: typeof neuColors.light;
}) {
  const [val, setVal] = useState(initialValue ?? '');
  const inputStyle = { backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5 };
  return (
    <ResponsiveModal
      visible={visible}
      onClose={onCancel}
      title={title}
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <NeuButton label="Cancel" onPress={onCancel} variant="secondary" style={{ flex: 1 }} />
          <NeuButton label="Save" onPress={() => onConfirm(val)} loading={loading} style={{ flex: 1 }} />
        </View>
      }
    >
      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>{label}</Text>
      <View style={inputStyle}>
        <TextInput
          value={val}
          onChangeText={setVal}
          autoFocus
          placeholder={label}
          placeholderTextColor={`${c.text}55`}
          style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text }}
        />
      </View>
    </ResponsiveModal>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────
export default function AcademicManagement() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();

  const [tab, setTab] = useState<Tab>('universities');
  const [refreshing, setRefreshing] = useState(false);

  // ── Universities ──────────────────────────────────────────────────────────
  const [universities, setUniversities] = useState<any[]>([]);
  const [uniLoading, setUniLoading] = useState(true);
  const [uniModal, setUniModal] = useState(false);
  const [editUni, setEditUni] = useState<any>(null);
  const [uniSaving, setUniSaving] = useState(false);

  // ── Faculties ─────────────────────────────────────────────────────────────
  const [faculties, setFaculties] = useState<any[]>([]);
  const [facLoading, setFacLoading] = useState(false);
  const [facModal, setFacModal] = useState(false);
  const [editFac, setEditFac] = useState<any>(null);
  const [selectedUniForFac, setSelectedUniForFac] = useState<string>('');
  const [facSaving, setFacSaving] = useState(false);
  const [expandedUnis, setExpandedUnis] = useState<Set<string>>(new Set());

  // ── Academic Levels ───────────────────────────────────────────────────────
  const [levels, setLevels] = useState<Record<string, any[]>>({});
  const [lvlModal, setLvlModal] = useState(false);
  const [editLvl, setEditLvl] = useState<any>(null);
  const [selectedFacForLvl, setSelectedFacForLvl] = useState<string>('');
  const [lvlSaving, setLvlSaving] = useState(false);
  const [expandedFacs, setExpandedFacs] = useState<Set<string>>(new Set());

  const loadUniversities = useCallback(async () => {
    setUniLoading(true);
    try { setUniversities(await getUniversities()); } catch (_) {}
    setUniLoading(false);
  }, []);

  const loadFaculties = useCallback(async () => {
    setFacLoading(true);
    try { setFaculties(await getFaculties()); } catch (_) {}
    setFacLoading(false);
  }, []);

  const loadLevelsForFaculty = async (facultyId: string) => {
    try {
      const data = await getAcademicLevels(facultyId);
      setLevels(prev => ({ ...prev, [facultyId]: data }));
    } catch (_) {}
  };

  useFocusEffect(useCallback(() => { loadUniversities(); loadFaculties(); }, [loadUniversities, loadFaculties]));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadUniversities(), loadFaculties()]);
    setRefreshing(false);
  };

  // ── University handlers ───────────────────────────────────────────────────
  const handleSaveUniversity = async (name: string) => {
    const err = validateRequired(name, 'University name');
    if (err) return;
    setUniSaving(true);
    try {
      if (editUni) {
        const updated = await updateUniversity(editUni.id, { name });
        setUniversities(prev => prev.map(u => u.id === editUni.id ? { ...u, ...updated } : u));
        showToast({ type: 'success', message: 'University updated successfully.' });
      } else {
        const created = await createUniversity(name);
        setUniversities(prev => [...prev, created]);
        showToast({ type: 'success', message: 'University created successfully.' });
      }
      setUniModal(false); setEditUni(null);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save university.') });
    }
    setUniSaving(false);
  };

  const handleToggleUniversity = async (uni: any) => {
    try {
      const updated = await updateUniversity(uni.id, { is_active: !uni.is_active });
      setUniversities(prev => prev.map(u => u.id === uni.id ? { ...u, ...updated } : u));
      showToast({ type: 'info', message: `University ${updated.is_active ? 'activated' : 'deactivated'}.` });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to update university.') });
    }
  };

  const handleDeleteUniversity = async (id: string) => {
    try {
      await deleteUniversity(id);
      setUniversities(prev => prev.filter(u => u.id !== id));
      showToast({ type: 'success', message: 'University deleted.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to delete university.') });
    }
  };

  // ── Faculty handlers ──────────────────────────────────────────────────────
  const handleSaveFaculty = async (name: string) => {
    const err = validateRequired(name, 'Faculty name');
    if (err) return;
    setFacSaving(true);
    try {
      if (editFac) {
        const updated = await updateFaculty(editFac.id, { name });
        setFaculties(prev => prev.map(f => f.id === editFac.id ? { ...f, ...updated } : f));
        showToast({ type: 'success', message: 'Faculty updated successfully.' });
      } else {
        const created = await createFaculty(selectedUniForFac, name);
        setFaculties(prev => [...prev, { ...created, university: universities.find(u => u.id === selectedUniForFac) }]);
        await loadLevelsForFaculty(created.id);
        showToast({ type: 'success', message: 'Faculty created successfully.' });
      }
      setFacModal(false); setEditFac(null);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save faculty.') });
    }
    setFacSaving(false);
  };

  const handleToggleFaculty = async (fac: any) => {
    try {
      const updated = await updateFaculty(fac.id, { is_active: !fac.is_active });
      setFaculties(prev => prev.map(f => f.id === fac.id ? { ...f, ...updated } : f));
      showToast({ type: 'info', message: `Faculty ${updated.is_active ? 'activated' : 'deactivated'}.` });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to update faculty.') });
    }
  };

  const handleDeleteFaculty = async (id: string) => {
    try {
      await deleteFaculty(id);
      setFaculties(prev => prev.filter(f => f.id !== id));
      showToast({ type: 'success', message: 'Faculty deleted.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to delete faculty.') });
    }
  };

  // ── Level handlers ────────────────────────────────────────────────────────
  const handleSaveLevel = async (name: string) => {
    const err = validateRequired(name, 'Level name');
    if (err) return;
    setLvlSaving(true);
    try {
      const facLevels = levels[selectedFacForLvl] ?? [];
      if (editLvl) {
        const updated = await updateAcademicLevel(editLvl.id, { name });
        setLevels(prev => ({ ...prev, [selectedFacForLvl]: (prev[selectedFacForLvl] ?? []).map(l => l.id === editLvl.id ? { ...l, ...updated } : l) }));
        showToast({ type: 'success', message: 'Level updated successfully.' });
      } else {
        const created = await createAcademicLevel(selectedFacForLvl, name, facLevels.length + 1);
        setLevels(prev => ({ ...prev, [selectedFacForLvl]: [...(prev[selectedFacForLvl] ?? []), created] }));
        showToast({ type: 'success', message: 'Level created successfully.' });
      }
      setLvlModal(false); setEditLvl(null);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save level.') });
    }
    setLvlSaving(false);
  };

  const handleToggleLevel = async (facId: string, lvl: any) => {
    try {
      const updated = await updateAcademicLevel(lvl.id, { is_active: !lvl.is_active });
      setLevels(prev => ({ ...prev, [facId]: (prev[facId] ?? []).map(l => l.id === lvl.id ? { ...l, ...updated } : l) }));
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to update level.') });
    }
  };

  const handleDeleteLevel = async (facId: string, id: string) => {
    try {
      await deleteAcademicLevel(id);
      setLevels(prev => ({ ...prev, [facId]: (prev[facId] ?? []).filter(l => l.id !== id) }));
    } catch (_) {}
  };

  const toggleUniExpand = async (uniId: string) => {
    setExpandedUnis(prev => {
      const next = new Set(prev);
      next.has(uniId) ? next.delete(uniId) : next.add(uniId);
      return next;
    });
  };

  const toggleFacExpand = async (facId: string) => {
    setExpandedFacs(prev => {
      const next = new Set(prev);
      if (next.has(facId)) { next.delete(facId); } else { next.add(facId); loadLevelsForFaculty(facId); }
      return next;
    });
  };

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'universities', label: 'Universities', icon: <Building2 size={16} color={tab === 'universities' ? c.primary : `${c.text}66`} /> },
    { key: 'faculties', label: 'Faculties', icon: <GraduationCap size={16} color={tab === 'faculties' ? c.primary : `${c.text}66`} /> },
    { key: 'levels', label: 'Levels', icon: <BookOpen size={16} color={tab === 'levels' ? c.primary : `${c.text}66`} /> },
  ];

  const uniById = Object.fromEntries(universities.map(u => [u.id, u]));

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
        <View style={{ padding: 20 }}>
          <PageHeader title="Academic Structure" subtitle="Manage universities, faculties and levels" />

          {/* Tab bar */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
            {tabs.map(t => (
              <Pressable key={t.key} onPress={() => setTab(t.key)}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, backgroundColor: tab === t.key ? `${c.primary}18` : c.base, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: tab === t.key ? 0.3 : 0.5, shadowRadius: 5 }}>
                {t.icon}
                <Text style={{ fontSize: 12, fontWeight: '700', color: tab === t.key ? c.primary : `${c.text}66` }}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          {/* ── UNIVERSITIES TAB ─────────────────────────────────────────── */}
          {tab === 'universities' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>{universities.length} Universities</Text>
                <Pressable onPress={() => { setEditUni(null); setUniModal(true); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 }}>
                  <Plus size={16} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Add</Text>
                </Pressable>
              </View>
              {uniLoading ? <ActivityIndicator color={c.primary} style={{ marginTop: 20 }} /> :
                universities.map(uni => (
                  <NeuCard key={uni.id} style={{ marginBottom: 10, padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                        <Building2 size={18} color={c.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{uni.name}</Text>
                        <Text style={{ fontSize: 11, color: uni.is_active ? '#16A34A' : '#DC2626', fontWeight: '600', marginTop: 2 }}>
                          {uni.is_active ? 'Active' : 'Inactive'}
                        </Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable onPress={() => handleToggleUniversity(uni)} style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: `${uni.is_active ? '#16A34A' : '#6B7280'}18`, alignItems: 'center', justifyContent: 'center' }}>
                          {uni.is_active ? <ToggleRight size={16} color="#16A34A" /> : <ToggleLeft size={16} color="#6B7280" />}
                        </Pressable>
                        <Pressable onPress={() => { setEditUni(uni); setUniModal(true); }} style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                          <Edit2 size={14} color={c.primary} />
                        </Pressable>
                        <Pressable onPress={() => handleDeleteUniversity(uni.id)} style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                          <Trash2 size={14} color="#DC2626" />
                        </Pressable>
                      </View>
                    </View>
                  </NeuCard>
                ))
              }
              {!uniLoading && universities.length === 0 && (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                  <Building2 size={40} color={c.primary} opacity={0.2} style={{ marginBottom: 10 }} />
                  <Text style={{ color: c.text, opacity: 0.4 }}>No universities yet</Text>
                </View>
              )}
            </>
          )}

          {/* ── FACULTIES TAB ────────────────────────────────────────────── */}
          {tab === 'faculties' && (
            <>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, marginBottom: 14 }}>
                Select a university to add or manage its faculties
              </Text>
              {uniLoading ? <ActivityIndicator color={c.primary} /> :
                universities.map(uni => {
                  const uniFacs = faculties.filter(f => f.university_id === uni.id);
                  const expanded = expandedUnis.has(uni.id);
                  return (
                    <NeuCard key={uni.id} style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
                      <Pressable onPress={() => toggleUniExpand(uni.id)} style={{ flexDirection: 'row', alignItems: 'center', padding: 14 }}>
                        <Building2 size={18} color={c.primary} style={{ marginRight: 10 }} />
                        <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: c.text }}>{uni.name}</Text>
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, marginRight: 8 }}>{uniFacs.length} faculties</Text>
                        {expanded ? <ChevronDown size={18} color={c.text} opacity={0.4} /> : <ChevronRight size={18} color={c.text} opacity={0.4} />}
                      </Pressable>
                      {expanded && (
                        <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
                          {uniFacs.map(fac => (
                            <View key={fac.id} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}05` }}>
                              <GraduationCap size={15} color={c.text} opacity={0.4} style={{ marginRight: 10 }} />
                              <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: c.text }}>{fac.name}</Text>
                              <Text style={{ fontSize: 11, color: fac.is_active ? '#16A34A' : '#DC2626', marginRight: 8 }}>{fac.is_active ? '●' : '○'}</Text>
                              <View style={{ flexDirection: 'row', gap: 4 }}>
                                <Pressable onPress={() => handleToggleFaculty(fac)} accessibilityLabel={fac.is_active ? 'Deactivate faculty' : 'Activate faculty'} accessibilityRole="button" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: `${fac.is_active ? '#16A34A' : '#6B7280'}18`, alignItems: 'center', justifyContent: 'center' }}>
                                  {fac.is_active ? <ToggleRight size={15} color="#16A34A" /> : <ToggleLeft size={15} color="#6B7280" />}
                                </Pressable>
                                <Pressable onPress={() => { setEditFac(fac); setSelectedUniForFac(uni.id); setFacModal(true); }} accessibilityLabel="Edit faculty" accessibilityRole="button" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                                  <Edit2 size={14} color={c.primary} />
                                </Pressable>
                                <Pressable onPress={() => handleDeleteFaculty(fac.id)} accessibilityLabel="Delete faculty" accessibilityRole="button" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                                  <Trash2 size={14} color="#DC2626" />
                                </Pressable>
                              </View>
                            </View>
                          ))}
                          <Pressable onPress={() => { setEditFac(null); setSelectedUniForFac(uni.id); setFacModal(true); }}
                            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12 }}>
                            <Plus size={14} color={c.primary} />
                            <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>Add Faculty</Text>
                          </Pressable>
                        </View>
                      )}
                    </NeuCard>
                  );
                })
              }
            </>
          )}

          {/* ── LEVELS TAB ───────────────────────────────────────────────── */}
          {tab === 'levels' && (
            <>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, marginBottom: 14 }}>
                Expand a faculty to manage its academic levels
              </Text>
              {facLoading ? <ActivityIndicator color={c.primary} /> :
                faculties.map(fac => {
                  const expanded = expandedFacs.has(fac.id);
                  const facLevels = levels[fac.id] ?? [];
                  return (
                    <NeuCard key={fac.id} style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
                      <Pressable onPress={() => toggleFacExpand(fac.id)} style={{ flexDirection: 'row', alignItems: 'center', padding: 14 }}>
                        <GraduationCap size={18} color={c.primary} style={{ marginRight: 10 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{fac.name}</Text>
                          <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 1 }}>{uniById[fac.university_id]?.name ?? ''}</Text>
                        </View>
                        {expanded ? <ChevronDown size={18} color={c.text} opacity={0.4} /> : <ChevronRight size={18} color={c.text} opacity={0.4} />}
                      </Pressable>
                      {expanded && (
                        <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
                          {facLevels.length === 0
                            ? <Text style={{ color: c.text, opacity: 0.35, fontSize: 13, textAlign: 'center', paddingVertical: 12 }}>No levels — tap + to add</Text>
                            : facLevels.map((lvl, idx) => (
                              <View key={lvl.id} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: `${c.text}05` }}>
                                <Text style={{ fontSize: 12, color: c.text, opacity: 0.35, width: 24 }}>{idx + 1}</Text>
                                <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: c.text }}>{lvl.name}</Text>
                                <Text style={{ fontSize: 11, color: lvl.is_active ? '#16A34A' : '#DC2626', marginRight: 8 }}>{lvl.is_active ? '●' : '○'}</Text>
                                <View style={{ flexDirection: 'row', gap: 4 }}>
                                  <Pressable onPress={() => handleToggleLevel(fac.id, lvl)} accessibilityLabel={lvl.is_active ? 'Deactivate level' : 'Activate level'} accessibilityRole="button" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: `${lvl.is_active ? '#16A34A' : '#6B7280'}18`, alignItems: 'center', justifyContent: 'center' }}>
                                    {lvl.is_active ? <ToggleRight size={15} color="#16A34A" /> : <ToggleLeft size={15} color="#6B7280" />}
                                  </Pressable>
                                  <Pressable onPress={() => { setEditLvl(lvl); setSelectedFacForLvl(fac.id); setLvlModal(true); }} accessibilityLabel="Edit level" accessibilityRole="button" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                                    <Edit2 size={14} color={c.primary} />
                                  </Pressable>
                                  <Pressable onPress={() => handleDeleteLevel(fac.id, lvl.id)} accessibilityLabel="Delete level" accessibilityRole="button" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                                    <Trash2 size={14} color="#DC2626" />
                                  </Pressable>
                                </View>
                              </View>
                            ))
                          }
                          <Pressable onPress={() => { setEditLvl(null); setSelectedFacForLvl(fac.id); setLvlModal(true); }}
                            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12 }}>
                            <Plus size={14} color={c.primary} />
                            <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>Add Level</Text>
                          </Pressable>
                        </View>
                      )}
                    </NeuCard>
                  );
                })
              }
            </>
          )}
        </View>
      </ScrollView>

      {/* Modals */}
      <InputModal
        visible={uniModal} title={editUni ? 'Edit University' : 'Add University'}
        label="University Name" initialValue={editUni?.name ?? ''}
        onCancel={() => { setUniModal(false); setEditUni(null); }}
        onConfirm={handleSaveUniversity} loading={uniSaving} c={c}
      />
      <InputModal
        visible={facModal} title={editFac ? 'Edit Faculty' : 'Add Faculty'}
        label="Faculty Name" initialValue={editFac?.name ?? ''}
        onCancel={() => { setFacModal(false); setEditFac(null); }}
        onConfirm={handleSaveFaculty} loading={facSaving} c={c}
      />
      <InputModal
        visible={lvlModal} title={editLvl ? 'Edit Level' : 'Add Level'}
        label="Level Name" initialValue={editLvl?.name ?? ''}
        onCancel={() => { setLvlModal(false); setEditLvl(null); }}
        onConfirm={handleSaveLevel} loading={lvlSaving} c={c}
      />
    </View>
  );
}
