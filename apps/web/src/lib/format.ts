import { CURRENCY_SYMBOL, formatPhilippineDateTime } from '@calc-rental/shared';

/** ₱20.00 */
export function formatPeso(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  return `${CURRENCY_SYMBOL}${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Philippine date-time, or an em dash for empty values. */
export function formatDateTime(value: string | null | undefined): string {
  return value ? formatPhilippineDateTime(value) : '—';
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return 'never';
  const seconds = Math.round((now.getTime() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Cleans a search box value before it goes into a Supabase filter:
 * keeps letters (incl. Ñ), digits, spaces, dot, dash and apostrophe only,
 * so characters like , ( ) can't change the meaning of the query.
 */
export function cleanSearch(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\p{L}\p{N} .'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}
