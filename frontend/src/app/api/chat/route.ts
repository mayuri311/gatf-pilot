import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { checkRateLimit, recordTokenUsage } from "@/lib/rate-limit";
import { MCP_URL, callMcpTool, listAllowedTools } from "@/lib/mcp-client";

export const runtime = "nodejs"; // needs sockets for the MCP SSE transport
export const dynamic = "force-dynamic";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 8_000;

/** Loop bounds — the actual answer to "make sure no bug loops". */
const MAX_TOOL_ITERATIONS = 8;
const DEADLINE_MS = 60_000;

/** Client history caps. */
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 2_000;

const SYSTEM_PROMPT = `You are a read-only analytics assistant for the GATF parking-lot camera pilot. You answer questions about vehicle entries, exits, and lot occupancy by querying a Postgres database through your tools.

## Your data

You can query exactly five views. You have no access to the underlying tables.

- \`lot_data_coverage\` — one row per day that has data: event_count, entry_count, exit_count, has_exit_events, first_event_at, last_event_at.
- \`lot_events_local\` — every crossing event, with timestamps already converted to America/New_York. Columns include ts_local, local_date, local_hour, event_type ('entry'|'exit'), occupancy_count, vehicle_class, plate_text.
- \`lot_occupancy_timeline\` — occupancy as a step function: valid_from, valid_to (NULL = current), occupancy_count.
- \`lot_hourly\` — per local hour: entries, exits, max_occupancy, min_occupancy, avg_occupancy.
- \`lot_capacity\` — single row, total capacity. The denominator for "how full".

## Rules you must follow

1. **Check coverage first.** Before answering any question scoped to a date or time window, query \`lot_data_coverage\` for that window. A date missing from that view means the camera recorded nothing — say "there is no data for that window". Never report zero, and never estimate.

2. **Never state a number you did not get from a query.** If a query returns no rows, say so plainly. Do not interpolate, extrapolate, or fall back on an earlier answer. "I don't have data for that" is a correct and useful answer.

3. **Use local time columns.** Questions like "this morning", "today", "2pm" are in America/New_York. Filter on local_date / local_hour / ts_local. Never filter on timestamp_utc — it would silently shift the window by the UTC offset and return a plausible wrong answer.

4. **Occupancy figures are currently unreliable.** The capture script's occupancy counter resets to 0 on every restart, so occupancy_count is a per-run count, not a durable lot total. When you report any occupancy number, state this caveat. If \`has_exit_events\` is false for the period, occupancy cannot have decreased — say so rather than presenting the number as a lot total.

5. **Read-only.** You have SELECT on those five views and nothing else. Do not attempt INSERT, UPDATE, DELETE, DROP, or ALTER; they will fail with a permission error. If a user asks you to modify or delete data, tell them you cannot and that this endpoint is read-only by design.

6. **Aggregate rather than paginate.** Tool results are capped at 100 rows. If you need more, rewrite the query with COUNT/SUM/GROUP BY or a tighter WHERE clause.

## Style

Answer in one or two sentences with the actual figure, then any necessary caveat. The user sees your SQL separately, so do not paste it into your reply. No preamble.`;

type ClientTurn = { role: "user" | "assistant"; content: string };

type QueryRecord = {
  tool: string;
  sql: string | null;
  rowCount: number | null;
  durationMs: number;
  truncated: boolean;
  isError: boolean;
};

let anthropic: Anthropic | undefined;
function getAnthropic(): Anthropic {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("Missing ANTHROPIC_API_KEY environment variable");
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

/**
 * Client-supplied history is untrusted input. Without this, a crafted payload
 * could inject fabricated "tool results" that the model would treat as real
 * database output — the most direct route to a confidently wrong answer in the
 * whole design. Only plain text user/assistant turns survive.
 */
function sanitizeHistory(raw: unknown): ClientTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ClientTurn[] = [];
  let chars = 0;

  for (const item of raw.slice(-MAX_HISTORY_TURNS)) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || content.length === 0) continue;

    const text = content.slice(0, MAX_MESSAGE_CHARS);
    if (chars + text.length > MAX_HISTORY_CHARS) break;
    chars += text.length;
    turns.push({ role, content: text });
  }

  // The API requires the first message be from the user.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();
  return turns;
}

