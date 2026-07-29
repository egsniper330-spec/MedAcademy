/**
 * BulkSelectBar — floats above content when items are selected.
 * Provides: Trash, Block, Unblock, Reset Devices, Reset Password actions.
 * Also supports role-specific: Add Credits, Remove Credits, Unlimited Devices (doctors).
 */
import { View, Text, Pressable, ActivityIndicator, useColorScheme, ScrollView } from 'react-native';
import {
  Trash2, UserCheck, UserX, Smartphone, KeyRound, X,
  PlusCircle, MinusCircle, Infinity,
} from 'lucide-react-native';
import { neuColors } from '@/lib/neu';

export type BulkAction =
  | 'trash' | 'block' | 'unblock'
  | 'reset_devices' | 'reset_password'
  | 'add_credits' | 'remove_credits' | 'unlimited_devices';

interface BulkSelectBarProps {
  count: number;
  role?: string; // 'student' | 'doctor' | 'admin' — controls which actions appear
  loading?: boolean;
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}

interface ActionDef {
  id: BulkAction;
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  roles?: string[]; // undefined = all roles
}

const ACTIONS: ActionDef[] = [
  { id: 'trash',           label: 'Delete',         icon: Trash2,       color: '#EF4444' },
  { id: 'block',           label: 'Block',          icon: UserX,        color: '#DC2626' },
  { id: 'unblock',         label: 'Unblock',        icon: UserCheck,    color: '#16A34A' },
  { id: 'reset_devices',   label: 'Reset Devices',  icon: Smartphone,   color: '#6366F1' },
  { id: 'reset_password',  label: 'Reset Password', icon: KeyRound,     color: '#0EA5E9' },
  { id: 'add_credits',     label: 'Add Credits',    icon: PlusCircle,   color: '#16A34A', roles: ['doctor'] },
  { id: 'remove_credits',  label: 'Rm Credits',     icon: MinusCircle,  color: '#EF4444', roles: ['doctor'] },
  { id: 'unlimited_devices', label: 'Unlimited',    icon: Infinity,     color: '#7C3AED', roles: ['doctor'] },
];

export function BulkSelectBar({ count, role, loading, onAction, onClear }: BulkSelectBarProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const visibleActions = ACTIONS.filter(a => !a.roles || (role && a.roles.includes(role)));

  return (
    <View style={{
      backgroundColor: c.base,
      borderTopWidth: 1,
      borderTopColor: `${c.text}12`,
      shadowColor: c.shadowDark,
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.5,
      shadowRadius: 12,
      elevation: 10,
      paddingBottom: 8,
    }}>
      {/* Count row */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ backgroundColor: `${c.primary}20`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>{count} selected</Text>
          </View>
          {loading && <ActivityIndicator size="small" color={c.primary} />}
        </View>
        <Pressable onPress={onClear} hitSlop={8}
          style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: `${c.text}0F`, alignItems: 'center', justifyContent: 'center' }}>
          <X size={16} color={`${c.text}80`} />
        </Pressable>
      </View>

      {/* Action chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, flexDirection: 'row' }}>
        {visibleActions.map(a => (
          <Pressable
            key={a.id}
            onPress={() => !loading && onAction(a.id)}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: `${a.color}18`,
              borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
              borderWidth: 1.5, borderColor: `${a.color}30`,
              opacity: loading ? 0.5 : 1,
            }}
          >
            <a.icon size={14} color={a.color} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: a.color }}>{a.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
