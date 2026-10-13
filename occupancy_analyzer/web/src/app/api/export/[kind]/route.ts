import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSessionUser } from "@/lib/auth";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { fmt } from "@/lib/format";
import { bucketFor } from "@/lib/range";

export const dynamic = "force-dynamic";

const MAX_ROWS = 20_000;
const PAGE = 500;

type Col<T> = [string, (r: T) => unknown];

function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const et = (v: string | null | undefined) => (v ? fmt(v, "yyyy-MM-dd HH:mm:ss") : "");

function csvStream<T>(cols: Col<T>[], pages: AsyncGenerator<T[]>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode("﻿" + cols.map((c) => esc(c[0])).join(",") + "\n"));
      try {
        for await (const rows of pages) {
          controller.enqueue(enc.encode(rows.map((r) => cols.map((c) => esc(c[1](r))).join(",")).join("\n") + (rows.length ? "\n" : "")));
        }
      } catch (e) {
        controller.enqueue(enc.encode(`# export failed: ${e instanceof Error ? e.message : String(e)}\n`));
      }
      controller.close();
    },
  });
}

async function* once<T>(p: Promise<T[]>) {
  yield await p;
}

/** CSV export of any filtered table (doc 06 F1). Times in ET plus UTC ISO. Audit-logged. */
export async function GET(req: Request, ctx: RouteContext<"/api/export/[kind]">) {
  const user = await getSessionUser();
  if (!user || !user.role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kind } = await ctx.params;
  const u = new URL(req.url);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "from and to (ISO timestamps) are required" }, { status: 400 });
  }
  const list = (k: string) => (u.searchParams.get(k) ?? "").split(",").filter(Boolean);
  const sb: SupabaseClient = await getServerSupabase();
  const range = { from, to };
  let stream: ReadableStream<Uint8Array>;

  switch (kind) {
    case "sessions": {
      const q = { ...range, status: list("status"), flags: list("flags"), plate: u.searchParams.get("plate") };
      const pages = async function* () {
        for (let off = 0; off < MAX_ROWS; off += PAGE) {
          const r = await rpc.listSessions(sb, { ...q, limit: PAGE, offset: off });
          if (!r.ok) throw new Error(r.error.message);
          yield r.data.rows;
          if (r.data.rows.length < PAGE) break;
        }
      };
      stream = csvStream(
        [
          ["session_id", (s) => s.session_id],
          ["plate", (s) => s.plate_norm],
          ["entry_et", (s) => et(s.entry_at)],
          ["exit_et", (s) => et(s.exit_at)],
          ["entry_utc", (s) => s.entry_at],
          ["exit_utc", (s) => s.exit_at],
          ["dwell_min", (s) => s.dwell_min],
          ["status", (s) => s.status],
          ["match_method", (s) => s.match_method],
          ["match_score", (s) => s.match_score],
          ["closed_reason", (s) => s.closed_reason],
          ["bounce", (s) => s.is_bounce],
          ["overnight", (s) => s.overnight],
          ["multi_day", (s) => s.multi_day],
          ["suspect_stale", (s) => s.suspect_stale],
        ],
        pages(),
      );
      break;
    }
    case "reads": {
      const q = { ...range, camera: u.searchParams.get("camera"), plate: u.searchParams.get("plate"), quality: u.searchParams.get("quality") };
      const pages = async function* () {
        for (let off = 0; off < MAX_ROWS; off += PAGE) {
          const r = await rpc.listReads(sb, { ...q, limit: PAGE, offset: off });
          if (!r.ok) throw new Error(r.error.message);
          yield r.data.rows;
          if (r.data.rows.length < PAGE) break;
        }
      };
      stream = csvStream(
        [
          ["read_id", (r) => r.read_id],
          ["time_et", (r) => et(r.event_at)],
          ["time_utc", (r) => r.event_at],
          ["camera_id", (r) => r.camera_id],
          ["direction", (r) => r.direction],
          ["plate", (r) => r.plate_norm],
          ["plate_raw", (r) => r.plate_raw],
          ["confidence", (r) => r.plate_confidence],
          ["quality", (r) => r.quality],
          ["pass_id", (r) => r.pass_id],
        ],
        pages(),
      );
      break;
    }
    case "daily": {
      const r = await rpc.dailyStats(sb, range);
      if (!r.ok) return NextResponse.json({ error: r.error.message }, { status: 502 });
      stream = csvStream(
        [
          ["day", (d) => d.day],
          ["peak_occ", (d) => d.peak_occ],
          ["peak_pct", (d) => d.peak_pct],
          ["peak_at_et", (d) => et(d.peak_at)],
          ["entries", (d) => d.entries],
          ["exits", (d) => d.exits],
          ["bounces", (d) => d.bounces],
          ["overnight", (d) => d.overnight],
          ["unique_vehicles", (d) => d.unique_vehicles],
          ["avg_dwell_min", (d) => d.avg_dwell_min],
          ["median_dwell_min", (d) => d.median_dwell_min],
          ["p90_dwell_min", (d) => d.p90_dwell_min],
          ["hours_effectively_full", (d) => d.hours_effectively_full],
        ],
        once(Promise.resolve(r.data)),
      );
      break;
    }
    case "occupancy": {
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      const r = await rpc.occupancySeries(sb, range, bucketFor(days));
      if (!r.ok) return NextResponse.json({ error: r.error.message }, { status: 502 });
      stream = csvStream(
        [
          ["time_et", (p) => et(p.ts)],
          ["time_utc", (p) => p.ts],
          ["occ_avg", (p) => p.occ_avg],
          ["occ_max", (p) => p.occ_max],
          ["occ_min", (p) => p.occ_min],
          ["band_low", (p) => p.band_low],
          ["band_high", (p) => p.band_high],
          ["capacity", (p) => p.capacity],
        ],
        once(Promise.resolve(r.data)),
      );
      break;
    }
    case "flow": {
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      const r = await rpc.flowSeries(sb, range, days <= 2 ? 15 : 60);
      if (!r.ok) return NextResponse.json({ error: r.error.message }, { status: 502 });
      stream = csvStream(
        [
          ["time_et", (p) => et(p.ts)],
          ["time_utc", (p) => p.ts],
          ["arrivals", (p) => p.arrivals],
          ["departures", (p) => p.departures],
          ["net", (p) => p.net],
          ["bounces", (p) => p.bounces],
        ],
        once(Promise.resolve(r.data)),
      );
      break;
    }
    default:
      return NextResponse.json({ error: `Unknown export "${kind}"` }, { status: 404 });
  }

  await rpc.logAudit(sb, "export", kind, { from, to, params: Object.fromEntries(u.searchParams) });
  const stamp = fmt(new Date(), "yyyyMMdd-HHmm");
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gatf-${kind}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
