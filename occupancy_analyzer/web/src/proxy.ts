import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Optimistic auth gate (Next 16 `proxy`, Node runtime).
 * - Refreshes the Supabase session cookie on every matched request.
 * - Everything is protected except /login and /api/health.
 * - Users with app_metadata.must_change_password are pinned to /account/password.
 * Pages, route handlers and server actions re-check auth + role server-side.
 */
const PUBLIC_PATHS = ["/login", "/api/health"];

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  if (searchParams.get("kiosk") === "1") requestHeaders.set("x-kiosk", "1");
  else requestHeaders.delete("x-kiosk");

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const isApi = pathname.startsWith("/api/");

  if (!url || !key) {
    // Misconfigured deployment: let /login render its configuration error.
    if (isPublic) return response;
    return NextResponse.redirect(new URL("/login?error=config", request.url));
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  let claims: Record<string, unknown> | null = null;
  try {
    const { data } = await supabase.auth.getClaims();
    claims = (data?.claims as Record<string, unknown> | undefined) ?? null;
  } catch {
    claims = null;
  }

  const withCookies = (res: NextResponse) => {
    for (const c of response.cookies.getAll()) res.cookies.set(c);
    return res;
  };

  if (!claims) {
    if (isPublic) return response;
    if (isApi) return withCookies(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", pathname + request.nextUrl.search);
    return withCookies(NextResponse.redirect(login));
  }

  const meta = (claims.app_metadata ?? {}) as Record<string, unknown>;
  if (pathname === "/login") {
    return withCookies(NextResponse.redirect(new URL("/", request.url)));
  }
  if (meta.must_change_password === true && !isApi && pathname !== "/account/password") {
    return withCookies(NextResponse.redirect(new URL("/account/password", request.url)));
  }
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)",
  ],
};
