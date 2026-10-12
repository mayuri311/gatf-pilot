import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// MCP client for the postgres-mcp sidecar (see scripts/run_postgres_mcp.sh).
//
// Why we drive MCP from here rather than using the Messages API's native
// `mcp_servers` connector: that connector has Anthropic's infrastructure fetch
// the MCP server, so it needs a PUBLICLY reachable URL. Our sidecar is bound to
// localhost, which is exactly where we want a database holding plate data to
// stay. So we act as the MCP client ourselves and expose its tools to the model
// as ordinary tool definitions.
//
// Lazy + memoized, matching the pattern in src/lib/supabase-server.ts: one
// connection per server process, not per request.

export const MCP_URL =
  process.env.POSTGRES_MCP_URL ?? "http://localhost:8000/sse";

/**
 * Tools forwarded to the model. Deliberately an allowlist, not a pass-through
 * of everything postgres-mcp offers.
 *
 * Excluded on purpose: analyze_db_health, get_top_queries,
 * analyze_workload_indexes, analyze_query_indexes, explain_query. They are DBA
 * operations with no place in a pilot chat box, and a smaller tool surface
 * measurably improves tool-selection accuracy.
 */
export const ALLOWED_MCP_TOOLS = [
  "execute_sql",
  "list_objects",
  "get_object_details",
] as const;

/** Caps on what a single tool result may feed back into the context window. */
export const TOOL_RESULT_LIMITS = {
  maxRows: 100,
  maxChars: 8_000,
} as const;

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

let clientPromise: Promise<Client> | undefined;

async function connect(): Promise<Client> {
  const client = new Client(
    { name: "gatf-dashboard", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(new SSEClientTransport(new URL(MCP_URL)));
  return client;
}

export function getMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      // Don't cache a failed connection — otherwise a sidecar that was briefly
      // down stays "broken" for the life of the process.
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

/** MCP tool definitions, filtered to ALLOWED_MCP_TOOLS. */
export async function listAllowedTools(): Promise<McpToolDefinition[]> {
  const client = await getMcpClient();
  const { tools } = await client.listTools();
  return (tools as McpToolDefinition[]).filter((t) =>
    (ALLOWED_MCP_TOOLS as readonly string[]).includes(t.name),
  );
}

export type ToolCallOutcome = {
  /** Text handed back to the model — already truncated. */
  text: string;
  isError: boolean;
  /** True when truncation dropped content. Surfaced in the response schema. */
  truncated: boolean;
  rowCount: number | null;
  durationMs: number;
};

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block) {
        return String((block as { text: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Best-effort row count. postgres-mcp returns result rows as JSON text, so this
 * is informational for the UI — never used for correctness.
 */
function countRows(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

/**
 * Truncation matters more than it looks. An unbounded SELECT would otherwise
 * push thousands of rows into the context window — and then re-send them on
 * every subsequent turn of the loop, multiplying cost and eventually blowing
 * the window outright.
 */
function truncate(text: string): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;

  const trimmed = out.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > TOOL_RESULT_LIMITS.maxRows) {
        const kept = parsed.slice(0, TOOL_RESULT_LIMITS.maxRows);
        out =
          JSON.stringify(kept) +
          `\n\n[truncated: ${parsed.length} rows returned, first ${TOOL_RESULT_LIMITS.maxRows} shown. ` +
          `Re-run with an aggregate (COUNT/SUM/GROUP BY) or a tighter WHERE clause rather than asking for more rows.]`;
        truncated = true;
      }
    } catch {
      // Not JSON after all; fall through to the character cap.
    }
  }

  if (out.length > TOOL_RESULT_LIMITS.maxChars) {
    out =
      out.slice(0, TOOL_RESULT_LIMITS.maxChars) +
      `\n\n[truncated at ${TOOL_RESULT_LIMITS.maxChars} characters]`;
    truncated = true;
  }

  return { text: out, truncated };
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  // Re-check the allowlist here rather than trusting that only allowed tools
  // were advertised — the model supplies this name, so it is untrusted input.
  if (!(ALLOWED_MCP_TOOLS as readonly string[]).includes(name)) {
    return {
      text: `Tool "${name}" is not available.`,
      isError: true,
      truncated: false,
      rowCount: null,
      durationMs: 0,
    };
  }

  const started = Date.now();
  try {
    const client = await getMcpClient();
    const result = await client.callTool({ name, arguments: args });
    const raw = flattenContent(result.content);
    const { text, truncated } = truncate(raw);
    return {
      text,
      isError: result.isError === true,
      truncated,
      rowCount: countRows(raw),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // Errors go back to the model as tool results, not thrown — a permission
    // denied or syntax error is information it can act on.
    return {
      text: `Tool call failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      truncated: false,
      rowCount: null,
      durationMs: Date.now() - started,
    };
  }
}
