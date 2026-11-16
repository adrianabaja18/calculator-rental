import { DISPLAY_LOCALE, DISPLAY_TIME_ZONE } from './constants';

/**
 * Display helpers. Storage is always UTC; these only FORMAT for humans.
 * Works identically on the server, in the browser and on the Raspberry Pi
 * (regardless of the Pi's OS time-zone setting).
 */

export function formatPhilippineDateTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

/** Short time for the 16-character LCD, e.g. "12:00 PM". */
export function formatPhilippineTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}
