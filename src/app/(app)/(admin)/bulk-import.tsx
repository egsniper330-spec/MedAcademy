/**
 * Admin Bulk Import — students / doctors / admins via CSV
 * Parses CSV, validates rows, then calls createManagedUser for each.
 * Generates a detailed import report.
 */
import { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  ActivityIndicator, TextInput,
} from 'react-native';
import { Upload, Download, CheckCircle, XCircle, AlertTriangle, FileText, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { createManagedUser, getUniversities, getFaculties, getAcademicLevels, type CreateUserPayload } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, neuFlatStyle, useLayout } from '@/lib/neu'

type ImportRole = 'student' | 'doctor' | 'admin';

interface CsvRow {
  index: number;
  full_name: string;
  email: string;
  phone: string;
  password: string;
  university?: string;
  faculty?: string;
  level?: string;
}

interface ImportResult {
  index: number;
  full_name: string;
  email: string;
  status: 'success' | 'failed' | 'skipped';
  message?: string;
}

const ROLE_TABS: Array<{ role: ImportRole; label: string; color: string }> = [
  { role: 'student', label: 'Students', color: '#6366F1' },
  { role: 'doctor',  label: 'Doctors',  color: '#0EA5E9' },
  { role: 'admin',   label: 'Admins',   color: '#F59E0B' },
];

const STUDENT_TEMPLATE = 'full_name,email,phone,password,university,faculty,level\nJohn Doe,john@example.com,+1234567890,Pass@123,Cairo University,Medicine,Year 1\n';
const DOCTOR_TEMPLATE  = 'full_name,email,phone,password\nDr. Jane Smith,jane@example.com,+1234567890,Pass@123\n';
const ADMIN_TEMPLATE   = 'full_name,email,phone,password\nAdmin User,admin@example.com,+1234567890,Pass@123\n';

function parseCSV(text: string): string[][] {
  return text.trim().split('\n').map(line =>
    line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''))
  );
}

