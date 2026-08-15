/**
 * /diag — Standalone diagnostic screen.
 *
 * CRITICAL DESIGN RULE: This file MUST NOT import anything from:
 *   @/ctx, @/lib/SecurityContext, @/lib/store, @/client/supabase,
 *   or any component that transitively imports those.
 *
 * The screen is registered as a BARE Stack.Screen in the root _layout.tsx
 * OUTSIDE all Stack.Protected guards and outside SessionProvider /
 * SecurityProvider. It therefore renders even when the normal app UI is
 * completely black.
 *
 * Access on-device (Windows-compatible):
 *   Method A — Contacts deep-link trick (no special app needed):
 *     1. Open the built-in Contacts app on the iPhone.
 *     2. Create a new contact, tap "add URL", paste:
 *          medacademy:///diag
 *     3. Tap the URL → the app opens at /diag directly.
 *
 *   Method B — Safari address bar:
 *     Open Safari on the iPhone, type: medacademy:///diag  → Go.
 *
 *   Method C — Any deep-link app (Keewordz, etc.) or a QR code.
 *
 * What it shows:
 *   • Current-session log (live from AsyncStorage, auto-refreshed on mount)
 *   • Previous-session log (persisted from last launch — useful after crash)
 *   • A COPY button that builds a plain-text export and fires the HTTP beacon
 *   • The full log as scrollable monospace text, colour-coded by tag
 *
 * Remove this file (and its Stack.Screen registration in _layout.tsx) once
 * diagnosis is complete.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Share,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDiagEntries,
  loadPersistedDiag,
  getDiagSessionId,
  buildLogText,
  STORAGE_KEY,
  type DiagEntry,
} from '@/lib/diagnostics';

// ── Colour palette — no theme/provider dependency ────────────────────────────
const BG      = '#0d1117';
const SURFACE = '#161b22';
const BORDER  = '#30363d';
const TAG_COL: Record<string, string> = {
  JS:      '#58a6ff',
  LAYOUT:  '#3fb950',
  SESSION: '#d29922',
  SC:      '#f78166',
  APP_SC:  '#bc8cff',
  USE_SC:  '#39d353',
  ERR:     '#f85149',
  GLOBAL:  '#ff7b72',
  BEACON:  '#79c0ff',
};
const DEFAULT_TAG = '#8b949e';

// ── Types ─────────────────────────────────────────────────────────────────────
interface DisplayEntry extends DiagEntry { key: string }

export default function DiagScreen() {
  const [current,  setCurrent]  = useState<DisplayEntry[]>([]);
  const [prev,     setPrev]     = useState<DisplayEntry[] | null>(null);
  const [showPrev, setShowPrev] = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [shared,   setShared]   = useState(false);
  const [beaconStatus, setBeaconStatus] = useState<string>('');

  // Read AsyncStorage directly — NO provider dependency.
  const refresh = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { entries?: DiagEntry[] };
        const entries = parsed.entries ?? [];
        setCurrent(entries.map((e, i) => ({ ...e, key: `c-${i}` })));
      } else {
        // AsyncStorage empty — fall back to in-memory ring
        const live = getDiagEntries();
        setCurrent(live.map((e, i) => ({ ...e, key: `m-${i}` })));
      }
    } catch (_) {
      const live = getDiagEntries();
      setCurrent(live.map((e, i) => ({ ...e, key: `f-${i}` })));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPrev = useCallback(async () => {
    const data = await loadPersistedDiag();
    // loadPersistedDiag returns the CURRENT session log from AsyncStorage.
    // If the session IDs differ, it's from a previous session.
    if (data && data.sessionId !== getDiagSessionId()) {
      setPrev(data.entries.map((e, i) => ({ ...e, key: `p-${i}` })));
    } else {
      setPrev([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([refresh(), loadPrev()]);
    })();
  }, [refresh, loadPrev]);

  const handleShare = useCallback(async () => {
    const text = buildLogText();
    try {
      // iOS Share sheet — lets user AirDrop, email, copy to clipboard, etc.
      await Share.share({ message: text, title: 'MedAcademy Diag Log' });
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch (_) {}
  }, []);

  const handleBeacon = useCallback(async () => {
    setBeaconStatus('Sending…');
    const endpoint = (process.env.EXPO_PUBLIC_DIAG_ENDPOINT ?? '').trim();
    if (!endpoint) {
      setBeaconStatus('EXPO_PUBLIC_DIAG_ENDPOINT not set');
      setTimeout(() => setBeaconStatus(''), 3000);
      return;
    }
    try {
      const text = buildLogText();
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      const location = (await r.text().catch(() => '')).trim().slice(0, 200);
      setBeaconStatus(`✓ ${r.status} → ${location || '(no URL in response)'}`);
    } catch (e) {
      setBeaconStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => setBeaconStatus(''), 8000);
  }, []);

  const displayEntries = showPrev ? (prev ?? []) : current;

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>🩺 DIAG</Text>
        <Text style={s.sid} numberOfLines={1}>sid:{getDiagSessionId().slice(-8)}</Text>
        <Text style={s.count}>{current.length} events</Text>
      </View>

      {/* Tab row */}
      <View style={s.tabRow}>
        <TouchableOpacity
          style={[s.tab, !showPrev && s.tabActive]}
          onPress={() => setShowPrev(false)}
          activeOpacity={0.7}
        >
          <Text style={[s.tabText, !showPrev && s.tabTextActive]}>
            Current ({current.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, showPrev && s.tabActive]}
          onPress={() => { setShowPrev(true); if (!prev) loadPrev(); }}
          activeOpacity={0.7}
        >
          <Text style={[s.tabText, showPrev && s.tabTextActive]}>
            Prev ({prev?.length ?? '…'})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.tab} onPress={refresh} activeOpacity={0.7}>
          <Text style={s.tabText}>↻ Reload</Text>
        </TouchableOpacity>
      </View>

      {/* Action buttons */}
      <View style={s.actions}>
        <TouchableOpacity style={s.btn} onPress={handleShare} activeOpacity={0.7}>
          <Text style={s.btnText}>{shared ? '✓ Shared' : '⬆ Share / Copy'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.btnBeacon]} onPress={handleBeacon} activeOpacity={0.7}>
          <Text style={s.btnText}>📡 POST Beacon</Text>
        </TouchableOpacity>
      </View>

      {/* Beacon status */}
      {beaconStatus ? (
        <Text style={s.beaconStatus} numberOfLines={2}>{beaconStatus}</Text>
      ) : null}

      {/* Log body */}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#58a6ff" />
      ) : displayEntries.length === 0 ? (
        <Text style={s.empty}>
          {showPrev
            ? 'No previous-session log found.\n(Previous session may have had the same session ID, or no log was persisted.)'
            : 'No events in AsyncStorage yet.\n\nThis means either:\n• The app just started and has not flushed yet (wait 1 s and tap ↻ Reload)\n• AsyncStorage is not available\n• The JS bundle never evaluated (check native crash logs)'}
        </Text>
      ) : (
        <ScrollView
          style={s.logScroll}
          contentContainerStyle={s.logContent}
          showsVerticalScrollIndicator
        >
          {displayEntries.map((e) => (
            <EntryRow key={e.key} entry={e} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function EntryRow({ entry }: { entry: DiagEntry }) {
  const tc = TAG_COL[entry.tag] ?? DEFAULT_TAG;
  return (
    <View style={s.row}>
      <Text style={s.rowT}>{entry.t}ms </Text>
      <Text style={[s.rowTag, { color: tc }]}>[{entry.tag}] </Text>
      <Text style={[s.rowMsg, entry.tag === 'ERR' || entry.tag === 'GLOBAL' ? s.rowErr : null]}
        numberOfLines={6}>
        {entry.msg}
        {entry.extra ? (
          <Text style={s.rowExtra}>{'\n  ↳ '}{entry.extra}</Text>
        ) : null}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
    paddingTop: Platform.OS === 'ios' ? 50 : 24,
  },
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    paddingHorizontal: 16,
    paddingBottom:  8,
    gap:            8,
    borderBottomWidth: 1,
    borderColor:    BORDER,
  },
  title: {
    color:      '#f0f6fc',
    fontSize:   17,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  sid: {
    color:      '#8b949e',
    fontSize:   10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex:       1,
  },
  count: {
    color:    '#8b949e',
    fontSize: 11,
  },
  tabRow: {
    flexDirection:     'row',
    paddingHorizontal: 12,
    paddingVertical:   6,
    gap:               6,
    borderBottomWidth: 1,
    borderColor:       BORDER,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      6,
    backgroundColor:   SURFACE,
  },
  tabActive: {
    backgroundColor: '#1f6feb',
  },
  tabText: {
    color:      '#8b949e',
    fontSize:   11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  tabTextActive: {
    color: '#ffffff',
  },
  actions: {
    flexDirection:     'row',
    paddingHorizontal: 12,
    paddingVertical:   8,
    gap:               8,
  },
  btn: {
    flex:              1,
    backgroundColor:   '#21262d',
    borderRadius:      8,
    paddingVertical:   8,
    alignItems:        'center',
    borderWidth:       1,
    borderColor:       BORDER,
  },
  btnBeacon: {
    borderColor: '#388bfd',
  },
  btnText: {
    color:      '#c9d1d9',
    fontSize:   12,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  beaconStatus: {
    color:             '#79c0ff',
    fontSize:          11,
    paddingHorizontal: 16,
    paddingBottom:     6,
    fontFamily:        Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  logScroll: {
    flex: 1,
  },
  logContent: {
    padding: 10,
    gap:     3,
  },
  row: {
    flexDirection:  'row',
    flexWrap:       'wrap',
    paddingVertical: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor:    BORDER,
  },
  rowT: {
    color:      '#484f58',
    fontSize:   9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minWidth:   54,
    paddingTop: 1,
  },
  rowTag: {
    fontSize:   9,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minWidth:   56,
    paddingTop: 1,
  },
  rowMsg: {
    flex:       1,
    color:      '#c9d1d9',
    fontSize:   9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minWidth:   0,
  },
  rowErr: {
    color: '#f85149',
  },
  rowExtra: {
    color:      '#484f58',
    fontSize:   8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  empty: {
    color:      '#8b949e',
    fontSize:   13,
    padding:    24,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
