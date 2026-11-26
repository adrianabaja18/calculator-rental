import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@calc-rental/shared';
import { LCD, LCD_COLUMNS, errorScreen, lockerStatusLine, screen } from './lcd';

const TUE_10AM = new Date('2026-10-20T02:00:00.000Z'); // Tuesday 10:00 AM Manila

const fits = (s: readonly [string, string]) => s.every((line) => line.length === LCD_COLUMNS && /^[\x20-\x7E]*$/.test(line));

describe('16x2 LCD screens', () => {
  it('pads, truncates and upper-cases to exactly 16 ASCII columns', () => {
    expect(screen('Hi')).toEqual(['HI              ', '                ']);
    expect(screen('A VERY LONG STUDENT NAME HERE')[0]).toBe('A VERY LONG STUD');
  });

  it('converts characters the LCD cannot draw', () => {
    expect(screen('JOSÉ PEÑA', '₱20')).toEqual(['JOSE PENA       ', 'P20             ']);
  });

  it('formats the spec messages', () => {
    const status = lockerStatusLine([{ number: 1, available: true }, { number: 2, available: false }]);
    expect(status).toBe('1:READY 2:N/A');
    expect(LCD.ready(status)).toEqual(screen('SCAN STUDENT ID', '1:READY 2:N/A'));
    expect(LCD.pickLocker(status)).toEqual(screen('PUSH BLUE BUTTON', '1:READY 2:N/A'));
    expect(LCD.lockerUnavailable(2, status)).toEqual(screen('LOCKER 2 N/A', '1:READY 2:N/A'));
    expect(LCD.closeAndPressRed()).toEqual(screen('CLOSE THE DOOR', 'PUSH RED BUTTON'));
    expect(lockerStatusLine([{ number: 1, available: true }, { number: 2, available: true }]).length).toBeLessThanOrEqual(16);
    expect(LCD.quote('JUAN DELA CRUZ', 2000, 180)).toEqual(screen('JUAN DELA CRUZ', 'P20 / 3 HOURS'));
    expect(LCD.payment(500, 2000)).toEqual(screen('PAYMENT P5/P20', 'INSERT COINS'));
    expect(LCD.lockerOpen(1)).toEqual(screen('LOCKER 1 OPEN', 'TAKE CALCULATOR'));
    expect(LCD.rentalSuccess('2026-10-20T05:00:00.000Z', TUE_10AM)).toEqual(screen('RENTAL SUCCESS', 'DUE AT 01:00 PM'));
    expect(LCD.rentalSuccess('2026-10-20T04:00:00.000Z', TUE_10AM)[1].trimEnd()).toBe('DUE AT 12:00 PM'); // longest time still fits
    // Operating hours: rented Tue 3 PM → due Wed 10 AM; the weekday is shown.
    expect(LCD.rentalSuccess('2026-10-21T02:00:00.000Z', new Date('2026-10-20T07:00:00.000Z'))).toEqual(
      screen('RENTAL SUCCESS', 'DUE WED 10:00 AM'),
    );
    expect(LCD.closedIdle(new Date('2026-10-26T01:00:00.000Z'))).toEqual(screen('RETURNS ONLY', 'OPEN MON 9:00AM'));
    expect(LCD.closedForBorrowing(new Date('2026-10-21T01:00:00.000Z'))).toEqual(screen('KIOSK CLOSED', 'OPEN WED 9:00AM'));
    expect(LCD.closedIdle(new Date('2026-10-21T02:30:00.000Z'))[1]).toBe('OPEN WED 10:30AM'); // longest still fits
    expect(LCD.penaltyDue(60, 1000)).toEqual(screen('LATE 1H00M', 'PAY PENALTY P10'));
    expect(LCD.returnTo('CALC-002', 2)).toEqual(screen('RETURN CALC #2', 'TO LOCKER 2'));
    expect(LCD.wrongCalculator('CALC-002')).toEqual(screen('WRONG CALCULATOR', 'RETURN CALC #2'));
    expect(LCD.returnSuccess(0)).toEqual(screen('RETURN SUCCESS', 'THANK YOU'));
    expect(LCD.returnSuccess(1000)).toEqual(screen('RETURN SUCCESS', 'PENALTY: P10'));
  });

  it('every message and every error screen fits the display', () => {
    const all = [
      LCD.starting(),
      LCD.waitingForClock(),
      LCD.ready('1:READY 2:N/A'),
      LCD.pickLocker('1:READY 2:N/A'),
      LCD.selectTimeout(),
      LCD.closeAndPressRed(),
      LCD.checking(),
      LCD.quote('MARIA CLARA DE LOS SANTOS', 2000, 180),
      LCD.payment(2000, 2000),
      LCD.lockerOpen(12),
      LCD.rentalSuccess('2026-10-20T04:00:00.000Z', TUE_10AM),
      LCD.penaltyDue(24 * 60 + 5, 16000),
      LCD.returnTo('CALC-010', 10),
      LCD.wrongCalculator('CALC-010'),
      LCD.returnSuccess(16000),
      LCD.paymentTimeout(),
      LCD.penaltyNotPaid(),
      LCD.removalTimeout(),
      LCD.returnTimeout(),
      LCD.systemError(),
      ...Object.values(ErrorCode).map(errorScreen),
    ];
    for (const s of all) {
      expect(fits(s), JSON.stringify(s)).toBe(true);
      // Nothing important may be cut off: the untrimmed text must already fit.
      expect(s.every((line) => !line.endsWith('...')), JSON.stringify(s)).toBe(true);
    }
    expect(LCD.payment(2000, 2000)[0].trimEnd()).toBe('PAYMENT P20/P20');
    expect(LCD.penaltyDue(24 * 60 + 5, 16000)).toEqual(screen('LATE 24H05M', 'PAY PENALTY P160'));
    expect(errorScreen(ErrorCode.ACTIVE_RENTAL_EXISTS)).toEqual(screen('ACTIVE RENTAL', 'RETURN IT FIRST'));
  });
});
