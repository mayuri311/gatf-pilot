import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSessionToken,
  safeEqual,
  sessionCookieOptions,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared-passphrase login for the pilot. Exchanges PILOT_PASSWORD for an
// HMAC-signed, HttpOnly session cookie.

export async function POST(request: Request) {
  const expected = process.env.PILOT_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!expected || !secret) {
    // Fail closed and say so in the server log — an unset PILOT_PASSWORD must
    // never mean "everyone is allowed in".
    console.error("[login] PILOT_PASSWORD or SESSION_SECRET is not set");
    return NextResponse.json(
      { error: "Server is not configured for login." },
      { status: 500 },
    );
  }

  let password: unknown;
  try {
    ({ password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "Password is required." }, { status: 400 });
  }

  // Length-capped before comparison so a huge body can't be used to probe
  // timing or burn CPU.
  if (password.length > 512 || !(await safeEqual(password, expected))) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return response;
}
