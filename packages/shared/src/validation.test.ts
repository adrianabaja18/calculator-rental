import { describe, expect, it } from 'vitest';
import { PenaltyType } from './enums';
import { SystemSettingsSchema, normalizeRfidUid, type SystemSettings } from './validation';

describe('normalizeRfidUid', () => {
  it.each([
    ['04-A1-B2-C3-D4', '04-A1-B2-C3-D4'],
    ['04:a1:b2:c3:d4', '04-A1-B2-C3-D4'],
    ['04 A1 B2 C3 D4', '04-A1-B2-C3-D4'],
    ['04a1b2c3d4', '04-A1-B2-C3-D4'],
    ['DEADBEEF', 'DE-AD-BE-EF'], // 4-byte RC522 UID
    ['04112233445566', '04-11-22-33-44-55-66'], // 7-byte UID
  ])('normalises %s', (input, expected) => {
    expect(normalizeRfidUid(input)).toBe(expected);
  });

  it.each(['', 'XYZ', '04-A1-B2', '04A1B2C', '00'.repeat(11)])('rejects %s', (input) => {
    expect(normalizeRfidUid(input)).toBeNull();
  });
});

const validSettings: SystemSettings = {
  rentalFee: 5,
  rentalDurationMinutes: 120,
  gracePeriodMinutes: 10,
  penaltyEnabled: true,
  penaltyType: PenaltyType.PER_INTERVAL,
  penaltyAmount: 5,
  penaltyIntervalMinutes: 60,
  penaltySteps: [],
  maxPenalty: null,
  maxConcurrentRentalsPerStudent: 1,
  unpaidPenaltyBlocksRental: true,
  acceptedCoinDenominations: [1, 5, 10, 20],
  paymentTimeoutSeconds: 120,
  removalTimeoutSeconds: 60,
  returnTimeoutSeconds: 90,
  allowOfflineReturns: true,
  allowOfflineRentals: false,
  operatingHoursStart: '09:00',
  operatingHoursEnd: '17:00',
  operatingDays: [1, 2, 3, 4, 5],
  closedDates: [],
  pauseClockOutsideHours: true,
};

describe('SystemSettingsSchema', () => {
  it('accepts the specification defaults', () => {
    expect(SystemSettingsSchema.safeParse(validSettings).success).toBe(true);
  });

  it('fills in operating hours for settings saved before they existed (old kiosk copies keep working)', () => {
    const { operatingHoursStart, operatingHoursEnd, operatingDays, closedDates, pauseClockOutsideHours, ...old } = validSettings;
    void [operatingHoursStart, operatingHoursEnd, operatingDays, closedDates, pauseClockOutsideHours];
    expect(SystemSettingsSchema.parse(old)).toMatchObject({
      operatingHoursStart: '09:00',
      operatingHoursEnd: '17:00',
      operatingDays: [1, 2, 3, 4, 5],
      closedDates: [],
      pauseClockOutsideHours: true,
    });
  });

  it('rejects a closing time before the opening time, and bad dates', () => {
    expect(SystemSettingsSchema.safeParse({ ...validSettings, operatingHoursStart: '17:00', operatingHoursEnd: '09:00' }).success).toBe(false);
    expect(SystemSettingsSchema.safeParse({ ...validSettings, closedDates: ['25-12-2026'] }).success).toBe(false);
    expect(SystemSettingsSchema.safeParse({ ...validSettings, operatingDays: [] }).success).toBe(false);
  });

  it.each<[string, Partial<SystemSettings>]>([
    ['a fractional rental fee', { rentalFee: 5.5 }],
    ['a zero rental fee', { rentalFee: 0 }],
    ['unsupported coins', { acceptedCoinDenominations: [1, 2] }],
    ['duplicate coins', { acceptedCoinDenominations: [5, 5] }],
    ['no coins', { acceptedCoinDenominations: [] }],
    ['max penalty below penalty amount', { maxPenalty: 2 }],
    ['STEPPED without tiers', { penaltyType: PenaltyType.STEPPED, penaltySteps: [] }],
    [
      'unsorted tiers',
      {
        penaltyType: PenaltyType.STEPPED,
        penaltySteps: [
          { upToMinutes: 120, amount: 10 },
          { upToMinutes: 60, amount: 5 },
        ],
      },
    ],
    ['offline rentals without offline returns', { allowOfflineRentals: true, allowOfflineReturns: false }],
    ['more than one concurrent rental', { maxConcurrentRentalsPerStudent: 2 as 1 }],
  ])('rejects %s', (_label, override) => {
    expect(SystemSettingsSchema.safeParse({ ...validSettings, ...override }).success).toBe(false);
  });
});
