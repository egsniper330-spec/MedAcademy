/**
 * LanguageSetting — the in-app "App Language / لغة التطبيق" selector.
 *
 * Behaviour (all of it is decided by src/lib/i18n):
 *  • "System default" is the initial state and simply removes the stored
 *    override, so device-language detection resumes immediately.
 *  • Picking العربية / English persists the override first and applies it in
 *    the same call — what you see is always what was stored (`persisted:false`
 *    surfaces a warning instead of a silent mismatch).
 *  • Nothing here touches the session, tokens or navigation: the language
 *    store repaints the tree in place.
 *  • Native RTL direction changes need a relaunch to mirror the layout, so the
 *    result reports it and the UI explains it instead of pretending. Web flips
 *    `document.dir` immediately and never needs one.
 *  • The row itself uses non-directional icons only (Globe / Check) and a
 *    `space-between` row, which mirrors correctly in both directions.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, Text, useColorScheme, View } from 'react-native';
import { Check, Globe } from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { useTranslation, type LanguagePreference } from '@/lib/i18n';

interface Option {
  value: LanguagePreference;
  labelKey: string;
  hintKey?: string;
}

const OPTIONS: Option[] = [
  { value: 'system', labelKey: 'language.optionSystem', hintKey: 'language.optionSystemHint' },
  { value: 'ar', labelKey: 'language.optionArabic' },
  { value: 'en', labelKey: 'language.optionEnglish' },
];

export function LanguageSetting({ style }: { style?: object }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { t, preference, setPreference, rtlNeedsRestart } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const onSelect = async (next: LanguagePreference) => {
    if (busy || next === preference) return;
    setBusy(true);
    try {
      const result = await setPreference(next);
      if (!result.persisted) {
        // Never pretend: the session shows the new language, but it will not
        // survive a restart — say so explicitly.
        showToast({ type: 'error', message: t('language.saveFailed') });
      } else {
        showToast({ type: 'success', message: t('language.saved') });
        if (result.rtlNeedsRestart) {
          showToast({
            type: 'info',
            message: t(result.locale === 'ar' ? 'language.rtlRestartHint' : 'language.ltrRestartHint'),
          });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[{ marginBottom: 20 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Globe size={14} color={`${c.text}99`} />
        <Text
          accessibilityRole="header"
          style={{
            fontSize: layout.captionSize - 1,
            fontWeight: '800',
            color: `${c.text}99`,
            textTransform: 'uppercase',
            letterSpacing: 0.9,
          }}
        >
          {t('language.section')}
        </Text>
      </View>

      <NeuCard radius={18} style={{ padding: 12 }}>
        {OPTIONS.map((opt) => {
          const selected = preference === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => void onSelect(opt.value)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: busy, busy: busy && selected }}
              accessibilityLabel={t(opt.labelKey)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: layout.pad.md,
                paddingHorizontal: layout.pad.sm,
                borderRadius: layout.pad.sm,
                backgroundColor: selected ? `${c.primary}14` : pressed ? `${c.text}0A` : 'transparent',
                opacity: busy ? 0.6 : 1,
              })}
            >
              <View style={{ flex: 1, paddingEnd: 12 }}>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: selected ? '800' : '600',
                    color: selected ? c.primary : c.text,
                  }}
                >
                  {t(opt.labelKey)}
                </Text>
                {opt.hintKey ? (
                  <Text
                    style={{
                      fontSize: layout.captionSize - 1,
                      ...mutedTextStyle(c, 0.5),
                      marginTop: 2,
                    }}
                  >
                    {t(opt.hintKey)}
                  </Text>
                ) : null}
              </View>

              {busy && selected ? (
                <ActivityIndicator size="small" color={c.primary} />
              ) : selected ? (
                <Check size={18} color={c.primary} />
              ) : (
                <View style={{ width: 18, height: 18 }} />
              )}
            </Pressable>
          );
        })}

        {rtlNeedsRestart && preference === 'ar' ? (
          <Text
            style={{
              fontSize: layout.captionSize - 1,
              ...mutedTextStyle(c, 0.55),
              marginTop: 6,
              paddingHorizontal: layout.pad.sm,
              lineHeight: (layout.captionSize - 1) * 1.5,
            }}
          >
            {t('language.rtlRestartHint')}
          </Text>
        ) : null}
      </NeuCard>
    </View>
  );
}

export default LanguageSetting;
