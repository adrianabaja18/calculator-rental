import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { readPublicEnv } from '@/lib/env';

/**
 * Next.js 16 Proxy (formerly "middleware"). Runs before every page request.
 *
 * Responsibilities:
 *  1. Refresh the Supabase session cookie so officers aren't logged out
 *     while they work.
 *  2. OPTIMISTIC redirects only:
 *       no session + protected page  -> /login?next=<page>
 *       has session + /login         -> /dashboard
 *
 * This is NOT the security boundary — it doesn't read the database.
 * The real check is requireAdmin() in src/lib/auth/session.ts, which every
 * protected layout/page/action calls. API routes are excluded here and
 * do their own authentication (admin session or device credential).
 */

const PUBLIC_PATHS = ['/login'];

export async function proxy(request: NextRequest) {
  const env = readPublicEnv();
  // Not configured yet (fresh clone without .env.local): let the request
  // through so the login page can explain what is missing.
  if (!env) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // Supabase asks for no-cache headers whenever it rotates auth cookies.
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  // Validates the JWT (and refreshes it if expired). Do not put code
  // between createServerClient and this call.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);

  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!isSignedIn && !isPublic) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
    return redirectKeepingCookies(loginUrl, response);
  }

  if (isSignedIn && isPublic) {
    return redirectKeepingCookies(new URL('/dashboard', request.url), response);
  }

  return response;
}

/** A redirect must carry over any refreshed auth cookies, or the session is lost. */
function redirectKeepingCookies(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  const cacheControl = from.headers.get('Cache-Control');
  if (cacheControl) redirect.headers.set('Cache-Control', cacheControl);
  return redirect;
}

export const config = {
  matcher: [
    // Everything except API routes, Next.js internals and static files.
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
