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
  const { t, preference, setPreference, rtlNeedsRestart, isRTL } = useTranslation();
  // Alignment is decided by the APP language, not by the script of each label:
  // in English the Arabic option's name must not jump to the right edge just
  // because the text is Arabic (bidi would otherwise do exactly that).
  const labelAlign = isRTL ? 'right' as const : 'left' as const;
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

      {/* One card, one row per option, each row a full-width tappable target
          with its own border.

          WHAT WAS WRONG BEFORE:
            • rows used `justifyContent: 'space-between'` with a flex:1 label and
              no separation, so the two options ran together inside one box;
            • the selected indicator was a bare 18 dp Check floating at the
              trailing edge of whichever row was selected (and a 18 dp spacer on
              the others), so in RTL it could read as belonging to the gap
              between rows rather than to the selected option;
            • a long translated label (Arabic "استخدام لغة الجهاز") could push
              the check right up against the text.

          NOW: the marker is a fixed 22 dp radio that exists on EVERY row at the
          LEADING edge (inline-start, so it mirrors with the language for free).
          Its position never depends on label length, and the check can only
          ever sit beside its own option. */}
      <NeuCard radius={18} style={{ padding: 10, gap: 10 }}>
        {OPTIONS.map((opt) => {
          const selected = preference === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => void onSelect(opt.value)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: busy, busy: busy && selected }}
              accessibilityLabel={opt.hintKey ? `${t(opt.labelKey)}. ${t(opt.hintKey)}` : t(opt.labelKey)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 56,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: selected ? `${c.primary}66` : `${c.text}12`,
                backgroundColor: selected ? `${c.primary}12` : pressed ? `${c.text}0A` : 'transparent',
                opacity: busy ? 0.6 : 1,
              })}
            >
              {/* Radio marker — leading edge, present on every row. */}
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 2,
                  borderColor: selected ? c.primary : `${c.text}40`,
                  backgroundColor: selected ? `${c.primary}18` : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {busy && selected ? (
                  <ActivityIndicator size="small" color={c.primary} />
                ) : selected ? (
                  <Check size={14} color={c.primary} strokeWidth={3} />
                ) : null}
              </View>

              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: selected ? '800' : '600',
                    color: selected ? c.primary : c.text,
                    textAlign: labelAlign,
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
                      lineHeight: (layout.captionSize - 1) * 1.4,
                      textAlign: labelAlign,
                    }}
                  >
                    {t(opt.hintKey)}
                  </Text>
                ) : null}
              </View>
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