/** Extracts a tabular resultset for the UI from a JSON array of row objects. */
function extractTable(
  text: string,
): { columns: string[]; rows: unknown[][] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return null;
    const columns = Object.keys(first as Record<string, unknown>);
    const rows = parsed.map((r) =>
      columns.map((c) => (r as Record<string, unknown>)[c]),
    );
    return { columns, rows };
  } catch {
    return null;
  }
}

function textFromContent(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function POST(request: Request) {
  // Re-verify the session here rather than trusting src/proxy.ts. The proxy is
  // an optimistic gate; this is the authorization check.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = checkRateLimit(session.sid);
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.reason },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: { message?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }
  const userMessage = body.message.slice(0, MAX_MESSAGE_CHARS);

  const messages: Anthropic.MessageParam[] = [
    ...sanitizeHistory(body.history),
    { role: "user", content: userMessage },
  ];

  const queries: QueryRecord[] = [];
  const warnings: string[] = [];
  let table: { columns: string[]; rows: unknown[][] } | null = null;
  let coverageChecked = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "unknown";
  let answer = "";

  const deadline = Date.now() + DEADLINE_MS;

  // Connect to the sidecar first, in its own try/catch. Detecting "MCP is
  // down" by regex-matching the message of a generic catch is fragile - the
  // transport surfaces connection-refused, a 404 from an unrelated service
  // squatting on the port, and TLS failures as completely different strings.
  // Isolating the call means the failure is identified by WHERE it happened.
  let tools: Anthropic.Tool[];
  try {
    const mcpTools = await listAllowedTools();
    tools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: (t.inputSchema ?? {
        type: "object",
        properties: {},
      }) as Anthropic.Tool.InputSchema,
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[chat] MCP connect failed:", detail);
    recordTokenUsage(session.sid, 0);
    return NextResponse.json(
      {
        error:
          `Cannot reach the database service at ${MCP_URL}. ` +
          `Start it with scripts/run_postgres_mcp.sh, and check nothing else is using that port ` +
          `(a 404 here usually means a different service answered). Detail: ${detail}`,
      },
      { status: 503 },
    );
  }

  try {
    let iterations = 0;

    while (true) {
      if (iterations >= MAX_TOOL_ITERATIONS) {
        warnings.push(
          `Stopped after ${MAX_TOOL_ITERATIONS} tool calls. The answer may be incomplete.`,
        );
        break;
      }
      if (Date.now() > deadline) {
        warnings.push("Stopped at the 60s time limit. The answer may be incomplete.");
        break;
      }
      iterations += 1;

      const response = await getAnthropic().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      stopReason = response.stop_reason ?? "unknown";

      const text = textFromContent(response.content);
      if (text) answer = text;

      if (response.stop_reason === "refusal") {
        answer = answer || "I can't help with that request.";
        break;
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) break;

      // Append the assistant turn whole — this preserves thinking blocks and
      // tool_use blocks, both of which must round-trip unmodified.
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        const sql = typeof args.sql === "string" ? args.sql : null;

        const outcome = await callMcpTool(use.name, args);

        // Provenance is recorded from the call WE made, never from what the
        // model says it did — that is what makes these fields trustworthy.
        queries.push({
          tool: use.name,
          sql,
          rowCount: outcome.rowCount,
          durationMs: outcome.durationMs,
          truncated: outcome.truncated,
          isError: outcome.isError,
        });

        if (sql && /lot_data_coverage/i.test(sql)) coverageChecked = true;
        if (!outcome.isError) {
          const parsed = extractTable(outcome.text);
          if (parsed) table = parsed;
        }
        if (outcome.truncated) {
          warnings.push("A query returned more rows than can be shown; results were truncated.");
        }

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.text,
          is_error: outcome.isError,
        });
      }

      // All tool results must go back in a single user message.
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chat]", message);
    return NextResponse.json(
      { error: "The assistant failed to answer. Check the server logs." },
      { status: 502 },
    );
  } finally {
    recordTokenUsage(session.sid, inputTokens + outputTokens);
  }

  if (!answer) {
    answer = "I wasn't able to produce an answer for that.";
  }
  if (queries.length > 0 && !coverageChecked) {
    warnings.push(
      "Data coverage was not verified for this answer — treat any figure as unconfirmed.",
    );
  }

  return NextResponse.json({
    id: crypto.randomUUID(),
    answer,
    queries,
    data: table,
    coverageChecked,
    usage: { inputTokens, outputTokens },
    stopReason,
    warnings: [...new Set(warnings)],
  });
}
