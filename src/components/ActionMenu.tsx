/**
 * ActionMenu — modern bottom-sheet action menu for user/admin/doctor cards.
 * Groups actions by category with icons, danger styling, and disables while
 * any action is running.
 */
import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, useColorScheme, ScrollView } from 'react-native';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors } from '@/lib/neu';
import {
  Edit3, UserCheck, UserX, KeyRound, ArrowUpCircle, ArrowDownCircle,
  Trash2, Smartphone, CreditCard, Clock, FileText, History,
  Infinity, Settings, Tag, TrendingUp,
} from 'lucide-react-native';

export type ActionKey =
  | 'edit' | 'block' | 'unblock' | 'reset_password' | 'change_password'
  | 'promote_doctor' | 'promote_admin'
  | 'demote_student' | 'demote_doctor'
  | 'delete'
  | 'devices' | 'credits' | 'timeline' | 'audit' | 'login_history'
  | 'unlimited_devices' | 'limited_devices'
  | 'credit_price' | 'earnings';

interface ActionDef {
  key: ActionKey;
  label: string;
  icon: React.ReactNode;
  color: string;
  danger?: boolean;
}

interface ActionMenuProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  /** Which actions to show — pass only the relevant one for unlimited/limited based on current state */
  actions: ActionKey[];
  /** Called when user taps an action */
  onAction: (key: ActionKey) => void;
  /** Keys that are currently loading — only that button shows spinner */
  loadingKeys?: Set<string>;
  /** Keys that should be hidden */
  hiddenKeys?: Set<string>;
}

export function ActionMenu({
  visible, onClose, title, subtitle, badge,
  actions, onAction, loadingKeys = new Set(), hiddenKeys = new Set(),
}: ActionMenuProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const DEFS: ActionDef[] = [
    { key: 'edit',             label: 'Edit Profile',             icon: <Edit3 size={18} />,           color: c.primary },
    { key: 'unblock',          label: 'Unblock',                  icon: <UserCheck size={18} />,       color: '#16A34A' },
    { key: 'block',            label: 'Block',                    icon: <UserX size={18} />,           color: '#DC2626', danger: true },
    { key: 'reset_password',   label: 'Reset Password (Email)',   icon: <KeyRound size={18} />,        color: '#7C3AED' },
    { key: 'change_password',  label: 'Change Password',          icon: <KeyRound size={18} />,        color: '#7C3AED' },
    { key: 'promote_doctor',   label: 'Promote → Doctor',         icon: <ArrowUpCircle size={18} />,   color: '#16A34A' },
    { key: 'promote_admin',    label: 'Promote → Admin',          icon: <ArrowUpCircle size={18} />,   color: '#EF4444' },
    { key: 'demote_doctor',    label: 'Demote → Doctor',          icon: <ArrowDownCircle size={18} />, color: '#D97706' },
    { key: 'demote_student',   label: 'Demote → Student',         icon: <ArrowDownCircle size={18} />, color: '#D97706' },
    { key: 'unlimited_devices',label: 'Enable Unlimited Devices', icon: <Infinity size={18} />,        color: '#2DA8FF' },
    { key: 'limited_devices',  label: 'Disable Unlimited Devices',icon: <Settings size={18} />,        color: '#2DA8FF' },
    { key: 'devices',          label: 'Manage Devices',           icon: <Smartphone size={18} />,      color: '#2DA8FF' },
    { key: 'credits',          label: 'Credits',                  icon: <CreditCard size={18} />,      color: '#16A34A' },
    { key: 'timeline',         label: 'Activity Timeline',        icon: <Clock size={18} />,           color: c.primary },
    { key: 'credit_price',     label: 'Credit Selling Price',     icon: <Tag size={18} />,             color: '#7C3AED' },
    { key: 'earnings',         label: 'Earnings Dashboard',       icon: <TrendingUp size={18} />,      color: '#16A34A' },
    { key: 'audit',            label: 'Audit Logs',               icon: <FileText size={18} />,        color: '#7C3AED' },
    { key: 'login_history',    label: 'Login History',            icon: <History size={18} />,         color: '#6B7280' },
    { key: 'delete',           label: 'Delete Account',           icon: <Trash2 size={18} />,          color: '#DC2626', danger: true },
  ];

  const visible_actions = DEFS.filter(d => actions.includes(d.key) && !hiddenKeys.has(d.key));
  const anyLoading = loadingKeys.size > 0;

  return (
    <ResponsiveModal visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      {badge && <View style={{ marginBottom: 14 }}>{badge}</View>}
      <ScrollView style={{ maxHeight: 480 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: 6 }}>
          {visible_actions.map(def => (
            <ActionItem
              key={def.key}
              def={def}
              loading={loadingKeys.has(def.key)}
              anyLoading={anyLoading}
              onAction={onAction}
            />
          ))}
        </View>
      </ScrollView>
    </ResponsiveModal>
  );
}

function ActionItem({ def, loading, anyLoading, onAction }: {
  def: ActionDef; loading: boolean; anyLoading: boolean; onAction: (k: ActionKey) => void;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={() => !anyLoading && onAction(def.key)}
      disabled={anyLoading}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14,
        backgroundColor: pressed ? `${def.color}22` : def.danger ? `${def.color}12` : `${def.color}0E`,
        opacity: anyLoading && !loading ? 0.45 : 1,
      }}
    >
      {loading
        ? <ActivityIndicator size="small" color={def.color} style={{ width: 18 }} />
        : <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>{renderIcon(def.key, def.color)}</View>
      }
      <Text style={{ flex: 1, fontSize: 15, fontWeight: def.danger ? '700' : '600', color: def.color }}>
        {def.label}
      </Text>
    </Pressable>
  );
}

function renderIcon(key: ActionKey, color: string) {
  const props = { size: 18, color };
  switch (key) {
    case 'edit':             return <Edit3 {...props} />;
    case 'unblock':          return <UserCheck {...props} />;
    case 'block':            return <UserX {...props} />;
    case 'reset_password':   return <KeyRound {...props} />;
    case 'change_password':  return <KeyRound {...props} />;
    case 'promote_doctor':   return <ArrowUpCircle {...props} />;
    case 'promote_admin':    return <ArrowUpCircle {...props} />;
    case 'demote_doctor':    return <ArrowDownCircle {...props} />;
    case 'demote_student':   return <ArrowDownCircle {...props} />;
    case 'unlimited_devices':return <Infinity {...props} />;
    case 'limited_devices':  return <Settings {...props} />;
    case 'devices':          return <Smartphone {...props} />;
    case 'credits':          return <CreditCard {...props} />;
    case 'timeline':         return <Clock {...props} />;
    case 'audit':            return <FileText {...props} />;
    case 'login_history':    return <History {...props} />;
    case 'delete':           return <Trash2 {...props} />;
    default:                 return null;
  }
}
