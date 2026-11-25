import { describe, expect, it } from 'vitest';
import {
  addOperatingMinutes,
  isOpenAt,
  nextOpening,
  operatingCalendar,
  operatingMinutesBetween,
} from './operating-hours';
import { rentalCountdown } from './lifecycle';
import { calculatePenalty, penaltyForMinutes, type PenaltySettings } from './penalty';
import { PenaltyType } from '../enums';

/** Manila wall-clock time → Date (Manila is UTC+8). 2026-10-19 is a Monday. */
const mnl = (isoLocal: string) => new Date(`${isoLocal}+08:00`);

const cal = operatingCalendar({
  operatingHoursStart: '09:00',
  operatingHoursEnd: '17:00',
  operatingDays: [1, 2, 3, 4, 5],
  closedDates: ['2026-12-25'],
  pauseClockOutsideHours: true,
});

describe('due time counts only operating hours (team decision 2026-11-27)', () => {
  it.each([
    ['Tue 10:00 → same day 1:00 PM', '2026-10-20T10:00', '2026-10-20T13:00'],
    ['Tue 2:00 PM → exactly at closing', '2026-10-20T14:00', '2026-10-20T17:00'],
    ['Tue 3:00 PM → 2 h today + 1 h tomorrow', '2026-10-20T15:00', '2026-10-21T10:00'],
    ['Tue 4:59 PM → nearly all of it tomorrow', '2026-10-20T16:59', '2026-10-21T11:59'],
    ['Fri 4:00 PM → over the weekend to Monday', '2026-10-23T16:00', '2026-10-26T11:00'],
    ['Thu 3:00 PM before Christmas Day (closed) → Monday', '2026-12-24T15:00', '2026-12-28T10:00'],
    ['started before opening → counts from 9:00 AM', '2026-10-20T07:30', '2026-10-20T12:00'],
  ])('%s', (_label, start, due) => {
    expect(addOperatingMinutes(mnl(start), 180, cal)).toEqual(mnl(due));
  });

  it('counts every minute when pausing is switched off', () => {
    const always = operatingCalendar({ pauseClockOutsideHours: false });
    expect(addOperatingMinutes(mnl('2026-10-20T15:00'), 180, always)).toEqual(mnl('2026-10-20T18:00'));
  });
});

describe('late time counts only operating hours', () => {
  it.each([
    ['same day, 1 h late', '2026-10-20T13:00', '2026-10-20T14:00', 60],
    ['due 4 PM, back next morning 10 AM: 1 h + 1 h', '2026-10-20T16:00', '2026-10-21T10:00', 120],
    ['due 5 PM, back next day 9:05 AM', '2026-10-20T17:00', '2026-10-21T09:05', 5],
    ['due Fri 4 PM, back Mon 9:30 AM: weekend free', '2026-10-23T16:00', '2026-10-26T09:30', 90],
    ['back after closing the same day: only until 5 PM counts', '2026-10-20T16:00', '2026-10-20T19:00', 60],
  ])('%s', (_label, due, back, minutes) => {
    expect(operatingMinutesBetween(mnl(due), mnl(back), cal)).toBe(minutes);
  });

  it('a due 4 PM rental returned next day 10 AM pays for 2 h (₱20), not 18 h', () => {
    const policy: PenaltySettings = {
      penaltyEnabled: true,
      penaltyType: PenaltyType.PER_INTERVAL,
      penaltyAmount: 10,
      penaltyIntervalMinutes: 90,
      penaltySteps: [],
      maxPenalty: null,
      gracePeriodMinutes: 10,
      pauseClockOutsideHours: true,
    };
    expect(calculatePenalty(mnl('2026-10-20T16:00'), mnl('2026-10-21T10:00'), policy)).toEqual({ overdueMinutes: 120, amountCentavos: 2000 });
    expect(penaltyForMinutes(120, policy)).toEqual({ overdueMinutes: 120, amountCentavos: 2000 });
  });
});

describe('open or closed', () => {
  it.each([
    ['Tue 9:00 AM', '2026-10-20T09:00', true],
    ['Tue 4:59 PM', '2026-10-20T16:59', true],
    ['Tue 5:00 PM', '2026-10-20T17:00', false],
    ['Tue 8:59 AM', '2026-10-20T08:59', false],
    ['Saturday noon', '2026-10-24T12:00', false],
    ['Christmas Day noon', '2026-12-25T12:00', false],
  ])('%s → open: %s', (_label, at, open) => {
    expect(isOpenAt(mnl(at), cal)).toBe(open);
  });

  it('next opening: tomorrow morning, after the weekend, or now', () => {
    expect(nextOpening(mnl('2026-10-20T18:00'), cal)).toEqual(mnl('2026-10-21T09:00'));
    expect(nextOpening(mnl('2026-10-23T17:30'), cal)).toEqual(mnl('2026-10-26T09:00'));
    expect(nextOpening(mnl('2026-10-20T11:00'), cal)).toEqual(mnl('2026-10-20T11:00'));
  });
});

describe('dashboard countdown', () => {
  it('shows operating time left and pauses overnight', () => {
    expect(rentalCountdown(mnl('2026-10-21T10:00'), mnl('2026-10-20T15:00'), cal)).toEqual({ overdue: false, text: '03:00:00', paused: false });
    expect(rentalCountdown(mnl('2026-10-21T10:00'), mnl('2026-10-20T20:00'), cal)).toEqual({ overdue: false, text: '01:00:00', paused: true });
    expect(rentalCountdown(mnl('2026-10-20T16:00'), mnl('2026-10-21T10:00'), cal)).toEqual({ overdue: true, text: '02:00:00', paused: false });
  });
});
