import ExcelJS from 'exceljs';

/**
 * Sanitize a string for use as a file name.
 * Removes/replaces characters that are illegal on Windows, macOS, or Linux.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')   // illegal chars → dash
    .replace(/\s+/g, ' ')             // collapse whitespace
    .replace(/^[\s.-]+|[\s.-]+$/g, '') // trim leading/trailing dots, spaces, dashes
    .slice(0, 100)                     // max length
    || 'export';
}

/**
 * Build an export filename: "<BatchName> - YYYY-MM-DD"
 * so files never collide and are always human-readable.
 */
export function buildExportFilename(batchLabel: string | null | undefined): string {
  const today = new Date();
  const date  = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const label = sanitizeFilename(batchLabel ?? 'Batch');
  return `${label} - ${date}`;
}

// ── Column presets ─────────────────────────────────────────────────────────
export const CODE_COLUMNS = [
  'code', 'status', 'course_title', 'created_by_name',
  'used_by_name', 'used_at', 'expires_at', 'batch_label', 'notes', 'created_at',
];

export const CREDIT_COLUMNS = [
  'created_at', 'transaction_type', 'amount', 'balance_before', 'balance_after',
  'doctor_name', 'doctor_email', 'performed_by_name', 'reason', 'notes',
];

/** Human-readable column definitions for batch code exports */
export const BATCH_CODE_COLUMNS: { key: string; header: string }[] = [
  { key: 'code',         header: 'Activation Code'   },
  { key: 'course_title', header: 'Course'             },
  { key: 'batch_label',  header: 'Batch Name'         },
  { key: 'status',       header: 'Status'             },
  { key: 'uses_count',   header: 'Activations Used'   },
  { key: 'max_uses',     header: 'Activation Limit'   },
  { key: 'expires_at',   header: 'Expiration Date'    },
  { key: 'created_at',   header: 'Created Date'       },
];

// ── CSV export ─────────────────────────────────────────────────────────────
/**
 * exportCSV(rows, columns, filename)
 *   - columns: ordered list of column keys (empty → use all keys)
 *   - filename: base name WITHOUT extension (extension is added automatically)
 */
export function exportCSV(
  rows: Record<string, unknown>[],
  columns: string[],
  filename: string,
): void {
  if (!rows.length) return;
  const headers = columns.length ? columns : Object.keys(rows[0]);
  const escape  = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
  ].join('\n');

  if (typeof document !== 'undefined') {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${filename}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
}

// ── XLSX export ────────────────────────────────────────────────────────────
/**
 * exportXLSX(rows, columns, filename)
 *   - columns: { key, header }[] — keys to extract, headers shown in the file
 *   - filename: base name WITHOUT extension
 * Uses ExcelJS; on Web triggers a browser download.
 * On native, logs (wire expo-sharing + expo-file-system if needed).
 */
export async function exportXLSX(
  rows: Record<string, unknown>[],
  columns: { key: string; header: string }[],
  filename: string,
): Promise<void> {
  if (!rows.length) return;

  const wb  = new ExcelJS.Workbook();
  wb.creator = 'Activation Codes System';
  wb.created = new Date();

  const ws  = wb.addWorksheet('Codes');

  // Header row
  ws.columns = columns.map(col => ({
    header: col.header,
    key:    col.key,
    width:  Math.max(col.header.length + 4, 18),
  }));

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  // Data rows
  for (const row of rows) {
    const mapped: Record<string, unknown> = {};
    for (const col of columns) {
      let v = row[col.key];
      // Format ISO date strings as readable dates
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        v = new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      }
      if (v == null) v = '—';
      mapped[col.key] = v;
    }
    ws.addRow(mapped);
  }

  // Zebra striping
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    row.fill = rowNum % 2 === 0
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    row.alignment = { vertical: 'middle' };
  });

  // Auto-fit border on all cells
  ws.eachRow(row => {
    row.eachCell(cell => {
      cell.border = {
        top:    { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left:   { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right:  { style: 'thin', color: { argb: 'FFE5E7EB' } },
      };
    });
  });

  if (typeof document !== 'undefined') {
    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = `${filename}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }
}
