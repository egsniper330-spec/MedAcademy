import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, RefreshControl,
  ActivityIndicator, Pressable, TextInput,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Megaphone, Send, Users, User, GraduationCap, Building, BookOpen, Layers } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import {
  getUniversities, getFaculties, getAllAcademicLevels, getCourses,
  getSentNotifications, sendBroadcastNotification,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout } from '@/lib/neu';
import { useToast } from '@/components/Toast';

const TARGET_TYPES = [
  { key: 'all',        label: 'Everyone',      icon: Users,         color: '#1E90FF' },
  { key: 'role',       label: 'By Role',        icon: User,          color: '#7C3AED' },
  { key: 'university', label: 'By University',  icon: Building,      color: '#D97706' },
  { key: 'faculty',    label: 'By Faculty',     icon: GraduationCap, color: '#16A34A' },
  { key: 'level',      label: 'By Level',       icon: Layers,        color: '#2DA8FF' },
  { key: 'course',     label: 'By Course',      icon: BookOpen,      color: '#7C3AED' },
  { key: 'individual', label: 'Individual',     icon: User,          color: '#2DA8FF' },
];

const ROLES = ['student','doctor','admin'];

export default function NotificationsCenterScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetType, setTargetType] = useState('all');
  const [targetRole, setTargetRole] = useState('student');
  const [targetUniversityId, setTargetUniversityId] = useState('');
  const [targetUserId, setTargetUserId] = useState('');
  const [universities, setUniversities] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [unis, sent] = await Promise.all([getUniversities(), getSentNotifications(20)]);
      setUniversities(unis);
      setHistory(sent);
    } catch (_) {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) { setError('Title and message are required.'); return; }
    setSending(true); setError(''); setSuccess(false);
    try {
      await sendBroadcastNotification({
        title, body,
        target_type: targetType as any,
        target_role: targetType === 'role' ? targetRole : undefined,
        target_university_id: targetType === 'university' ? targetUniversityId : undefined,
        target_user_id: targetType === 'individual' ? targetUserId : undefined,
      });
      setTitle(''); setBody(''); setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      await load();
    } catch (e: any) { setError(e.message ?? 'Failed to send notification.'); }
    setSending(false);
  };

  const inp = { backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.45, shadowRadius: 5 };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="Notification Center" subtitle="Send messages to users" accentColor="#D97706" />

        {/* Compose */}
        <NeuCard style={{ padding: 18, marginBottom: 20 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 14 }}>Compose Notification</Text>

          {/* Target type */}
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>Target</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {TARGET_TYPES.map(t => {
                const active = targetType === t.key;
                return (
                  <Pressable key={t.key} onPress={() => setTargetType(t.key)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: active ? `${t.color}22` : `${c.text}0A`, borderWidth: active ? 1.5 : 0, borderColor: t.color }}>
                    <t.icon size={14} color={active ? t.color : `${c.text}66`} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: active ? t.color : `${c.text}88` }}>{t.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          {/* Conditional target selectors */}
          {targetType === 'role' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {ROLES.map(r => (
                  <Pressable key={r} onPress={() => setTargetRole(r)}
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: targetRole === r ? `${c.primary}22` : `${c.text}0A`, borderWidth: targetRole === r ? 1.5 : 0, borderColor: c.primary }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: targetRole === r ? c.primary : `${c.text}88`, textTransform: 'capitalize' }}>{r}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}

          {targetType === 'university' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {universities.map(u => (
                  <Pressable key={u.id} onPress={() => setTargetUniversityId(u.id)}
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: targetUniversityId === u.id ? `${c.primary}22` : `${c.text}0A`, borderWidth: targetUniversityId === u.id ? 1.5 : 0, borderColor: c.primary }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: targetUniversityId === u.id ? c.primary : `${c.text}88` }}>{u.name}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}

          {targetType === 'individual' && (
            <>
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>User ID</Text>
              <TextInput value={targetUserId} onChangeText={setTargetUserId} placeholder="Paste user UUID..." placeholderTextColor={`${c.text}55`}
                style={{ ...inp, minWidth: 0, marginBottom: 14 }} autoCapitalize="none" />
            </>
          )}

          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>Title</Text>
          <TextInput value={title} onChangeText={setTitle} placeholder="Notification title..." placeholderTextColor={`${c.text}55`}
            style={{ ...inp, minWidth: 0, marginBottom: 12 }} />

          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>Message</Text>
          <View style={{ ...inp, minWidth: 0, marginBottom: 16 }}>
            <TextInput value={body} onChangeText={setBody} placeholder="Notification body..." placeholderTextColor={`${c.text}55`}
              multiline numberOfLines={3} style={{ fontSize: 14, color: c.text, minWidth: 0, minHeight: 72 }} />
          </View>

          {error ? <Text style={{ color: '#DC2626', fontSize: 13, marginBottom: 10, fontWeight: '600' }}>{error}</Text> : null}
          {success ? <Text style={{ color: '#16A34A', fontSize: 13, marginBottom: 10, fontWeight: '600' }}>✅ Notification sent successfully!</Text> : null}

          <NeuButton label="Send Notification" icon={<Send size={16} color="#fff" />} onPress={handleSend} loading={sending} fullWidth />
        </NeuCard>

        {/* History */}
        {history.length > 0 && (
          <>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Recently Sent</Text>
            {history.map(n => (
              <NeuCard key={n.id} style={{ marginBottom: 10, padding: 14 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{n.title}</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 3 }}>{n.body}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <View style={{ backgroundColor: `${c.primary}18`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary }}>{n.target_type ?? 'individual'}</Text>
                  </View>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{new Date(n.sent_at ?? n.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}</Text>
                </View>
              </NeuCard>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}
