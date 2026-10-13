import { NextResponse } from "next/server";
import type {
  Response as OpenAIResponse,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { getSessionUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { rpc } from "@/lib/rpc";
import { getServerSupabase } from "@/lib/supabase/server";
import { readonlyDbConfigured, runReadonlySql, type ToolOutcome } from "@/lib/db/readonly";
import { EXECUTE_SQL_TOOL, buildInstructions, getOpenAI, openAiConfigured } from "@/lib/ai/openai";

export const runtime = "nodejs"; // postgres.js needs TCP sockets
export const dynamic = "force-dynamic";

const MAX_OUTPUT_TOKENS = 8_000;

/** Loop bounds — the answer to "make sure no bug loops". */
const MAX_TOOL_ITERATIONS = 8;
const DEADLINE_MS = 60_000;

/** Client history caps. */
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 2_000;

/** Per-user rate limit (in-memory; one process is fine for the pilot). */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const rateBuckets = new Map<string, number[]>();

type ClientTurn = { role: "user" | "assistant"; content: string };

type QueryRecord = {
  tool: string;
  sql: string | null;
  rowCount: number | null;
  durationMs: number;
  truncated: boolean;
  isError: boolean;
};

type Table = { columns: string[]; rows: unknown[][] };

function checkRateLimit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const recent = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, recent);
    return { ok: false, retryAfterSeconds: Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  // Opportunistic cleanup so the map can't grow without bound.
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateBuckets.delete(k);
  }
  return { ok: true };
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

  // Start the conversation on a user turn.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();
  return turns;
}

/** Tabular resultset for the UI from the rows of a successful query. */
function extractTable(outcome: ToolOutcome): Table | null {
  const rows = outcome.rows;
  if (!rows || rows.length === 0) return null;
  const first = rows[0];
  if (!first || typeof first !== "object") return null;
  const columns = Object.keys(first);
  return { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
}

function textFromResponse(response: OpenAIResponse): { text: string; refusal: string } {
  const texts: string[] = [];
  const refusals: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text") texts.push(part.text);
      else if (part.type === "refusal") refusals.push(part.refusal);
    }
  }
  return { text: texts.join("\n").trim(), refusal: refusals.join("\n").trim() };
}

function parseSqlArg(call: ResponseFunctionToolCall): string | null {
  try {
    const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    return typeof args.sql === "string" ? args.sql : null;
  } catch {
    return null;
  }
}

async function audit(chars: number, queries: number) {
  try {
    const supabase = await getServerSupabase();
    await rpc.logAudit(supabase, "ai_question", "chat", { chars, queries });
  } catch {
    // Audit is best-effort; never fail an answer over it.
  }
}

/** AI_MOCK=1: no OpenAI call. Runs one real coverage query so provenance is genuine. */
async function mockAnswer(message: string) {
  const queries: QueryRecord[] = [];
  const warnings: string[] = ["AI_MOCK is enabled: this is a canned answer, not a model response."];
  let table: Table | null = null;
  let answer: string;

  if (readonlyDbConfigured()) {
    const sql = "select * from lot_data_coverage order by 1 desc limit 7";
    const outcome = await runReadonlySql(sql);
    queries.push({
      tool: "execute_sql",
      sql,
      rowCount: outcome.rowCount,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated,
      isError: outcome.isError,
    });
    if (outcome.isError) {
      warnings.push(`The coverage query failed: ${outcome.text}`);
      answer = "(mock) I couldn't read data coverage, so I can't answer that right now.";
    } else {
      table = extractTable(outcome);
      answer =
        outcome.rowCount === 0
          ? "(mock) The coverage view returned no rows, so there is no recorded data to answer from yet."
          : `(mock) The coverage view returned ${outcome.rowCount} row${outcome.rowCount === 1 ? "" : "s"} (most recent day/camera first); a real model would now query the views to answer your question.`;
    }
  } else {
    warnings.push("READONLY_DATABASE_URL is not set, so no query was run.");
    answer = "(mock) The read-only database isn't configured, so I can't run any queries.";
  }

  await audit(message.length, queries.length);

  return NextResponse.json({
    id: crypto.randomUUID(),
    answer,
    queries,
    data: table,
    coverageChecked: queries.some((q) => !q.isError),
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "mock",
    warnings,
  });
}

