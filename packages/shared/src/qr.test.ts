import { describe, expect, it } from 'vitest';
import { parseStudentQr } from './qr';

// Fake identities only — never commit real student data.
describe('parseStudentQr', () => {
  it('parses the official TAB-separated school ID format', () => {
    expect(parseStudentQr('JUAN DELA CRUZ\t2022100001\tBSCpE')).toEqual({
      ok: true,
      data: { fullName: 'JUAN DELA CRUZ', studentNumber: '2022100001', courseProgram: 'BSCpE' },
    });
  });

  it('handles a middle initial with a period', () => {
    const result = parseStudentQr('MARIA C. SANTOS\t2023100002\tBSCE');
    expect(result.ok && result.data.fullName).toBe('MARIA C. SANTOS');
  });

  it('accepts names with Ñ, hyphens and apostrophes', () => {
    const result = parseStudentQr("JOSÉ PEÑA-O'NEIL\t2024100003\tBSIT");
    expect(result.ok && result.data.fullName).toBe("JOSÉ PEÑA-O'NEIL");
  });

  it('falls back to spaces when a scanner converted the TABs', () => {
    const result = parseStudentQr('JUAN DELA CRUZ 2022100001 BSCpE');
    expect(result).toEqual({
      ok: true,
      data: { fullName: 'JUAN DELA CRUZ', studentNumber: '2022100001', courseProgram: 'BSCpE' },
    });
  });

  it('tolerates a trailing newline from the serial line', () => {
    expect(parseStudentQr('JUAN DELA CRUZ\t2022100001\tBSCpE\r\n').ok).toBe(true);
  });

  it('normalises extra spaces and lowercase names', () => {
    const result = parseStudentQr('  juan   dela  cruz \t 2022100001 \t BSCpE ');
    expect(result.ok && result.data.fullName).toBe('JUAN DELA CRUZ');
  });

  it.each([
    ['empty', ''],
    ['only a number', '2022100001'],
    ['missing course', 'JUAN DELA CRUZ\t2022100001'],
    ['9-digit student number', 'JUAN DELA CRUZ\t202210000\tBSCpE'],
    ['letters in student number', 'JUAN DELA CRUZ\t20221000AB\tBSCpE'],
    ['digits in name', 'JUAN 123\t2022100001\tBSCpE'],
    ['a URL', 'https://example.com/student/2022100001'],
    ['too many fields', 'JUAN\tDELA CRUZ\t2022100001\tBSCpE'],
    ['control characters', 'JUAN DELA CRUZ\u0000\t2022100001\tBSCpE'],
    ['oversized payload', `${'A'.repeat(300)}\t2022100001\tBSCpE`],
  ])('rejects %s', (_label, input) => {
    expect(parseStudentQr(input).ok).toBe(false);
  });
});
