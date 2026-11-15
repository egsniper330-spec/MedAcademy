import { describe, expect, it } from 'vitest';
import { courseCsvTemplate, parseCsv } from '../src/lib/csv';

describe('course CSV import parsing', () => {
  it('reads a UTF-8 BOM file with Arabic text', () => {
    const parsed = parseCsv('\ufefftitle,short_description,full_description,language,price_egp\r\nدورة علم الأدوية,ملخص,وصف كامل بالعربية,Arabic,0\r\n');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].title).toBe('دورة علم الأدوية');
    expect(parsed.rows[0].full_description).toBe('وصف كامل بالعربية');
    expect(parsed.rows[0].language).toBe('Arabic');
  });

  it('keeps commas inside quoted descriptions', () => {
    const parsed = parseCsv(courseCsvTemplate());
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].full_description).toBe('Full description, with commas');
    expect(parsed.rows[0].short_description).toBe('One-line summary');
  });

  it('handles escaped quotes and CRLF line endings', () => {
    const parsed = parseCsv('title,short_description\r\n"A ""quoted"" title",Summary\r\n');
    expect(parsed.rows[0].title).toBe('A "quoted" title');
  });

  it('rejects a file without a title column', () => {
    const parsed = parseCsv('name,price\nCourse,10\n');
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]).toContain('title');
  });

  it('reports inconsistent column counts per row', () => {
    const parsed = parseCsv('title,short_description\nCourse A,Summary\nCourse B\n');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors[0]).toContain('Row 3');
  });

  it('rejects an unterminated quoted cell instead of guessing', () => {
    const parsed = parseCsv('title,short_description\n"Course,Summary\n');
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]).toContain('unterminated');
  });
});
