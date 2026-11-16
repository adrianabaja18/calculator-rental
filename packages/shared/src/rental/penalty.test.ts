import { describe, expect, it } from 'vitest';
import { DoorState, PenaltyType } from '../enums';
import { ErrorCode } from '../errors';
import { calculatePenalty, verifyReturnedCalculator, type PenaltySettings } from './penalty';

const policy: PenaltySettings = {
  penaltyEnabled: true,
  penaltyType: PenaltyType.PER_INTERVAL,
  penaltyAmount: 10,
  penaltyIntervalMinutes: 90,
  penaltySteps: [],
  maxPenalty: null,
  gracePeriodMinutes: 10,
};
const due = new Date('2026-10-20T05:00:00Z'); // rented 10:00 AM, due 1:00 PM Manila
const late = (minutes: number) => new Date(due.getTime() + minutes * 60_000);

describe('team policy: ₱10 per started 1.5 h, 10-min grace', () => {
  it.each([
    [0, 0], // on time
    [10, 0], // within grace
    [11, 10],
    [60, 10], // returned at 4 h → ₱10 (team example)
    [90, 10],
    [91, 20],
    [120, 20], // returned at 5 h
    [180, 20], // returned at 6 h → ₱20 (team example)
    [240, 30], // returned at 7 h
    [24 * 60, 160], // a full day late (kiosk off overnight still counts)
  ])('%i min late → ₱%i', (minutes, pesos) => {
    expect(calculatePenalty(due, late(minutes), policy)).toEqual({ overdueMinutes: minutes, amountCentavos: pesos * 100 });
  });

  it('charges nothing for an early return', () => {
    expect(calculatePenalty(due, late(-30), policy)).toEqual({ overdueMinutes: 0, amountCentavos: 0 });
  });
});

describe('other settings', () => {
  it('charges nothing when penalties are disabled', () => {
    expect(calculatePenalty(due, late(300), { ...policy, penaltyEnabled: false }).amountCentavos).toBe(0);
  });

  it('FLAT charges one amount once past grace', () => {
    const flat = { ...policy, penaltyType: PenaltyType.FLAT, penaltyAmount: 25 };
    expect(calculatePenalty(due, late(11), flat).amountCentavos).toBe(2500);
    expect(calculatePenalty(due, late(500), flat).amountCentavos).toBe(2500);
  });

  it('STEPPED picks the matching tier and stays on the last tier beyond it', () => {
    const stepped = {
      ...policy,
      penaltyType: PenaltyType.STEPPED,
      penaltySteps: [
        { upToMinutes: 60, amount: 5 },
        { upToMinutes: 180, amount: 15 },
      ],
    };
    expect(calculatePenalty(due, late(30), stepped).amountCentavos).toBe(500);
    expect(calculatePenalty(due, late(61), stepped).amountCentavos).toBe(1500);
    expect(calculatePenalty(due, late(999), stepped).amountCentavos).toBe(1500);
  });

  it('caps at the maximum penalty', () => {
    expect(calculatePenalty(due, late(24 * 60), { ...policy, maxPenalty: 50 }).amountCentavos).toBe(5000);
  });
});

describe('verifyReturnedCalculator', () => {
  const expected = '04-A1-B2-C3-D4';
  it('accepts the correct calculator with the door closed or no door sensor', () => {
    expect(verifyReturnedCalculator({ expectedRfidUid: expected, detectedRfidUid: expected, doorState: DoorState.CLOSED }).ok).toBe(true);
    expect(verifyReturnedCalculator({ expectedRfidUid: expected, detectedRfidUid: expected, doorState: DoorState.UNKNOWN }).ok).toBe(true);
  });
  it('rejects an empty locker (Rule 9: nothing or a random object without our tag)', () => {
    expect(verifyReturnedCalculator({ expectedRfidUid: expected, detectedRfidUid: null, doorState: DoorState.CLOSED })).toMatchObject({
      ok: false,
      code: ErrorCode.RFID_NOT_DETECTED,
    });
  });
  it('rejects the wrong calculator (Rule 10)', () => {
    expect(
      verifyReturnedCalculator({ expectedRfidUid: expected, detectedRfidUid: '04-E5-F6-A7-B8', doorState: DoorState.CLOSED }),
    ).toMatchObject({ ok: false, code: ErrorCode.RFID_MISMATCH });
  });
  it('waits for the door to close when a sensor reports it open', () => {
    expect(verifyReturnedCalculator({ expectedRfidUid: expected, detectedRfidUid: expected, doorState: DoorState.OPEN })).toMatchObject({
      ok: false,
      code: ErrorCode.LOCKER_CLOSE_FAILED,
    });
  });
});
