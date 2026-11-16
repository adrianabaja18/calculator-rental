/**
 * Prevents open redirects: after login we only ever send the user to a
 * path INSIDE this app ("/rentals"), never to "//evil.com" or
 * "https://evil.com" that someone slipped into ?next=.
 */
export const DEFAULT_AFTER_LOGIN = '/dashboard';

export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string') return DEFAULT_AFTER_LOGIN;
  if (!/^\/(?![/\\])[A-Za-z0-9\-_/]*(\?[A-Za-z0-9\-_=&%]*)?$/.test(next)) return DEFAULT_AFTER_LOGIN;
  if (next.startsWith('/login') || next.startsWith('/api')) return DEFAULT_AFTER_LOGIN;
  return next;
}
