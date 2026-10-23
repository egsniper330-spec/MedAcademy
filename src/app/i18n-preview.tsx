/**
 * TEMPORARY verification harness — renders the real info pages outside the
 * authenticated (app) group so they can be inspected in the browser after the
 * dev session was lost. DELETED immediately after verification.
 */
import { useState } from 'react';
import { View, Text, Pressable, useColorScheme } from 'react-native';
import AboutPage from './(app)/info/about';
import ContactPage from './(app)/info/contact';
import TermsPage from './(app)/info/terms';
import PrivacyPage from './(app)/info/privacy';
import { setLanguagePreference, useTranslation } from '@/lib/i18n';

const PAGES = ['About', 'Terms', 'Privacy', 'Contact'] as const;

export default function I18nPreview() {
  const [page, setPage] = useState<typeof PAGES[number]>('About');
  const isDark = useColorScheme() === 'dark';
  const { locale } = useTranslation();
  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0B1220' : '#F2F5FA' }}>
      <View style={{ flexDirection: 'row', gap: 8, padding: 10, paddingTop: 40 }}>
        {PAGES.map((p) => (
          <Pressable key={p} onPress={() => setPage(p)} style={{ padding: 8, backgroundColor: page === p ? '#2563EB' : '#94A3B8', borderRadius: 8 }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{p}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => { void setLanguagePreference(locale === 'ar' ? 'en' : 'ar'); }}
          style={{ padding: 8, backgroundColor: '#16A34A', borderRadius: 8 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>{locale === 'ar' ? '→ EN' : '→ AR'}</Text>
        </Pressable>
      </View>
      {page === 'About' && <AboutPage />}
      {page === 'Terms' && <TermsPage />}
      {page === 'Privacy' && <PrivacyPage />}
      {page === 'Contact' && <ContactPage />}
    </View>
  );
}
