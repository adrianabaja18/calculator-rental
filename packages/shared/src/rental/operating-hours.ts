import type { SystemSettings } from '../validation';

/**
 * Operating hours (team decision 2026-11-27).
 *
 * The kiosk lends calculators only during operating hours (default Mon–Fri
 * 9:00 AM–5:00 PM, Philippine time, minus closed dates). With
 * `pauseClockOutsideHours`, the rental time and the late time count ONLY
 * inside those hours:
 *
 *   rented Tue 3:00 PM for 3 h → 2 h Tue (3–5 PM) + 1 h Wed (9–10 AM) → due Wed 10:00 AM
 *   rented Fri 4:00 PM for 3 h → 1 h Fri + 2 h Mon                    → due Mon 11:00 AM
 *
 * The Philippines has no daylight-saving time, so Manila is always UTC+8.
 */

export interface OperatingCalendar {
  /** Minutes after midnight (Manila) when the kiosk opens / closes. */
  openMinute: number;
  closeMinute: number;
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  days: readonly number[];
  /** 'YYYY-MM-DD' (Manila) holidays / suspensions: closed all day. */
  closedDates: readonly string[];
  /** true = rental and late time pause while closed. */
  pauseOutside: boolean;
}

export type OperatingSettings = Pick<
  SystemSettings,
  'operatingHoursStart' | 'operatingHoursEnd' | 'operatingDays' | 'closedDates' | 'pauseClockOutsideHours'
>;

const MANILA_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_DAYS = 800; // safety limit for every day-by-day walk

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Builds the calendar from settings. Missing fields (old settings snapshots)
 * mean Mon–Fri 9–5 and NO pausing, i.e. the clock counts every minute as before.
 */
export function operatingCalendar(settings: Partial<OperatingSettings>): OperatingCalendar {
  return {
    openMinute: toMinutes(settings.operatingHoursStart ?? '09:00'),
    closeMinute: toMinutes(settings.operatingHoursEnd ?? '17:00'),
    days: settings.operatingDays ?? [1, 2, 3, 4, 5],
    closedDates: settings.closedDates ?? [],
    pauseOutside: settings.pauseClockOutsideHours === true,
  };
}

/** UTC timestamp (ms) of midnight Manila on the day containing `t`. */
const manilaMidnight = (t: number) => Math.floor((t + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;

/** Opening window of the Manila day starting at `midnight`, or null when closed all day. */
function windowOf(midnight: number, cal: OperatingCalendar): { open: number; close: number } | null {
  const local = new Date(midnight + MANILA_OFFSET_MS);
  const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  if (!cal.days.includes(weekday)) return null;
  if (cal.closedDates.includes(local.toISOString().slice(0, 10))) return null;
  return { open: midnight + cal.openMinute * 60_000, close: midnight + cal.closeMinute * 60_000 };
}

/** Is the kiosk within its operating hours at `at`? (Borrowing is allowed only then.) */
export function isOpenAt(at: Date, cal: OperatingCalendar): boolean {
  const t = at.getTime();
  const w = windowOf(manilaMidnight(t), cal);
  return !!w && t >= w.open && t < w.close;
}

/** `at` itself if open now, else the start of the next opening window (null if none within ~2 years). */
export function nextOpening(at: Date, cal: OperatingCalendar): Date | null {
  if (isOpenAt(at, cal)) return at;
  const t = at.getTime();
  for (let i = 0, day = manilaMidnight(t); i < MAX_DAYS; i++, day += DAY_MS) {
    const w = windowOf(day, cal);
    if (w && w.open > t) return new Date(w.open);
  }
  return null;
}

/** Milliseconds between `from` and `to` that fall inside operating hours (all of them when not pausing). */
export function operatingMillisBetween(from: Date, to: Date, cal: OperatingCalendar): number {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  if (!cal.pauseOutside) return b - a;
  let total = 0;
  for (let day = manilaMidnight(a), i = 0; day < b && i < MAX_DAYS; day += DAY_MS, i++) {
    const w = windowOf(day, cal);
    if (w) total += Math.max(0, Math.min(w.close, b) - Math.max(w.open, a));
  }
  return total;
}

/** Whole operating minutes between `from` and `to`. */
export function operatingMinutesBetween(from: Date, to: Date, cal: OperatingCalendar): number {
  return Math.floor(operatingMillisBetween(from, to, cal) / 60_000);
}

/**
 * `start` + `minutes` of operating time = the due time. A rental that starts
 * while closed begins counting at the next opening.
 */
export function addOperatingMinutes(start: Date, minutes: number, cal: OperatingCalendar): Date {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new RangeError('Rental duration must be a positive whole number of minutes');
  }
  if (!cal.pauseOutside) return new Date(start.getTime() + minutes * 60_000);
  let remaining = minutes * 60_000;
  const t = start.getTime();
  for (let day = manilaMidnight(t), i = 0; i < MAX_DAYS; day += DAY_MS, i++) {
    const w = windowOf(day, cal);
    if (!w) continue;
    const begin = Math.max(w.open, t);
    if (begin >= w.close) continue;
    const available = w.close - begin;
    if (remaining <= available) return new Date(begin + remaining);
    remaining -= available;
  }
  throw new RangeError('No operating hours found: check the operating days and closed dates');
}
