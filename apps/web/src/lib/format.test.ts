import { describe, expect, it } from 'vitest';
import { cleanSearch, formatPeso, formatRelative } from './format';

describe('formatPeso', () => {
  it('formats pesos with two decimals', () => {
    expect(formatPeso(20)).toBe('₱20.00');
    expect(formatPeso('1250.5')).toBe('₱1,250.50');
    expect(formatPeso(null)).toBe('₱0.00');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  it.each([
    ['2026-11-17T11:59:50Z', 'just now'],
    ['2026-11-17T11:55:00Z', '5 min ago'],
    ['2026-11-17T09:00:00Z', '3 h ago'],
    ['2026-11-14T12:00:00Z', '3 days ago'],
  ])('%s -> %s', (value, expected) => {
    expect(formatRelative(value, now)).toBe(expected);
  });
  it('handles never', () => expect(formatRelative(null, now)).toBe('never'));
});

describe('cleanSearch', () => {
  it('keeps normal names and numbers', () => {
    expect(cleanSearch("  Peña  O'Neil ")).toBe("Peña O'Neil");
    expect(cleanSearch('2022100001')).toBe('2022100001');
    expect(cleanSearch('04-A1-B2')).toBe('04-A1-B2');
  });
  it('strips characters that could alter a Supabase filter', () => {
    expect(cleanSearch('juan,status.eq.BLOCKED)')).toBe('juanstatus.eq.BLOCKED');
    expect(cleanSearch('%_*()')).toBe('');
  });
  it('rejects non-strings and limits length', () => {
    expect(cleanSearch(undefined)).toBe('');
    expect(cleanSearch('a'.repeat(80))).toHaveLength(50);
  });
});
