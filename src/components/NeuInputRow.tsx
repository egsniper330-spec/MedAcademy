/**
 * NeuInputRow — reusable neumorphic TextInput row.
 *
 * Layout rules that prevent text clipping on every device:
 *  • Container: `flex-row` + `minWidth: 0` (allows shrink past intrinsic width)
 *  • TextInput:  `flex: 1` + `minWidth: 0` (never clips placeholder)
 *  • No fixed heights — vertical space comes from paddingVertical only
 *  • paddingVertical: 14 gives comfortable touch target (≥ 44 pt)
 *  • Works with Dynamic Island, notch, small Android, tablets, iPads
 */
import React from 'react';
import {
  View, TextInput, Text, Pressable,
  type TextInputProps, type ViewStyle, type TextStyle,
} from 'react-native';
import { neuColors } from '@/lib/neu';

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
  isDark,
  hasError,
  style,
  ...inputProps
}: NeuInputRowProps) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          minWidth: 0,                        // allow shrink on narrow screens
          backgroundColor: c.base,
          borderRadius: 13,
          paddingHorizontal: 14,
          paddingVertical: 14,
          marginBottom: 12,
          // neumorphic shadow
          shadowColor: hasError ? '#DC2626' : c.shadowDark,
          shadowOffset: { width: 2, height: 2 },
          shadowOpacity: hasError ? 0.8 : 0.55,
          shadowRadius: 5,
          // error border
          borderWidth: hasError ? 1 : 0,
          borderColor: hasError ? '#DC2626' : 'transparent',
        },
        containerStyle,
      ]}
    >
      {leftIcon ? (
        <View style={{ marginRight: 10, flexShrink: 0 }}>
          {leftIcon}
        </View>
      ) : null}

      <TextInput
        placeholderTextColor={`${c.text}50`}
        {...inputProps}
        style={[
          {
            flex: 1,
            minWidth: 0,                      // critical — prevents placeholder clip
            fontSize: 15,
            color: c.text,
            paddingVertical: 0,               // vertical space handled by container
          } as TextStyle,
          style,
        ]}
      />

      {rightElement ? (
        <View style={{ marginLeft: 8, flexShrink: 0 }}>
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
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          minWidth: 0,
          flex: 1,
          backgroundColor: c.base,
          borderRadius: 13,
          paddingHorizontal: 12,
          paddingVertical: 12,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 2, height: 2 },
          shadowOpacity: 0.45,
          shadowRadius: 5,
        },
        containerStyle,
      ]}
    >
      <View style={{ marginRight: 8, flexShrink: 0 }}>
        {leftIcon ?? <Search size={16} color={c.text} opacity={0.38} />}
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={`${c.text}50`}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        {...rest}
        style={{
          flex: 1,
          minWidth: 0,                        // prevents placeholder clip
          fontSize: 14,
          color: c.text,
          paddingVertical: 0,
        }}
      />
      {value.length > 0 && onClear ? (
        <Pressable onPress={onClear} style={{ padding: 4, marginLeft: 4, flexShrink: 0 }}>
          <X size={14} color={c.text} opacity={0.4} />
        </Pressable>
      ) : null}
    </View>
  );
}
