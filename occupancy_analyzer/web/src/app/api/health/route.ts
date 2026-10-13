import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Public liveness probe. Reveals no data — only whether the app can reach Supabase. */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let supabase: "ok" | "unreachable" | "unconfigured" = "unconfigured";
  if (url && key) {
    try {
      const r = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key }, signal: AbortSignal.timeout(3000), cache: "no-store" });
      supabase = r.ok ? "ok" : "unreachable";
    } catch {
      supabase = "unreachable";
    }
  }
  const ok = supabase === "ok";
  return NextResponse.json(
    { ok, time: new Date().toISOString(), lot: appConfig.lot.lot_id, config_generated_at: appConfig.generated_at, supabase },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
