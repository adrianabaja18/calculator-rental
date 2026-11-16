import { DISPLAY_TIME_ZONE } from '../constants';

/**
 * Human-readable rental code generated ON THE KIOSK (SQLite-first: the Pi
 * creates rentals offline, so it can't use the database sequence).
 *
 *   RNT-20261117-K001-7F3A
 *       │        │    └ 4 random hex chars (collision-safe across retries)
 *       │        └ kiosk number from DEVICE-CALC-KIOSK-001
 *       └ date in Philippine time
 *
 * The real primary key is still a UUID; this code is for receipts/LCD/officers.
 */
export function generateTransactionCode(
  now: Date,
  deviceCode: string,
  randomBytes: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const date = `${get('year')}${get('month')}${get('day')}`;

  const kioskNumber = /(\d+)$/.exec(deviceCode)?.[1] ?? '0';
  const kiosk = `K${kioskNumber.padStart(3, '0').slice(-3)}`;

  const random = Array.from(randomBytes(2), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

  return `RNT-${date}-${kiosk}-${random}`;
}

export const TRANSACTION_CODE_PATTERN = /^RNT-\d{8}-K\d{3}-[0-9A-F]{4}$/;
