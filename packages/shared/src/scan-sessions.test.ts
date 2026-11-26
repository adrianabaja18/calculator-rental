import { beforeEach, describe, expect, it } from 'vitest';
import {
  SCAN_MAX_WRONG_CODES,
  openLocalDatabase,
  scanClientHash,
  startScanSession,
  submitScan,
  takeScan,
  type LocalDatabase,
} from './sqlite-node';

// Fake identity only.
const QR = 'JUAN DELA CRUZ\t2026000001\tBSCPE';
const T0 = new Date('2026-11-30T02:00:00.000Z');
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let db: LocalDatabase;
beforeEach(() => {
  db = openLocalDatabase(':memory:');
});

const send = (code: string, client = 'phone-a', at = later(5)) => submitScan(db, { code, qr: QR, clientHash: client }, at);
const wrongCode = (code: string) => (code === '999999' ? '111111' : '999999');

describe('phone scan sessions (local SQLite)', () => {
  it('hands the ID text to the kiosk exactly once, and keeps it on record', () => {
    const s = startScanSession(db, T0);
    expect(s.code).toMatch(/^[0-9]{6}$/);
    expect(takeScan(db, s.id, later(1))).toEqual({ status: 'WAITING', qr: null });
    expect(send(s.code)).toBe('OK');
    expect(send(s.code)).toBe('BAD_CODE'); // single use
    expect(takeScan(db, s.id, later(6))).toEqual({ status: 'SUBMITTED', qr: QR });
    expect(takeScan(db, s.id, later(7))).toEqual({ status: 'CONSUMED', qr: null });
    expect(db.prepare('SELECT status, qr_payload FROM scan_sessions WHERE id = ?').get(s.id)).toEqual({ status: 'CONSUMED', qr_payload: QR });
  });

  it('codes expire after 2 minutes', () => {
    const s = startScanSession(db, T0);
    expect(send(s.code, 'phone-a', later(121))).toBe('BAD_CODE');
    expect(takeScan(db, s.id, later(121)).status).toBe('EXPIRED');
  });

  it('keeps every sent ID, even when the kiosk never took it', () => {
    const first = startScanSession(db, T0);
    expect(send(first.code)).toBe('OK');
    startScanSession(db, later(30)); // kiosk moved on (e.g. restarted) before reading it
    expect(db.prepare('SELECT status, qr_payload FROM scan_sessions WHERE id = ?').get(first.id)).toEqual({ status: 'EXPIRED', qr_payload: QR });
    expect(db.prepare(`SELECT count(*) AS n FROM scan_sessions WHERE qr_payload IS NOT NULL`).get()).toEqual({ n: 1 });
  });

  it('a new code ends the previous one', () => {
    const old = startScanSession(db, T0);
    const fresh = startScanSession(db, later(10));
    expect(takeScan(db, old.id, later(11)).status).toBe('EXPIRED');
    expect(send(fresh.code, 'phone-a', later(12))).toBe('OK');
  });

  it('stops a phone that keeps guessing, but not other phones', () => {
    const s = startScanSession(db, T0);
    for (let i = 0; i < SCAN_MAX_WRONG_CODES; i++) expect(send(wrongCode(s.code), 'guesser')).toBe('BAD_CODE');
    expect(send(s.code, 'guesser')).toBe('TOO_MANY_TRIES');
    expect(send(s.code, 'honest-phone')).toBe('OK');
  });

  it('never stores phone addresses, only a salted hash that is stable per Pi', () => {
    const a = scanClientHash(db, '192.168.1.50');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('192.168');
    expect(scanClientHash(db, '192.168.1.50')).toBe(a);
    expect(scanClientHash(db, '192.168.1.51')).not.toBe(a);
  });
});
