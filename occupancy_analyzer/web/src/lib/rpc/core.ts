import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

export type RpcErrorKind = "missing" | "forbidden" | "auth" | "network" | "timeout" | "invalid" | "error";
export type RpcError = { kind: RpcErrorKind; code: string; message: string; fn: string };
export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: RpcError };

function classify(fn: string, err: { code?: string; message?: string; status?: number }): RpcError {
  const code = String(err.code ?? err.status ?? "");
  const message = err.message ?? "Unknown error";
  let kind: RpcErrorKind = "error";
  if (code === "PGRST202" || code === "42883" || /could not find the function/i.test(message)) kind = "missing";
  else if (code === "42501" || /permission denied|forbidden|admin/i.test(message)) kind = "forbidden";
  else if (code === "PGRST301" || code === "PGRST303" || code === "401" || /jwt/i.test(message)) kind = "auth";
  else if (/abort|timed? ?out/i.test(message) || code === "57014") kind = "timeout";
  else if (/fetch failed|network|ECONNREFUSED|Failed to fetch/i.test(message)) kind = "network";
  return { kind, code, message, fn };
}

/**
 * Single choke point for every RPC call: never throws, always returns a typed
 * result validated by a tolerant zod schema.
 */
export async function callRpc<S extends z.ZodTypeAny>(
  sb: SupabaseClient,
  fn: string,
  params: Record<string, unknown> | undefined,
  schema: S,
  opts: { timeoutMs?: number } = {},
): Promise<RpcResult<z.infer<S>>> {
  try {
    let q = sb.rpc(fn, params ?? {});
    if (opts.timeoutMs) q = q.abortSignal(AbortSignal.timeout(opts.timeoutMs));
    const { data, error } = await q;
    if (error) return { ok: false, error: classify(fn, error) };
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: "invalid",
          code: "ZOD",
          fn,
          message: `Unexpected response shape from ${fn}: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")} ${i.message}`)
            .join("; ")}`,
        },
      };
    }
    return { ok: true, data: parsed.data };
  } catch (e) {
    return { ok: false, error: classify(fn, { message: e instanceof Error ? e.message : String(e) }) };
  }
}

export function errorText(e: RpcError): string {
  switch (e.kind) {
    case "missing":
      return `The database function ${e.fn}() is not deployed yet.`;
    case "forbidden":
      return "You don't have permission to view this.";
    case "auth":
      return "Your session expired. Sign in again.";
    case "network":
      return "Can't reach the database right now.";
    case "timeout":
      return `The database took too long to answer (${e.fn}). Try again in a moment.`;
    case "invalid":
      return e.message;
    default:
      return e.message;
  }
}

export function dataOr<T>(r: RpcResult<T>, fallback: T): T {
  return r.ok ? r.data : fallback;
}
