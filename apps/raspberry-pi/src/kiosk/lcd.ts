import { ErrorCode, formatPhilippineTime } from '@calc-rental/shared';

/**
 * 16×2 character LCD (HD44780 + PCF8574 I2C backpack), confirmed by the team.
 * Every screen is exactly 2 lines of 16 plain ASCII characters:
 * the HD44780 has no ₱ or Ñ, so text is converted ("₱20" → "P20", "PEÑA" → "PENA").
 */
export const LCD_COLUMNS = 16;
export type LcdScreen = readonly [string, string];

function toLcdText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // drop accents: Ñ → N, é → e
    .replace(/₱/g, 'P')
    .replace(/[^\x20-\x7E]/g, '?') // anything else the LCD can't draw
    .toUpperCase()
    .slice(0, LCD_COLUMNS)
    .padEnd(LCD_COLUMNS);
}

export function screen(line1: string, line2 = ''): LcdScreen {
  return [toLcdText(line1), toLcdText(line2)];
}

const peso = (centavos: number) => `P${Math.floor(centavos / 100)}${centavos % 100 ? `.${String(centavos % 100).padStart(2, '0')}` : ''}`;
const hours = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} HOUR${minutes === 60 ? '' : 'S'}` : `${minutes} MIN`);

/** Every message the kiosk can show (spec §5–6 wording, shortened to 16 columns). */
export const LCD = {
  starting: () => screen('STARTING...', 'PLEASE WAIT'),
  waitingForClock: () => screen('PLEASE WAIT', 'SYNCING CLOCK'),
  ready: () => screen('SYSTEM READY', 'SCAN STUDENT ID'),
  checking: () => screen('CHECKING ID...', 'PLEASE WAIT'),
  quote: (name: string, feeCentavos: number, durationMinutes: number) =>
    screen(name, `${peso(feeCentavos)} / ${hours(durationMinutes)}`),
  payment: (paidCentavos: number, requiredCentavos: number) =>
    screen(`PAYMENT ${peso(paidCentavos)}/${peso(requiredCentavos)}`, 'INSERT COINS'),
  lockerOpen: (lockerNumber: number) => screen(`LOCKER ${lockerNumber} OPEN`, 'TAKE CALCULATOR'),
  // "RETURN BY 12:00 PM" (spec) is 18 chars; "DUE AT 12:00 PM" always fits in 16.
  rentalSuccess: (dueAt: string) => screen('RENTAL SUCCESS', `DUE AT ${formatPhilippineTime(dueAt)}`),
  penaltyDue: (overdueMinutes: number, penaltyCentavos: number) =>
    screen(`LATE ${Math.floor(overdueMinutes / 60)}H${String(overdueMinutes % 60).padStart(2, '0')}M`, `PAY PENALTY ${peso(penaltyCentavos)}`),
  returnTo: (calculatorCode: string, lockerNumber: number) =>
    screen(`RETURN CALC #${calculatorCode.replace(/^CALC-0*/, '')}`, `TO LOCKER ${lockerNumber}`),
  wrongCalculator: (calculatorCode: string) => screen('WRONG CALCULATOR', `RETURN CALC #${calculatorCode.replace(/^CALC-0*/, '')}`),
  returnSuccess: (penaltyPaidCentavos: number) =>
    penaltyPaidCentavos > 0 ? screen('RETURN SUCCESS', `PENALTY: ${peso(penaltyPaidCentavos)}`) : screen('RETURN SUCCESS', 'THANK YOU'),
  paymentTimeout: () => screen('PAYMENT TIMEOUT', 'PLEASE TRY AGAIN'),
  penaltyNotPaid: () => screen('RETURN CANCELLED', 'PENALTY NOT PAID'),
  removalTimeout: () => screen('NOT TAKEN', 'SEE AN OFFICER'),
  returnTimeout: () => screen('RETURN CANCELLED', 'NOT RETURNED'),
  systemError: () => screen('SYSTEM ERROR', 'SEE AN OFFICER'),
} as const;

/** Refusal screens keyed by the error code the services return. */
export function errorScreen(code: ErrorCode): LcdScreen {
  switch (code) {
    case ErrorCode.INVALID_QR:
      return screen('INVALID ID', 'SCAN AGAIN');
    case ErrorCode.STUDENT_NOT_ALLOWED:
      return screen('ACCOUNT BLOCKED', 'SEE AN OFFICER');
    case ErrorCode.ACTIVE_RENTAL_EXISTS:
      return screen('ACTIVE RENTAL', 'RETURN IT FIRST');
    case ErrorCode.UNPAID_PENALTY:
      return screen('UNPAID PENALTY', 'SEE AN OFFICER');
    case ErrorCode.NO_CALCULATOR_AVAILABLE:
      return screen('NO CALCULATOR', 'AVAILABLE');
    case ErrorCode.NO_ACTIVE_RENTAL:
      return screen('NO ACTIVE RENTAL');
    case ErrorCode.RFID_NOT_DETECTED:
      return screen('CALCULATOR', 'NOT DETECTED');
    case ErrorCode.LOCKER_CLOSE_FAILED:
      return screen('PLEASE CLOSE', 'THE LOCKER DOOR');
    case ErrorCode.PAYMENT_TIMEOUT:
      return LCD.paymentTimeout();
    case ErrorCode.DATABASE_UNAVAILABLE:
      return screen('KIOSK NOT READY', 'SEE AN OFFICER');
    default:
      return LCD.systemError();
  }
}
