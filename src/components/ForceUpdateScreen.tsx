/**
 * ForceUpdateScreen.tsx
 *
 * A full-screen, non-dismissible update wall shown when the installed app
 * version is below the minimum_supported_version configured in security_config.
 *
 * Design: Neumorphic — matches the rest of the MedAcademy security screens
 * (security-warning.tsx, account-suspended.tsx, etc.).
 *
 * Behavior:
 *  • Covers the ENTIRE screen — rendered above the Stack navigator in _layout.tsx.
 *  • Android hardware Back button is intercepted and IGNORED.
 *  • The only available action is "Update Now" → opens the app store.
 *  • No navigation, no login, no video playback is possible while shown.
 *  • Automatically re-evaluates on app foreground (via useForceUpdate).
 */

import React, { useEffect } from 'react';
import {
  View, Text, ScrollView, useColorScheme, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RefreshCcw, ArrowUpCircle, Star, Package } from 'lucide-react-native';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import type { ForceUpdateState } from '@/lib/useForceUpdate';

interface ForceUpdateScreenProps extends ForceUpdateState {
  /** Whether this is a soft (dismissible) update banner vs a hard block. */
  soft?: boolean;
  /** Called when the user dismisses the soft update banner. */
  onDismiss?: () => void;
}

export function ForceUpdateScreen({
  isForceUpdateRequired,
  isSoftUpdateAvailable,
  installedVersion,
  minimumVersion,
  latestVersion,
  updateTitle,
  updateMessage,
  openStore,
  soft = false,
  onDismiss,
}: ForceUpdateScreenProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const insets = useSafeAreaInsets();

  // ── Intercept Android hardware Back button ─────────────────────────────────
  // Only block Back when this is a hard force-update (not a soft banner).
  useEffect(() => {
    if (soft) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Return true = event handled = back navigation suppressed
      return true;
    });
    return () => sub.remove();
  }, [soft]);

  const isHardBlock = isForceUpdateRequired && !soft;
  const accentColor = isHardBlock ? '#EF4444' : '#F59E0B';

  // Safe bottom: home indicator / gesture bar / Android nav bar + breathing room
  const safePaddingBottom = Math.max(insets.bottom + 24, 48);
  // Safe top: status bar / notch / Dynamic Island + breathing room
  const safePaddingTop = Math.max(insets.top + 16, 32);

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 24,
          paddingTop: safePaddingTop,
          paddingBottom: safePaddingBottom,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
        }}
        // Prevent pull-to-refresh gestures from doing anything
        bounces={false}
        scrollEnabled={false}
      >

        {/* ── Icon / Illustration ──────────────────────────────────────────── */}
        <View style={[flat, {
          width: 120, height: 120, borderRadius: 36,
          alignItems: 'center', justifyContent: 'center',
        }]}>
          <View style={{
            width: 88, height: 88, borderRadius: 26,
            backgroundColor: `${accentColor}18`,
            alignItems: 'center', justifyContent: 'center',
          }}>
            {isHardBlock
              ? <RefreshCcw size={48} color={accentColor} strokeWidth={1.6} />
              : <ArrowUpCircle size={48} color={accentColor} strokeWidth={1.6} />
            }
          </View>
        </View>

        {/* ── Title + message ──────────────────────────────────────────────── */}
        <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 8 }}>
          <Text style={{
            fontSize: 26, fontWeight: '800', color: c.text,
            textAlign: 'center', letterSpacing: -0.3,
          }}>
            {updateTitle}
          </Text>
          <Text style={{
            fontSize: 15, color: `${c.text}AA`, textAlign: 'center',
            lineHeight: 22, maxWidth: 320,
          }}>
            {updateMessage}
          </Text>
        </View>

        {/* ── Version card ─────────────────────────────────────────────────── */}
        <View style={[flat, {
          borderRadius: 20, padding: 20, width: '100%',
          gap: 14,
        }]}>
          <Text style={{
            fontSize: 11, fontWeight: '600', color: `${c.text}66`,
            letterSpacing: 1.2, textTransform: 'uppercase', textAlign: 'center',
          }}>
            Version Info
          </Text>

          {/* Installed */}
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{
                width: 32, height: 32, borderRadius: 10,
                backgroundColor: `${c.text}12`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Package size={16} color={`${c.text}88`} />
              </View>
              <Text style={{ fontSize: 14, color: `${c.text}88`, fontWeight: '500' }}>
                Installed
              </Text>
            </View>
            <Text style={{
              fontSize: 15, fontWeight: '700', color: c.text,
              fontVariant: ['tabular-nums'],
            }}>
              v{installedVersion}
            </Text>
          </View>

          <View style={{
            height: 1, backgroundColor: `${c.text}12`, marginHorizontal: 4,
          }} />

          {/* Latest */}
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{
                width: 32, height: 32, borderRadius: 10,
                backgroundColor: `${accentColor}18`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Star size={16} color={accentColor} />
              </View>
              <Text style={{ fontSize: 14, color: `${c.text}88`, fontWeight: '500' }}>
                Latest
              </Text>
            </View>
            <Text style={{
              fontSize: 15, fontWeight: '700', color: accentColor,
              fontVariant: ['tabular-nums'],
            }}>
              v{latestVersion}
            </Text>
          </View>

          {/* Hard-block: also show minimum required */}
          {isHardBlock && (
            <>
              <View style={{
                height: 1, backgroundColor: `${c.text}12`, marginHorizontal: 4,
              }} />
              <View style={{
                flexDirection: 'row', alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{
                    width: 32, height: 32, borderRadius: 10,
                    backgroundColor: '#EF444418',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <RefreshCcw size={16} color="#EF4444" />
                  </View>
                  <Text style={{ fontSize: 14, color: `${c.text}88`, fontWeight: '500' }}>
                    Minimum Required
                  </Text>
                </View>
                <Text style={{
                  fontSize: 15, fontWeight: '700', color: '#EF4444',
                  fontVariant: ['tabular-nums'],
                }}>
                  v{minimumVersion}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* ── Hard-block notice ────────────────────────────────────────────── */}
        {isHardBlock && (
          <View style={[flat, {
            borderRadius: 16, padding: 16, width: '100%',
            flexDirection: 'row', alignItems: 'flex-start', gap: 12,
            borderLeftWidth: 4, borderLeftColor: '#EF4444',
          }]}>
            <RefreshCcw size={18} color="#EF4444" style={{ marginTop: 1 }} />
            <Text style={{
              flex: 1, fontSize: 13, color: c.text, lineHeight: 19,
            }}>
              This version is no longer supported. You must update before continuing to use the app.
            </Text>
          </View>
        )}

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <View style={{ width: '100%', gap: 12 }}>
          <NeuButton
            label="Update Now"
            icon={<ArrowUpCircle size={18} color="#fff" />}
            onPress={openStore}
            variant="primary"
            fullWidth
            style={{ paddingVertical: 16 }}
          />

          {/* Soft updates are dismissible; hard blocks show no dismiss option. */}
          {soft && onDismiss && (
            <NeuButton
              label="Maybe Later"
              onPress={onDismiss}
              variant="secondary"
              fullWidth
            />
          )}
        </View>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <Text style={{
          fontSize: 11, color: `${c.text}44`, textAlign: 'center',
          lineHeight: 16,
        }}>
          MedAcademy Mobile App{'\n'}
          {isHardBlock
            ? 'App access is restricted until the update is installed.'
            : 'Your current version will continue to work after dismissing.'}
        </Text>

      </ScrollView>
    </View>
  );
}
