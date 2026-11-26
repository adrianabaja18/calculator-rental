import { describe, expect, it } from 'vitest';
import { ScannerDecoder, scannerCommand } from './scanner-protocol';

// Fake identity only. JSON escapes the TABs of the school-ID format as \t.
const JUAN_LINE = '{"type":"qr","seq":1,"data":"JUAN DELA CRUZ\\t2022100001\\tBSCpE"}';

function setup() {
  const scans: string[] = [];
  let clock = 0;
  const decoder = new ScannerDecoder((raw) => scans.push(raw), { now: () => clock });
  return { decoder, scans, advance: (ms: number) => (clock += ms) };
}

describe('ScannerDecoder', () => {
  it('delivers the raw QR text with its TABs intact', () => {
    const { decoder, scans } = setup();
    expect(decoder.feed(JUAN_LINE)).toBe('scan');
    expect(scans).toEqual(['JUAN DELA CRUZ\t2022100001\tBSCpE']);
  });

  it('accepts Windows line endings', () => {
    const { decoder, scans } = setup();
    decoder.feed(`${JUAN_LINE}\r`);
    expect(scans).toHaveLength(1);
  });

  it('drops the same ID seen again within 3 s (camera sees many frames)', () => {
    const { decoder, scans, advance } = setup();
    decoder.feed(JUAN_LINE);
    advance(500);
    expect(decoder.feed(JUAN_LINE)).toBe('duplicate');
    advance(2900); // still held in front of the camera: window keeps extending
    expect(decoder.feed(JUAN_LINE)).toBe('duplicate');
    advance(3100); // taken away and shown again
    expect(decoder.feed(JUAN_LINE)).toBe('scan');
    expect(scans).toHaveLength(2);
  });

  it('a different ID is delivered immediately', () => {
    const { decoder, scans } = setup();
    decoder.feed(JUAN_LINE);
    decoder.feed('{"type":"qr","seq":2,"data":"MARIA SANTOS\\t2023100002\\tBSCE"}');
    expect(scans).toHaveLength(2);
  });

  it('records hello/alive as scanner health, not scans', () => {
    const { decoder, scans, advance } = setup();
    advance(42);
    expect(decoder.feed('{"type":"hello","fw":"1.0.0"}')).toBe('status');
    expect(decoder.feed('{"type":"alive","seq":7}')).toBe('status');
    expect(decoder.firmwareVersion).toBe('1.0.0');
    expect(decoder.lastHeardAt).toBe(42);
    expect(scans).toEqual([]);
  });

  it('power saving (firmware 1.1.0): tracks whether the camera sleeps; commands are one JSON line', () => {
    const { decoder } = setup();
    expect(decoder.cameraState).toBeNull(); // firmware 1.0.0 never says
    expect(decoder.feed('{"type":"state","state":"sleeping"}')).toBe('status');
    expect(decoder.cameraState).toBe('sleeping');
    decoder.feed('{"type":"hello","fw":"1.1.0","state":"awake"}'); // a reboot always starts awake
    expect(decoder.cameraState).toBe('awake');
    expect(decoder.feed('{"type":"error","message":"camera restart failed"}')).toBe('status');
    expect(scannerCommand('sleep')).toBe('{"cmd":"sleep"}\n');
    expect(scannerCommand('wake')).toBe('{"cmd":"wake"}\n');
  });

  it.each([
    ['ESP32 boot ROM output', 'ets Jun  8 2016 00:22:57'],
    ['broken JSON', '{"type":"qr","seq":1,"data":'],
    ['unknown message type', '{"type":"reboot"}'],
    ['empty QR data', '{"type":"qr","seq":1,"data":""}'],
    ['oversized QR data', `{"type":"qr","seq":1,"data":"${'A'.repeat(300)}"}`],
    ['a JSON array', '[1,2,3]'],
    ['empty line', ''],
  ])('ignores %s', (_label, line) => {
    const { decoder, scans } = setup();
    expect(decoder.feed(line)).toBe('ignored');
    expect(scans).toEqual([]);
    expect(decoder.lastHeardAt).toBeNull();
  });
});
