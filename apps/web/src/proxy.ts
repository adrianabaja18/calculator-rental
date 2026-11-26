import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { readPublicEnv } from '@/lib/env';
import { isLocalBackend } from '@/lib/mode';

const LOCAL_SESSION_COOKIE = 'calc_local_session';
const PUBLIC_PATHS = ['/login'];

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (isLocalBackend()) {
    const hasSessionCookie = Boolean(request.cookies.get(LOCAL_SESSION_COOKIE)?.value);
    if (!hasSessionCookie && !isPublic) {
      const loginUrl = new URL('/login', request.url);
      if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next({ request });
  }

  const env = readPublicEnv();
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
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);

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

function redirectKeepingCookies(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  const cacheControl = from.headers.get('Cache-Control');
  if (cacheControl) redirect.headers.set('Cache-Control', cacheControl);
  return redirect;
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
