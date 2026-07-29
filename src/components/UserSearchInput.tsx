// src/components/UserSearchInput.tsx
// Universal user search input — finds users by name, email, phone, or user_id.
// Used by credits, activation codes, course grant, and user management screens.

import { useState, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, ActivityIndicator, useColorScheme,
} from 'react-native';
import { Search, X, Mail, Phone, Hash, User } from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { detectIdentifierType } from '@/lib/identifier';
import { displayPhoneNational } from '@/lib/phone';
import { neuColors } from '@/lib/neu';
import { NeuCard } from '@/components/NeuCard';

export interface SearchedUser {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  phone_e164: string | null;
  role: string;
  status: string;
  watermark_id: string;
  qr_code_id: string;
}

interface Props {
  onSelect: (user: SearchedUser) => void;
  onClear?: () => void;            // optional callback when search is cleared
  placeholder?: string;
  allowedRoles?: string[];         // if set, only show users with these roles
  excludeIds?: string[];           // exclude certain user IDs from results
  label?: string;
}

export function UserSearchInput({
  onSelect,
  onClear,
  placeholder = 'Name, email, phone, or user ID…',
  allowedRoles,
  excludeIds = [],
  label = 'Find User',
}: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchedUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const identType = detectIdentifierType(query);

  const IdentIcon =
    identType === 'email' ? Mail :
    identType === 'phone' ? Phone :
    identType === 'user_id' ? Hash :
    User;

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setSearching(true);
    setSearched(false);

    try {
      const { data, error } = await supabase.rpc('lookup_user_by_identifier', {
        p_identifier: trimmed,
      });

      if (error) throw error;

      let filtered: SearchedUser[] = (data ?? []) as SearchedUser[];

      if (allowedRoles?.length) {
        filtered = filtered.filter(u => allowedRoles.includes(u.role));
      }
      if (excludeIds.length) {
        filtered = filtered.filter(u => !excludeIds.includes(u.id));
      }

      setResults(filtered);
      setSearched(true);
    } catch (_) {
      setResults([]);
      setSearched(true);
    }

    setSearching(false);
  }, [query, allowedRoles, excludeIds]);

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setSearched(false);
    onClear?.();
  };

  const handleSelect = (user: SearchedUser) => {
    onSelect(user);
    setQuery('');
    setResults([]);
    setSearched(false);
  };

  return (
    <View>
      <Text style={{
        fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55,
        marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8,
      }}>
        {label}
      </Text>

      {/* Input row */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.base, borderRadius: 12,
        paddingHorizontal: 14, paddingVertical: 13, marginBottom: 4,
        minWidth: 0,
        shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
        shadowOpacity: 0.6, shadowRadius: 5,
      }}>
        <IdentIcon size={18} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
        <TextInput
          value={query}
          onChangeText={t => { setQuery(t); setSearched(false); }}
          onSubmitEditing={runSearch}
          placeholder={placeholder}
          placeholderTextColor={`${c.text}55`}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ flex: 1, minWidth: 0, marginLeft: 10, fontSize: 15, color: c.text, paddingVertical: 0 }}
        />
        {query.length > 0 && (
          <Pressable onPress={handleClear} style={{ marginLeft: 8, flexShrink: 0 }}>
            <X size={16} color={c.text} opacity={0.4} />
          </Pressable>
        )}
        <Pressable
          onPress={runSearch}
          style={{
            marginLeft: 8, backgroundColor: c.primary, borderRadius: 8,
            paddingHorizontal: 10, paddingVertical: 6,
          }}>
          {searching
            ? <ActivityIndicator size="small" color="#fff" />
            : <Search size={14} color="#fff" />}
        </Pressable>
      </View>

      {/* Hint */}
      {query.length > 0 && query.length < 2 && (
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginBottom: 4, marginLeft: 2 }}>
          Type at least 2 characters to search
        </Text>
      )}

      {/* Results dropdown */}
      {searched && results.length === 0 && (
        <NeuCard radius={12} style={{ padding: 14, marginTop: 4 }}>
          <Text style={{ color: c.text, opacity: 0.4, fontSize: 13, textAlign: 'center' }}>
            {`No user found for "${query}"`}
          </Text>
        </NeuCard>
      )}

      {results.length > 0 && (
        <NeuCard radius={12} style={{ marginTop: 4, padding: 4 }}>
          {results.map((user, idx) => (
            <Pressable
              key={user.id}
              onPress={() => handleSelect(user)}
              style={{
                paddingHorizontal: 14, paddingVertical: 12,
                borderBottomWidth: idx < results.length - 1 ? 1 : 0,
                borderBottomColor: `${c.text}08`,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{
                  width: 36, height: 36, borderRadius: 10,
                  backgroundColor: `${c.primary}18`,
                  alignItems: 'center', justifyContent: 'center', marginRight: 10,
                }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: c.primary }}>
                    {user.full_name?.[0]?.toUpperCase() ?? '?'}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{user.full_name}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }} numberOfLines={1}>
                    {user.email}
                  </Text>
                  {user.phone_e164 && (
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>{displayPhoneNational(user.phone_e164)}</Text>
                  )}
                </View>
                <View style={{
                  backgroundColor: roleColor(user.role) + '20',
                  borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: roleColor(user.role), textTransform: 'uppercase' }}>
                    {user.role}
                  </Text>
                </View>
              </View>
            </Pressable>
          ))}
        </NeuCard>
      )}
    </View>
  );
}

function roleColor(r: string) {
  const m: Record<string, string> = {
    student: '#3B82F6', doctor: '#7C3AED',
    admin: '#EF4444', super_admin: '#DC2626',
  };
  return m[r] ?? '#6B7280';
}
