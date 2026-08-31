/**
 * DiagScreen — always-on floating diagnostic overlay.
 *
 * Renders as a semi-transparent overlay at the bottom of the screen.
 * It is wired into root _layout.tsx ABOVE all other content so it
 * remains visible even if the normal UI is black (i.e. when the entire
 * navigator tree is blank due to the suspected preventScreenCapture race).
 *
 * Key design decisions:
 *  • Uses zero backend / auth / navigation dependencies — pure React Native
 *  • No ScreenCapture calls — must not interfere with what we are diagnosing
 *  • Reads from DiagnosticStore's in-memory ring on a 250 ms poll
 *  • On first mount also loads the PREVIOUS session's persisted log
 *  • Shows: session ID, elapsed ms for each event, tag, message
 *  • Toggle: tap the "[DIAG]" pill to expand/collapse
 *  • Copy button: writes full log to AsyncStorage-persisted text (accessible
 *    via Files app if expo-file-system write is available, or via console)
 *  • Rendered at zIndex 99999 with pointerEvents="box-none" on the container
 *    so touch still passes through to the app beneath when collapsed
 *
 * Remove this file and its import from _layout.tsx to clean up after diagnosis.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  AppState,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDiagEntries,
  loadPersistedDiag,
  getDiagSessionId,
  type DiagEntry,
} from '@/lib/diagnostics';

// ── Colour constants (no theme dependency — must work before providers) ───────
const BG      = 'rgba(0,0,0,0.82)';
const BORDER  = 'rgba(255,255,255,0.18)';
const TAG_COL: Record<string, string> = {
  JS:       '#4fc3f7',   // sky
  LAYOUT:   '#81c784',   // green
  SESSION:  '#ffb74d',   // amber
  SC:       '#f06292',   // pink (screen-capture events)
  ERR:      '#ef5350',   // red
  APP_SC:   '#ba68c8',   // purple
  USE_SC:   '#4db6ac',   // teal
};
const DEFAULT_TAG_COLOR = '#ccc';
const ENTRY_LIMIT_DISPLAY = 60;

// ── Exported copy-log storage key (retrieve with AsyncStorage in e.g. RN Debugger)
export const DIAG_EXPORT_KEY = '__medacademy_diag_export__';

export function DiagScreen() {
  const [expanded, setExpanded] = useState(true);
  const [entries, setEntries]   = useState<DiagEntry[]>([]);
  const [prevEntries, setPrevEntries] = useState<DiagEntry[]>([]);
  const [showPrev, setShowPrev] = useState(false);
  const [copied, setCopied]     = useState(false);
  const scrollRef               = useRef<ScrollView>(null);
  const pollRef                 = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load persisted log from previous session on mount
  useEffect(() => {
    loadPersistedDiag().then((result) => {
      if (result && result.entries.length > 0) setPrevEntries(result.entries);
    }).catch(() => {});
  }, []);

  // Poll in-memory ring every 250 ms
  useEffect(() => {
    const tick = () => setEntries(getDiagEntries());
    tick();
    pollRef.current = setInterval(tick, 250);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (expanded && entries.length > 0) {
      // Small delay so layout finishes before scroll
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 60);
    }
  }, [entries.length, expanded]);

  const handleCopy = useCallback(async () => {
    const all = [
      `=== DiagScreen export — session ${getDiagSessionId()} ===`,
      ...entries.map(e => `[+${e.t}ms] [${e.ts}] [${e.tag}] ${e.msg}${e.extra ? ' | ' + e.extra : ''}`),
    ].join('\n');
    try {
      await AsyncStorage.setItem(DIAG_EXPORT_KEY, all);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
    // Also log to console so it appears in Xcode device console
    // eslint-disable-next-line no-console
    console.log('[DIAG EXPORT]\n' + all);
  }, [entries]);

  const display = entries.slice(-ENTRY_LIMIT_DISPLAY);

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/* Pill toggle header — always visible */}
      <View style={styles.header} pointerEvents="auto">
        <TouchableOpacity
          onPress={() => setExpanded(e => !e)}
          style={styles.pillBtn}
          activeOpacity={0.7}
        >
          <Text style={styles.pillText}>
            {expanded ? '▼ DIAG' : '▶ DIAG'} [{entries.length}]
          </Text>
        </TouchableOpacity>

        {expanded && (
          <>
            <TouchableOpacity
              onPress={() => setShowPrev(p => !p)}
              style={[styles.pillBtn, { backgroundColor: 'rgba(255,255,100,0.12)' }]}
              activeOpacity={0.7}
            >
              <Text style={[styles.pillText, { color: '#ffe082' }]}>
                {showPrev ? 'CURR' : 'PREV'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleCopy}
              style={[styles.pillBtn, { backgroundColor: copied ? 'rgba(100,255,100,0.18)' : 'rgba(255,255,255,0.08)' }]}
              activeOpacity={0.7}
            >
              <Text style={[styles.pillText, { color: copied ? '#a5d6a7' : '#bbb' }]}>
                {copied ? '✓ SAVED' : 'EXPORT'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        <Text style={styles.sessionId} numberOfLines={1}>
          sid:{getDiagSessionId().slice(-6)}
        </Text>
      </View>

      {/* Log body */}
      {expanded && (
        <ScrollView
          ref={scrollRef}
          style={styles.logBody}
          contentContainerStyle={styles.logContent}
          pointerEvents="auto"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {showPrev && prevEntries.length === 0 && (
            <Text style={styles.noData}>No persisted log from previous session.</Text>
          )}
          {(showPrev ? prevEntries : display).map((e, i) => (
            <EntryRow key={`${e.t}-${i}`} entry={e} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ── Entry row ─────────────────────────────────────────────────────────────────
function EntryRow({ entry }: { entry: DiagEntry }) {
  const tagColor = TAG_COL[entry.tag] ?? DEFAULT_TAG_COLOR;
  const isErr    = entry.tag === 'ERR' || entry.msg.toLowerCase().startsWith('error');
  return (
    <View style={styles.row}>
      <Text style={styles.time}>{entry.t}ms </Text>
      <Text style={[styles.tag, { color: tagColor }]}>[{entry.tag}] </Text>
      <Text
        style={[styles.msgText, isErr && styles.msgError]}
        numberOfLines={3}
      >
        {entry.msg}
        {entry.extra ? <Text style={styles.extra}>{'\n  ↳ '}{entry.extra}</Text> : null}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    position:  'absolute',
    bottom:    0,
    left:      0,
    right:     0,
    zIndex:    99999,
    elevation: 99999,
    maxHeight: 320,
  },
  header: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: BG,
    borderTopWidth:  1,
    borderColor:     BORDER,
    paddingHorizontal: 8,
    paddingVertical:   4,
    gap:             6,
  },
  pillBtn: {
    backgroundColor:  'rgba(255,255,255,0.1)',
    borderRadius:     6,
    paddingHorizontal: 8,
    paddingVertical:   3,
  },
  pillText: {
    color:      '#4fc3f7',
    fontSize:   11,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  sessionId: {
    color:      'rgba(255,255,255,0.35)',
    fontSize:   10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginLeft: 'auto',
  },
  logBody: {
    backgroundColor: BG,
    borderTopWidth:  1,
    borderColor:     BORDER,
    maxHeight:       265,
  },
  logContent: {
    padding: 6,
    gap:     2,
  },
  row: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    paddingVertical: 1,
  },
  time: {
    color:      'rgba(255,255,255,0.35)',
    fontSize:   9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minWidth:   52,
  },
  tag: {
    fontSize:   9,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minWidth:   52,
  },
  msgText: {
    flex:       1,
    color:      '#eee',
    fontSize:   9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  msgError: {
    color: '#ef9a9a',
  },
  extra: {
    color:      'rgba(255,255,255,0.5)',
    fontSize:   8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  noData: {
    color:    'rgba(255,255,255,0.4)',
    fontSize: 10,
    padding:  8,
  },
});
