import { useState } from 'react';
import { View, Text, Image } from 'react-native';

/**
 * Student avatar — the REAL uploaded profile photo, with initials as the
 * fallback when the student has no photo or the image fails to load.
 * Shared by the Students page and the Dashboard's Latest Registrations so both
 * resolve `student.avatar_url` the same way.
 */
export function StudentAvatar({ student, size, radius, colors }: {
  student: any; size: number; radius: number; colors: any;
}) {
  const [failed, setFailed] = useState(false);
  const url = typeof student?.avatar_url === 'string' ? student.avatar_url.trim() : '';
  const initial = String(student?.full_name ?? '?').trim().charAt(0).toUpperCase() || '?';

  if (url !== '' && !failed) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: `${colors.primary}18` }}
        onError={() => setFailed(true)}
        resizeMode="cover"
        accessibilityLabel={student?.full_name ? String(student.full_name) : undefined}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: `${colors.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size * 0.36, fontWeight: '800', color: colors.primary }}>{initial}</Text>
    </View>
  );
}
