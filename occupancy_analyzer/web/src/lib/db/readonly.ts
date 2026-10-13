import "server-only";
import postgres from "postgres";

/**
 * Read-only SQL execution for the "Ask the lot" assistant.
 *
 * Connects as the `gatf_readonly` role (READONLY_DATABASE_URL), which only has
 * SELECT on the lot_* views. Defence in depth on top of that grant:
 *   1. a cheap lexical check (single SELECT/WITH statement only),
 *   2. every query runs inside a READ ONLY transaction,
 *   3. a per-statement timeout of 8 s.
 *
 * Errors are returned as tool results (isError: true) and never thrown — a
 * permission-denied or syntax error is information the model can act on.
 */

/** Caps on what a single tool result may feed back into the context window. */
export const TOOL_RESULT_LIMITS = {
  maxRows: 100,
  maxChars: 8_000,
} as const;

const STATEMENT_TIMEOUT = "8s";

export type ToolOutcome = {
  /** Text handed back to the model — already truncated. */
  text: string;
  isError: boolean;
  /** True when truncation dropped content. Surfaced in the response schema. */
  truncated: boolean;
  /** Rows the database actually returned (before truncation); null on error. */
  rowCount: number | null;
  durationMs: number;
  /** Up to maxRows result rows, for the UI table. Absent on error. */
  rows?: Record<string, unknown>[];
};

// Keep date/time values as the exact strings Postgres sends. The default parser
// turns `timestamp without time zone` into a JS Date in the *server's* zone and
// JSON-serialises it as UTC, silently shifting the *_local columns.
const asText = (v: string) => v;
const asNumber = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

const PG_TYPES = {
  // date, time, timestamp, timestamptz, timetz, interval
  temporalText: { to: 1114, from: [1082, 1083, 1114, 1184, 1266, 1186], serialize: asText, parse: asText },
  // int8 (count(*), sums) and numeric (avg, round) — safe as JS numbers at this scale.
  numberish: { to: 1700, from: [20, 1700], serialize: (v: unknown) => String(v), parse: asNumber },
};

function createClient(url: string) {
  return postgres(url, {
    max: 3,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    types: PG_TYPES,
    onnotice: () => {},
  });
}

type Client = ReturnType<typeof createClient>;

// Survive dev-server HMR without leaking a pool per reload.
const globalForDb = globalThis as typeof globalThis & { __gatfReadonlySql?: Client };

function getReadonlySql(): Client | null {
  const url = process.env.READONLY_DATABASE_URL;
  if (!url) return null;
  if (!globalForDb.__gatfReadonlySql) globalForDb.__gatfReadonlySql = createClient(url);
  return globalForDb.__gatfReadonlySql;
}

export function readonlyDbConfigured(): boolean {
  return Boolean(process.env.READONLY_DATABASE_URL);
}

/**
 * Removes SQL comments (outside quoted literals/identifiers) so they can't hide a
 * second statement. `code` is the same text with quoted contents blanked, used
 * for the statement-separator check so `';'` inside a literal is allowed.
 */
function stripComments(sql: string): { text: string; code: string } {
  let text = "";
  let code = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      text += ch;
      if (ch === quote) {
        if (next === quote) {
          text += next; // escaped quote ('' or "")
          code += "  ";
          i += 2;
          continue;
        }
        quote = null;
        code += ch;
      } else {
        code += " ";
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      text += ch;
      code += ch;
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      text += " ";
      code += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      text += " ";
      code += " ";
      continue;
    }
    text += ch;
    code += ch;
    i += 1;
  }
  return { text, code };
}

/** Returns the cleaned single statement, or an error message for the model. */
export function validateReadonlySql(raw: string): { ok: true; sql: string } | { ok: false; error: string } {
  const { text, code } = stripComments(raw);
  const trailing = /;\s*$/;
  const cleaned = text.trim().replace(trailing, "").trim();
  const codeOnly = code.trim().replace(trailing, "").trim();
  if (!cleaned) return { ok: false, error: "Empty query." };
  if (!/^(select|with)\b/i.test(cleaned)) {
    return {
      ok: false,
      error: "Only read-only SELECT (or WITH … SELECT) queries are allowed. This endpoint cannot modify data.",
    };
  }
  if (codeOnly.includes(";")) {
    return { ok: false, error: "Only a single SQL statement is allowed per call. Remove the extra ';'." };
  }
  return { ok: true, sql: cleaned };
}

/**
 * Truncation matters more than it looks. An unbounded SELECT would otherwise
 * push thousands of rows into the context window — and then re-send them on
 * every subsequent turn of the loop, multiplying cost and eventually blowing
 * the window outright.
 */
function serialise(rows: Record<string, unknown>[]): { text: string; truncated: boolean; kept: Record<string, unknown>[] } {
  let truncated = false;
  let kept = rows;
  let out: string;

  if (rows.length > TOOL_RESULT_LIMITS.maxRows) {
    kept = rows.slice(0, TOOL_RESULT_LIMITS.maxRows);
    out =
      JSON.stringify(kept) +
      `\n\n[truncated: ${rows.length} rows returned, first ${TOOL_RESULT_LIMITS.maxRows} shown. ` +
      `Re-run with an aggregate (COUNT/SUM/GROUP BY) or a tighter WHERE clause rather than asking for more rows.]`;
    truncated = true;
  } else {
    out = JSON.stringify(rows);
  }

  if (out.length > TOOL_RESULT_LIMITS.maxChars) {
    out =
      out.slice(0, TOOL_RESULT_LIMITS.maxChars) + `\n\n[truncated at ${TOOL_RESULT_LIMITS.maxChars} characters]`;
    truncated = true;
  }

  return { text: out, truncated, kept };
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code?: string; message?: string; hint?: string };
    let msg = `Query failed (${e.code ?? "error"}): ${e.message}`;
    if (e.hint) msg += ` Hint: ${e.hint}`;
    if (e.code === "42501") msg += " Only the lot_* views listed in your instructions are readable.";
    if (e.code === "57014") msg += ` The query exceeded the ${STATEMENT_TIMEOUT} statement timeout; aggregate or narrow the date range.`;
    if (e.code === "25006") msg += " This connection is read-only.";
    return msg;
  }
  return `Query failed: ${err instanceof Error ? err.message : String(err)}`;
}

export async function runReadonlySql(query: string): Promise<ToolOutcome> {
  const started = Date.now();
  const fail = (text: string): ToolOutcome => ({
    text,
    isError: true,
    truncated: false,
    rowCount: null,
    durationMs: Date.now() - started,
  });

  if (typeof query !== "string") return fail("The sql argument must be a string.");
  const checked = validateReadonlySql(query);
  if (!checked.ok) return fail(checked.error);

  const sql = getReadonlySql();
  if (!sql) return fail("The read-only database is not configured (READONLY_DATABASE_URL is unset).");

  try {
    const result = await sql.begin("read only", async (tx) => {
      await tx.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
      return tx.unsafe(checked.sql);
    });
    const rows = Array.from(result as Iterable<Record<string, unknown>>);
    const { text, truncated, kept } = serialise(rows);
    return {
      text: rows.length === 0 ? "[] (0 rows)" : text,
      isError: false,
      truncated,
      rowCount: rows.length,
      durationMs: Date.now() - started,
      rows: kept,
    };
  } catch (err) {
    return fail(describeError(err));
  }
}
