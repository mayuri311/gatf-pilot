import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Next.js 16 renamed Middleware to Proxy. This file must be `proxy.ts` (not
// `middleware.ts`) and must sit at the same level as `app/` — i.e. src/proxy.ts.
//
// This is an OPTIMISTIC gate only. The Next.js docs are explicit that proxy
// "should not be used as a full session management or authorization solution",
// so /api/chat re-verifies the cookie itself. Deleting this file would not open
// a hole in the API; it exists so unauthenticated browsers get bounced to the
// login screen instead of watching a page render and then fail.

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (session) return NextResponse.next();

  // API routes get a JSON 401; page routes get redirected to the login form.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Note /api/login is absent on purpose — it is how you get a cookie.
  matcher: ["/chat", "/api/chat"],
};