export async function POST(request: Request) {
  if (!appConfig.ai.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Authorization lives here, not only in proxy.ts (which is an optimistic gate).
  const user = await getSessionUser();
  if (!user || !user.role) {
    return NextResponse.json({ error: "Sign in to ask questions." }, { status: 401 });
  }

  const limit = checkRateLimit(user.id);
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: `Rate limit reached (${RATE_LIMIT_MAX} questions per 10 minutes). Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} min.`,
      },
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
  const userMessage = body.message.trim().slice(0, MAX_MESSAGE_CHARS);

  if (process.env.AI_MOCK === "1") return mockAnswer(userMessage);

  if (!openAiConfigured()) {
    return NextResponse.json(
      { error: "The assistant is not configured: OPENAI_API_KEY is missing on the server (or set AI_MOCK=1)." },
      { status: 503 },
    );
  }
  if (!readonlyDbConfigured()) {
    return NextResponse.json(
      { error: "The assistant is not configured: READONLY_DATABASE_URL is missing on the server." },
      { status: 503 },
    );
  }

  const input: ResponseInputItem[] = [
    ...sanitizeHistory(body.history).map((t) => ({ role: t.role, content: t.content }) as ResponseInputItem),
    { role: "user", content: userMessage },
  ];

  const queries: QueryRecord[] = [];
  const warnings: string[] = [];
  let table: Table | null = null;
  let coverageChecked = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "unknown";
  let answer = "";

  const deadline = Date.now() + DEADLINE_MS;
  const instructions = buildInstructions();

  try {
    let iterations = 0;

    while (true) {
      if (iterations >= MAX_TOOL_ITERATIONS) {
        warnings.push(`Stopped after ${MAX_TOOL_ITERATIONS} model turns. The answer may be incomplete.`);
        stopReason = "max_iterations";
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        warnings.push("Stopped at the 60s time limit. The answer may be incomplete.");
        stopReason = "deadline";
        break;
      }
      iterations += 1;

      let response: OpenAIResponse;
      try {
        response = await getOpenAI().responses.create(
          {
            model: appConfig.ai.model,
            instructions,
            input,
            tools: [EXECUTE_SQL_TOOL],
            max_output_tokens: MAX_OUTPUT_TOKENS,
            // Results can contain plates: don't retain them server-side. Reasoning
            // items are replayed via their encrypted content instead.
            store: false,
            include: ["reasoning.encrypted_content"],
          },
          { signal: AbortSignal.timeout(remaining) },
        );
      } catch (err) {
        if (Date.now() >= deadline) {
          warnings.push("Stopped at the 60s time limit. The answer may be incomplete.");
          stopReason = "deadline";
          break;
        }
        throw err;
      }

      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      stopReason = response.incomplete_details?.reason ?? response.status ?? "unknown";

      const { text, refusal } = textFromResponse(response);
      if (text) answer = text;
      if (refusal && !text) {
        answer = refusal || "I can't help with that request.";
        stopReason = "refusal";
        break;
      }

      const calls = response.output.filter((o): o is ResponseFunctionToolCall => o.type === "function_call");
      if (calls.length === 0) break;

      // Replay the model's output whole (reasoning + function_call items) before
      // the matching function_call_output items.
      input.push(...toResponseInputItems(response.output));

      for (const call of calls) {
        const sql = call.name === EXECUTE_SQL_TOOL.name ? parseSqlArg(call) : null;
        let outcome: ToolOutcome;
        if (call.name !== EXECUTE_SQL_TOOL.name) {
          outcome = {
            text: `Tool "${call.name}" is not available.`,
            isError: true,
            truncated: false,
            rowCount: null,
            durationMs: 0,
          };
        } else if (sql === null) {
          outcome = {
            text: 'Invalid arguments: expected {"sql": string}.',
            isError: true,
            truncated: false,
            rowCount: null,
            durationMs: 0,
          };
        } else {
          outcome = await runReadonlySql(sql);
        }

        // Provenance is recorded from the call WE made, never from what the
        // model says it did — that is what makes these fields trustworthy.
        queries.push({
          tool: call.name,
          sql,
          rowCount: outcome.rowCount,
          durationMs: outcome.durationMs,
          truncated: outcome.truncated,
          isError: outcome.isError,
        });

        if (sql && !outcome.isError && /lot_data_coverage/i.test(sql)) coverageChecked = true;
        if (!outcome.isError) {
          const parsed = extractTable(outcome);
          if (parsed) table = parsed;
        }
        if (outcome.truncated) {
          warnings.push("A query returned more rows than can be shown; results were truncated.");
        }

        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: outcome.isError ? `ERROR: ${outcome.text}` : outcome.text,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/chat]", message);
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: "The AI provider rejected the server's API key. Check OPENAI_API_KEY." },
        { status: 503 },
      );
    }
    if (status === 429) {
      return NextResponse.json({ error: "The AI provider is rate limiting requests. Try again shortly." }, { status: 503 });
    }
    return NextResponse.json({ error: "The assistant failed to answer. Check the server logs." }, { status: 502 });
  }

  if (!answer) answer = "I wasn't able to produce an answer for that.";
  if (queries.length > 0 && !coverageChecked) {
    warnings.push("Data coverage was not verified for this answer — treat any figure as unconfirmed.");
  }

  await audit(userMessage.length, queries.length);

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
