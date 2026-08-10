/**
 * Bulk Import Students — Doctor flow
 * Parses a CSV/plain-text upload with columns:
 *   name, phone, email, university, faculty, academic_level, course, activation_method
 * Creates each student row-by-row, deducts credits where needed.
 */
import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  TextInput, useColorScheme, Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Upload, Download, AlertCircle, CheckCircle, XCircle } from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import { fetch } from 'expo/fetch';
import { neuColors, useLayout, neuFlatStyle, safeBottom } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { useProfileStore } from '@/lib/store';
import { createStudentByDoctor, getCourses } from '@/lib/api';
import { enrollStudentViaCredits } from '@/lib/creditService';
import { friendlyError } from '@/lib/validation';

// ── CSV parsing helpers ────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur.trim());
  return result;
}

interface ImportRow {
  row: number;
  name: string;
  email: string;
  phone: string;
  university: string;
  faculty: string;
  academic_level: string;
  course: string;
  activation_method: string;
}

interface ImportResult extends ImportRow {
  status: 'success' | 'failed';
  error?: string;
  user_id?: string;
}

// ── Screen ─────────────────────────────────────────────────────────────────
export default function BulkImportStudentsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const flat = neuFlatStyle(isDark);
  const router = useRouter();
  const { profile } = useProfileStore();
  const { showToast } = useToast();

  const [phase, setPhase] = useState<'upload' | 'preview' | 'processing' | 'done'>('upload');
  const [rows,    setRows]    = useState<ImportRow[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [error,    setError]   = useState('');
  const [tempPassword, setTempPassword] = useState('Temp@1234');

  const summary = {
    total:    results.length,
    success:  results.filter(r => r.status === 'success').length,
    failed:   results.filter(r => r.status === 'failed').length,
    credits:  results.filter(r => r.status === 'success' && r.activation_method?.toLowerCase() === 'credits').length,
  };

  // ── Pick + parse CSV ──────────────────────────────────────────────────────
  const handlePickFile = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/plain', 'text/comma-separated-values'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      const response = await fetch(asset.uri);
      const text = await response.text();
      parseCSV(text);
    } catch (e) {
      setError(friendlyError(e, 'Failed to read file. Please try again.'));
    }
  };

  const parseCSV = (text: string) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { setError('CSV must have a header row and at least one data row.'); return; }
    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s/g, '_'));
    const idx = (key: string) => {
      const i = headers.indexOf(key);
      return i >= 0 ? i : -1;
    };
    const parsed: ImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      parsed.push({
        row: i,
        name:              cols[idx('name')] ?? cols[0] ?? '',
        email:             cols[idx('email')] ?? '',
        phone:             cols[idx('phone')] ?? '',
        university:        cols[idx('university')] ?? '',
        faculty:           cols[idx('faculty')] ?? '',
        academic_level:    cols[idx('academic_level')] ?? '',
        course:            cols[idx('course')] ?? '',
        activation_method: cols[idx('activation_method')] ?? 'none',
      });
    }
    if (!parsed.length) { setError('No data rows found in CSV.'); return; }
    setRows(parsed);
    setPhase('preview');
  };

  // ── Run import ─────────────────────────────────────────────────────────────
  const handleImport = async () => {
    if (!profile) return;
    setPhase('processing');
    setProgress(0);
    const importResults: ImportResult[] = [];

    // Pre-fetch courses map for name→id lookup
    let coursesMap: Record<string, string> = {};
    try {
      const cs = await getCourses({ doctorId: profile.id, status: 'published' });
      cs.forEach((co: any) => { coursesMap[co.title?.toLowerCase()] = co.id; });
    } catch { /* ignore */ }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setProgress(Math.round(((i + 1) / rows.length) * 100));
      try {
        if (!row.name.trim()) throw new Error('Name is required.');
        if (!row.email.trim() && !row.phone.trim()) throw new Error('Email or Phone is required.');

        // Create student
        const result = await createStudentByDoctor({
          full_name: row.name.trim(),
          email: row.email.trim() || undefined,
          phone: row.phone.trim() || undefined,
          password: tempPassword,
        });
        if (!result?.user_id) throw new Error('Account creation failed.');

        // Enroll via credits if requested
        const method = row.activation_method?.toLowerCase();
        if (method === 'credits' && row.course) {
          const courseId = coursesMap[row.course.toLowerCase()];
          if (!courseId) throw new Error(`Course not found: "${row.course}"`);
          await enrollStudentViaCredits(result.user_id, courseId);
        }

        importResults.push({ ...row, status: 'success', user_id: result.user_id });
      } catch (e) {
        importResults.push({ ...row, status: 'failed', error: friendlyError(e, 'Unknown error') });
      }
    }

    setResults(importResults);
    setPhase('done');
    showToast({ type: 'success', message: `Import complete: ${importResults.filter(r => r.status === 'success').length} created.` });
  };

  // ── Download report ────────────────────────────────────────────────────────
  const handleDownloadReport = async () => {
    const lines = [
      'Row,Name,Email,Phone,Status,Error',
      ...results.map(r =>
        `${r.row},"${r.name}","${r.email}","${r.phone}",${r.status},"${r.error ?? ''}"`
      ),
    ];
    const csv = lines.join('\n');
    try {
      if (process.env.EXPO_OS === 'web') {
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'bulk-import-report.csv'; a.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ message: csv, title: 'Bulk Import Report' });
      }
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to share report.') });
    }
  };

  // ── Template CSV ──────────────────────────────────────────────────────────
  const TEMPLATE = `name,email,phone,university,faculty,academic_level,course,activation_method
John Doe,john@example.com,+1234567890,Cairo University,Medicine,Level 1,Anatomy 101,credits
Jane Smith,jane@example.com,,Cairo University,Medicine,Level 2,,none`;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>
        <PageHeader title="Bulk Import Students" subtitle="Upload CSV to create multiple students" />

        {/* ── UPLOAD ─────────────────────────────────────────────────── */}
        {phase === 'upload' && (
          <>
            <NeuCard>
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 8 }}>CSV File Format</Text>
              <Text style={{ fontSize: 13, color: `${c.text}88`, marginBottom: 12 }}>
                Upload a CSV with the following columns:{'\n'}
                <Text style={{ fontWeight: '600' }}>name, email, phone, university, faculty, academic_level, course, activation_method</Text>
              </Text>
              <Text style={{ fontSize: 12, color: `${c.text}66`, fontFamily: 'monospace' }}>
                {'activation_method: "credits" | "none"'}
              </Text>
            </NeuCard>

            <NeuCard>
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 10 }}>Default Temporary Password</Text>
              <View style={[flat, { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 13, minWidth: 0 }]}>
                <TextInput
                  style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }}
                  value={tempPassword} onChangeText={setTempPassword}
                  placeholder="e.g. Temp@1234" placeholderTextColor={`${c.text}66`}
                  autoCapitalize="none" autoCorrect={false}
                />
              </View>
              <Text style={{ fontSize: 12, color: `${c.text}66`, marginTop: 6 }}>
                All imported students will use this temporary password and must change it on first login.
              </Text>
            </NeuCard>

            {error ? (
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <AlertCircle size={16} color="#EF4444" />
                <Text style={{ color: '#EF4444', fontSize: 14, flex: 1 }}>{error}</Text>
              </View>
            ) : null}

            <NeuButton label="Choose CSV File" onPress={handlePickFile} icon={<Upload size={16} color="#fff" />} />
          </>
        )}

        {/* ── PREVIEW ────────────────────────────────────────────────── */}
        {phase === 'preview' && (
          <>
            <NeuCard>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>Preview ({rows.length} rows)</Text>
                <Pressable onPress={() => setPhase('upload')}>
                  <Text style={{ fontSize: 13, color: c.primary }}>Change File</Text>
                </Pressable>
              </View>
              {rows.slice(0, 5).map(row => (
                <View key={row.row} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}12` }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{row.name}</Text>
                  <Text style={{ fontSize: 12, color: `${c.text}77` }}>
                    {[row.email, row.phone].filter(Boolean).join(' · ')}
                    {row.course ? ` → ${row.course} (${row.activation_method})` : ''}
                  </Text>
                </View>
              ))}
              {rows.length > 5 && (
                <Text style={{ fontSize: 12, color: `${c.text}66`, marginTop: 8 }}>
                  …and {rows.length - 5} more rows
                </Text>
              )}
            </NeuCard>

            <NeuButton label={`Import ${rows.length} Students`} onPress={handleImport} icon={<Upload size={16} color="#fff" />} />
          </>
        )}

        {/* ── PROCESSING ─────────────────────────────────────────────── */}
        {phase === 'processing' && (
          <NeuCard style={{ alignItems: 'center', gap: 16, paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={c.primary} />
            <Text style={{ fontSize: 18, fontWeight: '700', color: c.text }}>Importing…</Text>
            <Text style={{ fontSize: 28, fontWeight: '800', color: c.primary }}>{progress}%</Text>
            <Text style={{ fontSize: 13, color: `${c.text}77` }}>Please wait — do not close this screen.</Text>
          </NeuCard>
        )}

        {/* ── DONE ───────────────────────────────────────────────────── */}
        {phase === 'done' && (
          <>
            {/* Summary */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {[
                { label: 'Total',   value: summary.total,   color: c.primary },
                { label: 'Created', value: summary.success, color: '#22C55E' },
                { label: 'Failed',  value: summary.failed,  color: '#EF4444' },
                { label: 'Credits', value: summary.credits, color: '#F59E0B' },
              ].map(s => (
                <View key={s.label} style={[flat, { flex: 1, borderRadius: 16, padding: 12, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: s.color }}>{s.value}</Text>
                  <Text style={{ fontSize: 11, color: `${c.text}77`, marginTop: 2 }}>{s.label}</Text>
                </View>
              ))}
            </View>

            {/* Results list */}
            <NeuCard>
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 12 }}>Details</Text>
              {results.map(r => (
                <View key={r.row} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: `${c.text}12` }}>
                  {r.status === 'success'
                    ? <CheckCircle size={18} color="#22C55E" />
                    : <XCircle size={18} color="#EF4444" />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{r.name}</Text>
                    {r.error
                      ? <Text style={{ fontSize: 12, color: '#EF4444' }}>{r.error}</Text>
                      : <Text style={{ fontSize: 12, color: `${c.text}66` }}>{r.email || r.phone}</Text>}
                  </View>
                </View>
              ))}
            </NeuCard>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <NeuButton label="Download Report" onPress={handleDownloadReport} variant="secondary"
                style={{ flex: 1 }} icon={<Download size={16} color={c.text} />} />
              <NeuButton label="Done" onPress={() => router.back()} style={{ flex: 1 }} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
