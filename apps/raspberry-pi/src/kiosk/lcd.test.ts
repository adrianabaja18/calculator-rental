import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@calc-rental/shared';
import { LCD, LCD_COLUMNS, errorScreen, screen } from './lcd';

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
    expect(LCD.ready()).toEqual(screen('SYSTEM READY', 'SCAN STUDENT ID'));
    expect(LCD.quote('JUAN DELA CRUZ', 2000, 180)).toEqual(screen('JUAN DELA CRUZ', 'P20 / 3 HOURS'));
    expect(LCD.payment(500, 2000)).toEqual(screen('PAYMENT P5/P20', 'INSERT COINS'));
    expect(LCD.lockerOpen(1)).toEqual(screen('LOCKER 1 OPEN', 'TAKE CALCULATOR'));
    expect(LCD.rentalSuccess('2026-10-20T05:00:00.000Z')).toEqual(screen('RENTAL SUCCESS', 'DUE AT 01:00 PM'));
    expect(LCD.rentalSuccess('2026-10-20T04:00:00.000Z')[1].trimEnd()).toBe('DUE AT 12:00 PM'); // longest time still fits
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
      LCD.ready(),
      LCD.checking(),
      LCD.quote('MARIA CLARA DE LOS SANTOS', 2000, 180),
      LCD.payment(2000, 2000),
      LCD.lockerOpen(12),
      LCD.rentalSuccess('2026-10-20T04:00:00.000Z'),
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
