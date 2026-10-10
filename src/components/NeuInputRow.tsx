/**
 * NeuInputRow — reusable neumorphic TextInput row.
 *
 * Layout rules that prevent text clipping on every device:
 *  • Container: `flex-row` + `minWidth: 0` (allows shrink past intrinsic width)
 *  • TextInput:  `flex: 1` + `minWidth: 0` (never clips placeholder)
 *  • No fixed heights — vertical space comes from paddingVertical only
 *  • paddingVertical from ds.spacing.md gives comfortable touch target (≥ 44 pt)
 *  • Works with Dynamic Island, notch, small Android, tablets, iPads
 */
import React from 'react';
import {
  View, TextInput, Text, Pressable, useColorScheme,
  type TextInputProps, type ViewStyle, type TextStyle,
} from 'react-native';
import { neuColors } from '@/lib/neu';
import { spacing, radius, typography } from '@/lib/ds';

export interface NeuInputRowProps extends TextInputProps {
  /** Left icon element (e.g. <Mail size={18} color={...} />) */
  leftIcon?: React.ReactNode;
  /** Right element (e.g. eye toggle, badge) */
  rightElement?: React.ReactNode;
  /** Override container style */
  containerStyle?: ViewStyle;
  /** Colour palette — pass `isDark ? neuColors.dark : neuColors.light` */
  c: typeof neuColors.light;
  isDark?: boolean;
  /** Error state — highlights border in red */
  hasError?: boolean;
}

export function NeuInputRow({
  leftIcon,
  rightElement,
  containerStyle,
  c,
  isDark: isDarkProp,
  hasError,
  style,
  ...inputProps
}: NeuInputRowProps) {
  // Hook first, unconditionally — the prop only overrides the result.
  const schemeIsDark = useColorScheme() === 'dark';
  const isDark = isDarkProp ?? schemeIsDark;
  // Recessed step of the surface ladder: an input painted the card colour is
  // indistinguishable from the card it sits on. In Light every surface token is
  // #E8EEF6, so this is the same colour as before.
  //
  // Dark also needs an explicit edge — the neumorphic shadow that separates an
  // input from its card in Light is invisible against deep navy.
  const fieldBorder = hasError ? '#DC2626' : isDark ? c.border : 'transparent';
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          minWidth: 0,                        // allow shrink on narrow screens
          backgroundColor: c.inputSurface,
          borderRadius: radius.md,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          marginBottom: spacing.md,
          // neumorphic shadow
          shadowColor: hasError ? '#DC2626' : c.shadowDark,
          shadowOffset: { width: 2, height: 2 },
          shadowOpacity: hasError ? 0.8 : 0.55,
          shadowRadius: 5,
          // error border (or the dark hairline that gives the field its edge)
          borderWidth: hasError || isDark ? 1 : 0,
          borderColor: fieldBorder,
        },
        containerStyle,
      ]}
    >
      {leftIcon ? (
        <View style={{ marginRight: spacing.sm, flexShrink: 0 }}>
          {leftIcon}
        </View>
      ) : null}

      <TextInput
        // Dark placeholders use the solid `textSubtle` tier: `${text}50` over the
        // dark input surface measures 2.5:1 — present, but unreadable.
        placeholderTextColor={isDark ? c.textSubtle : `${c.text}50`}
        {...inputProps}
        style={[
          {
            flex: 1,
            minWidth: 0,                      // critical — prevents placeholder clip
            ...typography.label,
            color: c.text,
            paddingVertical: 0,               // vertical space handled by container
          } as TextStyle,
          style,
        ]}
      />

      {rightElement ? (
        <View style={{ marginLeft: spacing.sm, flexShrink: 0 }}>
          {rightElement}
        </View>
      ) : null}
    </View>
  );
}

// ─── NeuSearchBar ─────────────────────────────────────────────────────────────
import { Search, X } from 'lucide-react-native';

export interface NeuSearchBarProps extends Omit<TextInputProps, 'style'> {
  value: string;
  onChangeText: (v: string) => void;
  onClear?: () => void;
  c: typeof neuColors.light;
  containerStyle?: ViewStyle;
  /** Optional element replacing the default Search icon (e.g. an ActivityIndicator) */
  leftIcon?: React.ReactNode;
}

export function NeuSearchBar({
  value,
  onChangeText,
  onClear,
  c,
  containerStyle,
  placeholder = 'Search…',
  leftIcon,
  ...rest
}: NeuSearchBarProps) {
  const isDark = useColorScheme() === 'dark';
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          minWidth: 0,
          flex: 1,
          backgroundColor: c.inputSurface,
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.md,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 2, height: 2 },
          shadowOpacity: 0.45,
          shadowRadius: 5,
          borderWidth: isDark ? 1 : 0,
          borderColor: c.border,
        },
        containerStyle,
      ]}
    >
      <View style={{ marginRight: spacing.sm, flexShrink: 0 }}>
        {leftIcon ?? <Search size={16} color={isDark ? c.textMuted : c.text} opacity={isDark ? 1 : 0.38} />}
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={isDark ? c.textSubtle : `${c.text}50`}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        {...rest}
        style={{
          flex: 1,
          minWidth: 0,                        // prevents placeholder clip
          ...typography.body,
          color: c.text,
          paddingVertical: 0,
        }}
      />
      {value.length > 0 && onClear ? (
        <Pressable onPress={onClear} style={{ padding: spacing.xs, marginLeft: spacing.xs, flexShrink: 0 }}>
          <X size={14} color={isDark ? c.textMuted : c.text} opacity={isDark ? 1 : 0.4} />
        </Pressable>
      ) : null}
    </View>
  );
}
