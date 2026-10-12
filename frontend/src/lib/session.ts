// Shared-passphrase session tokens for the pilot chat endpoint.
//
// Deliberately Web Crypto only (no `node:crypto`, no `jose`): this module is
// imported by BOTH src/proxy.ts, which runs in the Edge runtime, and the Node
// route handlers. Reaching for `node:crypto` here would break the proxy build.
//
// This is a shared-passphrase gate for a pilot, not a user system. There are no
// accounts, no per-user identity, and no revocation beyond rotating
// SESSION_SECRET (which invalidates every outstanding token at once).

export const SESSION_COOKIE = "gatf_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

type SessionPayload = {
  /** Opaque per-login id. Rate limits are keyed on this. */
  sid: string;
  /** Unix seconds. */
  exp: number;
};

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(data),
  );
  return b64urlEncode(new Uint8Array(sig));
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} environment variable`);
  return v;
}

/**
 * Constant-time-ish string comparison without `node:crypto`.
 *
 * Both inputs are HMAC'd under a per-process random key first, so the actual
 * comparison runs over two fixed-length digests. An early-exit compare on
 * digests leaks nothing useful: an attacker cannot steer a digest without
 * already knowing the key, which is random and never leaves this process.
 */
let compareKeyPromise: Promise<CryptoKey> | undefined;
function compareKey(): Promise<CryptoKey> {
  if (!compareKeyPromise) {
    const random = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    compareKeyPromise = hmacKey(random);
  }
  return compareKeyPromise;
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = await compareKey();
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function createSessionToken(): Promise<string> {
  const payload: SessionPayload = {
    sid: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(requiredEnv("SESSION_SECRET"), body);
  return `${body}.${sig}`;
}

/**
 * Verifies signature and expiry. Returns the payload, or null for any failure —
 * callers must treat null as 401 and must not distinguish "bad signature" from
 * "expired" to the client.
 */
export async function verifySessionToken(
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: string;
  try {
    expected = await sign(requiredEnv("SESSION_SECRET"), body);
  } catch {
    return null;
  }
  if (!(await safeEqual(sig, expected))) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(body)),
    ) as SessionPayload;
    if (typeof payload.sid !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
