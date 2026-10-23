/**
 * BulkUserMenu — the overflow ("⋮") menu for a multi-user selection on the
 * Super Admin All Users screen.
 *
 * WHY A MENU AND NOT A ROW OF CHIPS
 * The chip bar could only fit a few actions and it offered Block/Unblock,
 * strings the backend's bulk endpoint does not accept (`bulk-user-ops` knows
 * suspend / unsuspend / reset_devices / reset_password / trash). That mismatch
 * turned a visible action into an error toast. A menu is the right container
 * for the full set, and each row here maps to an operation the backend
 * actually implements:
 *
 *   suspend        → POST /admin/bulk-user-ops { operation: 'suspend' }
 *   unsuspend      → … 'unsuspend'
 *   reset_devices  → … 'reset_devices'
 *   reset_password → … 'reset_password'  (emails a one-time reset link)
 *   trash          → … 'trash'           (soft delete, 30-day restore window)
 *
 * Password resets NEVER set or share a password: the backend issues one
 * one-time token per user and emails the link to that user's own address.
 *
 * Presentation follows ActionMenu (the single-user menu) so the same action
 * reads the same in both places: icon + label rows, danger tint for
 * destructive rows, and a spinner while the batch runs. Everything is a real
 * Pressable with an accessibility role, so it is keyboard/switch and
 * screen-reader reachable on web and native.
 */
import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, useColorScheme } from 'react-native';
import {
  UserX, UserCheck, Smartphone, KeyRound, Trash2,
} from 'lucide-react-native';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors } from '@/lib/neu';

/** Operations this menu can dispatch — mirrors the backend's bulk endpoint. */
export type BulkUserAction =
  | 'suspend'
  | 'unsuspend'
  | 'reset_devices'
  | 'reset_password'
  | 'trash';

interface RowDef {
  action: BulkUserAction;
  label: string;
  hint: string;
  color: string;
  danger?: boolean;
  Icon: React.ComponentType<{ size: number; color: string }>;
}

const ROWS: RowDef[] = [
  {
    action: 'suspend',
    label: 'Suspend selected',
    hint: 'Signs them out and blocks sign-in',
    color: '#D97706',
    danger: true,
    Icon: UserX,
  },
  {
    action: 'unsuspend',
    label: 'Unsuspend selected',
    hint: 'Restores sign-in; security policy still applies',
    color: '#16A34A',
    Icon: UserCheck,
  },
  {
    action: 'reset_devices',
    label: 'Reset registered devices',
    hint: 'Revokes every device and live session',
    color: '#6366F1',
    Icon: Smartphone,
  },
  {
    action: 'reset_password',
    label: 'Send password reset links',
    hint: 'One single-use link per user, emailed to them',
    color: '#7C3AED',
    Icon: KeyRound,
  },
  {
    action: 'trash',
    label: 'Move to trash',
    hint: 'Soft delete — restorable for 30 days',
    color: '#DC2626',
    danger: true,
    Icon: Trash2,
  },
];

/** Dark-mode ink so every label keeps AA contrast on the elevated surface. */
const DARK_INK: Record<string, string> = {
  '#D97706': '#FBBF24',
  '#16A34A': '#4ADE80',
  '#6366F1': '#A5B4FC',
  '#7C3AED': '#A78BFA',
  '#DC2626': '#F87171',
};

export interface BulkUserMenuProps {
  visible: boolean;
  onClose: () => void;
  /** How many users are selected — shown in the header, never in a label. */
  count: number;
  /** The batch currently running (spinner + disabled rows), or null. */
  running: BulkUserAction | null;
  onAction: (action: BulkUserAction) => void;
}

export function BulkUserMenu({ visible, onClose, count, running, onAction }: BulkUserMenuProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <ResponsiveModal
      visible={visible}
      onClose={onClose}
      title="Bulk actions"
      subtitle={`${count} user${count === 1 ? '' : 's'} selected`}
    >
      <View style={{ gap: 6 }}>
        {ROWS.map((row) => (
          <BulkRow
            key={row.action}
            row={row}
            isDark={isDark}
            textColor={c.text}
            running={running}
            onPress={() => {
              if (running) return;
              onAction(row.action);
            }}
          />
        ))}
      </View>
    </ResponsiveModal>
  );
}

function BulkRow({
  row, isDark, textColor, running, onPress,
}: {
  row: RowDef;
  isDark: boolean;
  textColor: string;
  running: BulkUserAction | null;
  onPress: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  const ink = isDark ? (DARK_INK[row.color] ?? row.color) : row.color;
  const isRunning = running === row.action;
  const disabled = running !== null;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={row.label}
      accessibilityHint={row.hint}
      accessibilityState={{ disabled, busy: isRunning }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        borderRadius: 14,
        backgroundColor: `${ink}${pressed ? '2E' : isDark ? '1F' : row.danger ? '12' : '0E'}`,
        opacity: disabled && !isRunning ? 0.45 : 1,
      }}
    >
      {isRunning
        ? <ActivityIndicator size="small" color={ink} style={{ width: 18 }} />
        : <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
            <row.Icon size={18} color={ink} />
          </View>}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: row.danger ? '700' : '600', color: ink }}>
          {row.label}
        </Text>
        <Text style={{ fontSize: 12, marginTop: 2, color: isDark ? '#A9BFD6' : `${textColor}88` }}>
          {row.hint}
        </Text>
      </View>
    </Pressable>
  );
}
