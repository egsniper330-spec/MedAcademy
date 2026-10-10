/**
 * ActionMenu — modern bottom-sheet action menu for user/admin/doctor cards.
 * Groups actions by category with icons, danger styling, and disables while
 * any action is running.
 */
import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, useColorScheme, ScrollView } from 'react-native';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors } from '@/lib/neu';

/**
 * actionInk — dark-mode ink for the action palette.
 *
 * The DEFS table below carries the canonical LIGHT hex for each action. Those
 * mids (#16A34A green, #DC2626 red, #D97706 amber, #7C3AED purple, #6B7280
 * grey) are chosen to read on the light neumorphic base; pasted onto the dark
 * elevated surface they measure 2.1–3.6:1, i.e. an action menu whose labels
 * fail AA. Rather than fork the table (and risk the two drifting apart), the
 * dark partner is resolved here at render time — one place to keep honest.
 *
 * Every dark partner measures ≥4.5:1 on `elevated`:
 *   #4ADE80 7.4:1 · #F87171 4.7:1 · #FBBF24 6.9:1 · #A78BFA 4.7:1 · #A9BFD6 5.0:1
 */
const DARK_ACTION_INK: Record<string, string> = {
  '#16A34A': '#4ADE80', // success — unblock / credits / push
  '#DC2626': '#F87171', // destructive — block / delete
  '#EF4444': '#F87171', // destructive — promote to admin
  '#D97706': '#FBBF24', // warning — suspend / demote
  '#7C3AED': '#A78BFA', // admin — password / audit / price
  '#6B7280': '#A9BFD6', // neutral — login history
};

const actionInk = (hex: string, isDark: boolean): string =>
  isDark ? (DARK_ACTION_INK[hex.toUpperCase()] ?? hex) : hex;
import {
  Edit3, UserCheck, UserX, KeyRound, ArrowUpCircle, ArrowDownCircle,
  Trash2, Smartphone, CreditCard, Clock, FileText, History,
  Infinity, Settings, Tag, TrendingUp,
} from 'lucide-react-native';

export type ActionKey =
  | 'edit' | 'block' | 'unblock' | 'suspend' | 'unsuspend' | 'reset_password' | 'change_password'
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
    // SUSPENDED → UNSUSPEND (restores account access; security suspension
    // included — see actionsForUser/actionsForRole in the Users screens).
    { key: 'unsuspend',        label: 'Unsuspend',                icon: <UserCheck size={18} />,       color: '#16A34A' },
    { key: 'suspend',          label: 'Suspend',                  icon: <UserX size={18} />,           color: '#D97706', danger: true },
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
      <View style={{ gap: 6 }}>
        {visible_actions.map(def => (
          <ActionItem
            key={def.key}
            def={def}
            loading={loadingKeys.has(def.key)}
            anyLoading={anyLoading}
            onAction={onAction}
            isDark={isDark}
          />
        ))}
      </View>
    </ResponsiveModal>
  );
}

function ActionItem({ def, loading, anyLoading, onAction, isDark }: {
  def: ActionDef; loading: boolean; anyLoading: boolean; onAction: (k: ActionKey) => void; isDark: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  // Dark gets the bright ink partner, and a tint strong enough to read as a row
  // on the elevated surface (6–8% alpha was near-invisible on navy).
  const ink = actionInk(def.color, isDark);
  const restAlpha = isDark ? '1F' : def.danger ? '12' : '0E';
  return (
    <Pressable
      onPress={() => !anyLoading && onAction(def.key)}
      disabled={anyLoading}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14,
        backgroundColor: `${ink}${pressed ? '2E' : restAlpha}`,
        opacity: anyLoading && !loading ? 0.45 : 1,
      }}
    >
      {loading
        ? <ActivityIndicator size="small" color={ink} style={{ width: 18 }} />
        : <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>{renderIcon(def.key, ink)}</View>
      }
      <Text style={{ flex: 1, fontSize: 15, fontWeight: def.danger ? '700' : '600', color: ink }}>
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
    case 'unsuspend':        return <UserCheck {...props} />;
    case 'suspend':          return <UserX {...props} />;
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