export default function BulkImportScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c    = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const flat = neuFlatStyle(isDark);
  const { showToast } = useToast();

  const [role,           setRole]           = useState<ImportRole>('student');
  const [csvText,        setCsvText]        = useState('');
  const [rows,           setRows]           = useState<CsvRow[]>([]);
  const [results,        setResults]        = useState<ImportResult[]>([]);
  const [importing,      setImporting]      = useState(false);
  const [showPreview,    setShowPreview]    = useState(false);
  const [showResults,    setShowResults]    = useState(false);
  const [progress,       setProgress]       = useState(0);

  // Parse CSV text into preview rows
  const handleParse = () => {
    if (!csvText.trim()) { showToast({ type: 'error', message: 'Paste CSV data first.' }); return; }
    try {
      const lines = parseCSV(csvText);
      if (lines.length < 2) { showToast({ type: 'error', message: 'CSV must have a header + at least one row.' }); return; }
      const [header, ...data] = lines;
      const parsed: CsvRow[] = data.map((row, i) => {
        const get = (col: string) => row[header.indexOf(col)] ?? '';
        return {
          index:      i + 1,
          full_name:  get('full_name'),
          email:      get('email'),
          phone:      get('phone'),
          password:   get('password'),
          university: get('university'),
          faculty:    get('faculty'),
          level:      get('level'),
        };
      }).filter(r => r.email); // skip blank rows
      setRows(parsed);
      setShowPreview(true);
      setResults([]);
      showToast({ type: 'success', message: `Parsed ${parsed.length} row(s).` });
    } catch (e) {
      showToast({ type: 'error', message: 'Failed to parse CSV. Check format.' });
    }
  };

  const handlePickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel'] });
      if (res.canceled || !res.assets?.[0]) return;
      const uri = res.assets[0].uri;
      const text = await FileSystem.readAsStringAsync(uri).catch(async () => {
        // Web fallback
        const r = await fetch(uri);
        return r.text();
      });
      setCsvText(text);
      showToast({ type: 'success', message: 'File loaded. Tap "Parse & Preview" to review.' });
    } catch {
      showToast({ type: 'error', message: 'Could not read file.' });
    }
  };

  const handleImport = async () => {
    if (!rows.length) { showToast({ type: 'error', message: 'No rows to import.' }); return; }
    setImporting(true);
    setProgress(0);
    setResults([]);
    const out: ImportResult[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row.full_name || !row.email || !row.password) throw new Error('Missing required fields (full_name, email, password)');
        const actionMap: Record<string, CreateUserPayload['action']> = {
          student: 'create_user',
          doctor:  'create_doctor',
          admin:   'create_admin',
        };
        await createManagedUser({
          action:   actionMap[role] ?? 'create_user',
          full_name: row.full_name,
          email:     row.email,
          phone:     row.phone || undefined,
          password:  row.password,
          university_id:    undefined,
          faculty_id:       undefined,
          academic_level_id: undefined,
        });
        out.push({ index: row.index, full_name: row.full_name, email: row.email, status: 'success' });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const isDup = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists') || msg.toLowerCase().includes('unique');
        out.push({ index: row.index, full_name: row.full_name, email: row.email, status: isDup ? 'skipped' : 'failed', message: msg });
      }
      setProgress(Math.round(((i + 1) / rows.length) * 100));
    }

    setResults(out);
    setShowResults(true);
    setImporting(false);

    const succeeded = out.filter(r => r.status === 'success').length;
    const failed    = out.filter(r => r.status === 'failed').length;
    const skipped   = out.filter(r => r.status === 'skipped').length;
    showToast({
      type: failed > 0 ? 'error' : 'success',
      message: `Import complete: ${succeeded} created, ${skipped} skipped, ${failed} failed.`,
    });
  };

  const templateForRole = role === 'student' ? STUDENT_TEMPLATE : role === 'doctor' ? DOCTOR_TEMPLATE : ADMIN_TEMPLATE;

  const succeeded = results.filter(r => r.status === 'success').length;
  const failed    = results.filter(r => r.status === 'failed').length;
  const skipped   = results.filter(r => r.status === 'skipped').length;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}>
      <View style={{ padding: layout.screenPx }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4, marginTop: 8 }}>
          <Upload size={22} color={c.primary} />
          <Text style={{ fontSize: 24, fontWeight: '800', color: c.text }}>Bulk Import</Text>
        </View>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>
          Import users from CSV. Download the template, fill it in, then upload.
        </Text>

        {/* Role tabs */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 18 }}>
          {ROLE_TABS.map(t => (
            <Pressable key={t.role} onPress={() => { setRole(t.role); setRows([]); setResults([]); setShowPreview(false); setShowResults(false); }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 12,
                backgroundColor: role === t.role ? `${t.color}20` : `${c.text}08`,
                borderWidth: 1.5, borderColor: role === t.role ? t.color : 'transparent' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: role === t.role ? t.color : `${c.text}70` }}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Template download hint */}
        <NeuCard style={{ padding: 14, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <FileText size={20} color={c.primary} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>CSV Template</Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }} numberOfLines={2}>
              {templateForRole.split('\n')[0]}
            </Text>
          </View>
          <Pressable
            onPress={() => { setCsvText(templateForRole); showToast({ type: 'success', message: 'Template loaded into editor.' }); }}
            style={{ backgroundColor: `${c.primary}15`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>Load Template</Text>
          </Pressable>
        </NeuCard>

        {/* CSV input */}
        <NeuCard style={{ padding: 0, marginBottom: 12, overflow: 'hidden' }}>
          <TextInput
            value={csvText}
            onChangeText={setCsvText}
            multiline
            numberOfLines={8}
            placeholder={`Paste CSV here…\n${templateForRole}`}
            placeholderTextColor={`${c.text}40`}
            style={{ padding: 14, fontSize: 12, fontFamily: 'monospace', color: c.text, minHeight: 140, textAlignVertical: 'top', minWidth: 0 }}
          />
        </NeuCard>

        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
          <NeuButton label="Pick File" onPress={handlePickFile} variant="secondary" style={{ flex: 1 }} icon={<Upload size={14} color={c.primary} />} />
          <NeuButton label="Parse & Preview" onPress={handleParse} style={{ flex: 1 }} />
        </View>

        {/* Preview */}
        {rows.length > 0 && (
          <>
            <Pressable onPress={() => setShowPreview(p => !p)}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Preview ({rows.length} rows)</Text>
              {showPreview ? <ChevronUp size={16} color={`${c.text}50`} /> : <ChevronDown size={16} color={`${c.text}50`} />}
            </Pressable>
            {showPreview && rows.slice(0, 10).map(row => (
              <NeuCard key={row.index} style={{ marginBottom: 6, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={[flat, { width: 26, height: 26, borderRadius: 7, alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ fontSize: 10, fontWeight: '800', color: c.primary }}>{row.index}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{row.full_name}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{row.email}</Text>
                </View>
              </NeuCard>
            ))}
            {rows.length > 10 && (
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, marginBottom: 8, textAlign: 'center' }}>
                …and {rows.length - 10} more rows
              </Text>
            )}

            {/* Progress bar */}
            {importing && (
              <NeuCard style={{ padding: 14, marginBottom: 12 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 8 }}>Importing… {progress}%</Text>
                <View style={{ height: 6, backgroundColor: `${c.text}15`, borderRadius: 3 }}>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: c.primary, width: `${progress}%` }} />
                </View>
              </NeuCard>
            )}

            <NeuButton
              label={importing ? `Importing ${progress}%…` : `Import ${rows.length} ${role}${rows.length > 1 ? 's' : ''}`}
              onPress={handleImport}
              loading={importing}
              fullWidth
              style={{ marginBottom: 16 }}
            />
          </>
        )}

        {/* Results report */}
        {results.length > 0 && (
          <>
            <Pressable onPress={() => setShowResults(p => !p)}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Import Report</Text>
              {showResults ? <ChevronUp size={16} color={`${c.text}50`} /> : <ChevronDown size={16} color={`${c.text}50`} />}
            </Pressable>

            {/* Summary tiles */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              {[
                { label: 'Created',  value: succeeded, color: '#16A34A', icon: CheckCircle },
                { label: 'Skipped',  value: skipped,   color: '#D97706', icon: AlertTriangle },
                { label: 'Failed',   value: failed,    color: '#EF4444', icon: XCircle },
              ].map(s => (
                <NeuCard key={s.label} style={{ flex: 1, alignItems: 'center', padding: 12 }}>
                  <s.icon size={18} color={s.color} />
                  <Text style={{ fontSize: 20, fontWeight: '900', color: s.color, marginTop: 4 }}>{s.value}</Text>
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, marginTop: 2 }}>{s.label}</Text>
                </NeuCard>
              ))}
            </View>

            {showResults && results.map(r => (
              <NeuCard key={r.index} style={{ marginBottom: 6, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {r.status === 'success'
                  ? <CheckCircle size={16} color="#16A34A" />
                  : r.status === 'skipped'
                    ? <AlertTriangle size={16} color="#D97706" />
                    : <XCircle size={16} color="#EF4444" />
                }
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{r.full_name}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>{r.email}</Text>
                  {r.message && r.status !== 'success' && (
                    <Text style={{ fontSize: 11, color: '#EF4444', marginTop: 2 }} numberOfLines={2}>{r.message}</Text>
                  )}
                </View>
                <View style={{ backgroundColor:
                  r.status === 'success' ? '#16A34A18' :
                  r.status === 'skipped' ? '#D9780618' : '#EF444418',
                  borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700',
                    color: r.status === 'success' ? '#16A34A' : r.status === 'skipped' ? '#D97706' : '#EF4444',
                    textTransform: 'capitalize' }}>{r.status}</Text>
                </View>
              </NeuCard>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}
