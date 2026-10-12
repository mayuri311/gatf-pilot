import "server-only";

// In-memory request + token budget limiter for the pilot chat endpoint.
//
// SCOPE CAVEAT, read before deploying: this state lives in one Node process.
// It resets on restart and does not span instances, so two `next start` workers
// enforce two independent limits. That is acceptable for a single-process pilot
// and wrong the moment you scale out or deploy to serverless — swap the Map for
// Redis/Upstash at that point. The limiter is a cost guard, not a security
// control; the auth gate is what keeps strangers out.
//
// Note this is only half the runaway-loop story. Request rate limiting cannot
// stop a single request from looping internally — the tool-loop iteration cap
// and wall-clock deadline in the chat route handle that.

const WINDOW_MINUTE_MS = 60_000;
const WINDOW_DAY_MS = 24 * 60 * 60 * 1000;

export const LIMITS = {
  requestsPerMinute: 10,
  requestsPerDay: 100,
  /** Cumulative model tokens (input + output) per session per day. */
  tokensPerDay: 200_000,
} as const;

type Counter = { count: number; resetAt: number };
type Bucket = {
  minute: Counter;
  day: Counter;
  tokensDay: Counter;
};

const buckets = new Map<string, Bucket>();

function freshCounter(windowMs: number): Counter {
  return { count: 0, resetAt: Date.now() + windowMs };
}

function roll(counter: Counter, windowMs: number): Counter {
  if (Date.now() >= counter.resetAt) {
    counter.count = 0;
    counter.resetAt = Date.now() + windowMs;
  }
  return counter;
}

function bucketFor(sid: string): Bucket {
  let b = buckets.get(sid);
  if (!b) {
    b = {
      minute: freshCounter(WINDOW_MINUTE_MS),
      day: freshCounter(WINDOW_DAY_MS),
      tokensDay: freshCounter(WINDOW_DAY_MS),
    };
    buckets.set(sid, b);
  }
  roll(b.minute, WINDOW_MINUTE_MS);
  roll(b.day, WINDOW_DAY_MS);
  roll(b.tokensDay, WINDOW_DAY_MS);
  return b;
}

// Keep the Map from growing without bound across a long-lived process.
function evictExpired() {
  if (buckets.size < 1000) return;
  const now = Date.now();
  for (const [sid, b] of buckets) {
    if (now >= b.day.resetAt && now >= b.tokensDay.resetAt) buckets.delete(sid);
  }
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSeconds: number };

/**
 * Call once per request, before doing any model work. Consumes one request
 * from the minute and day budgets when it returns ok.
 */
export function checkRateLimit(sid: string): RateLimitResult {
  evictExpired();
  const b = bucketFor(sid);

  if (b.tokensDay.count >= LIMITS.tokensPerDay) {
    return {
      ok: false,
      reason: `Daily token budget of ${LIMITS.tokensPerDay.toLocaleString()} reached for this session.`,
      retryAfterSeconds: Math.ceil((b.tokensDay.resetAt - Date.now()) / 1000),
    };
  }
  if (b.day.count >= LIMITS.requestsPerDay) {
    return {
      ok: false,
      reason: `Daily limit of ${LIMITS.requestsPerDay} questions reached for this session.`,
      retryAfterSeconds: Math.ceil((b.day.resetAt - Date.now()) / 1000),
    };
  }
  if (b.minute.count >= LIMITS.requestsPerMinute) {
    return {
      ok: false,
      reason: `Rate limit: max ${LIMITS.requestsPerMinute} questions per minute.`,
      retryAfterSeconds: Math.ceil((b.minute.resetAt - Date.now()) / 1000),
    };
  }

  b.minute.count += 1;
  b.day.count += 1;
  return { ok: true };
}

/** Call after the model turn completes, with the total tokens it consumed. */
export function recordTokenUsage(sid: string, tokens: number): void {
  bucketFor(sid).tokensDay.count += tokens;
}

/** Exposed so the UI can show remaining budget. */
export function usageSnapshot(sid: string) {
  const b = bucketFor(sid);
  return {
    requestsThisMinute: b.minute.count,
    requestsToday: b.day.count,
    tokensToday: b.tokensDay.count,
    limits: LIMITS,
  };
}

/** Test-only: drop all state. */
export function __resetRateLimits() {
  buckets.clear();
}
