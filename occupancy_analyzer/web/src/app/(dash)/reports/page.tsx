import type { Metadata } from "next";
import { TZDate } from "@date-fns/tz";
import { addDays, addMonths, format, startOfMonth, startOfWeek, subDays } from "date-fns";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { appConfig, TZ } from "@/lib/config";
import { delta, fmtDwell, fmtInt, fmtNum, fmtPct, fmt, inLot } from "@/lib/format";
import { localDayKey } from "@/lib/range";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/page-header";
import { Panel, PanelBody, PanelHeader } from "@/components/common/panel";
import { ErrorState } from "@/components/common/states";
import { ReportControls } from "@/components/ops/report-controls";

export const metadata: Metadata = { title: "Reports" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function periodRange(period: string, dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const anchor = new TZDate(y, m - 1, d, TZ);
  if (period === "day") return { from: anchor, to: addDays(anchor, 1, { in: inLot }), label: format(anchor, "EEEE, MMMM d, yyyy", { in: inLot }) };
  if (period === "month") {
    const from = startOfMonth(anchor, { in: inLot });
    return { from, to: addMonths(from, 1, { in: inLot }), label: format(from, "MMMM yyyy", { in: inLot }) };
  }
  const from = startOfWeek(anchor, { weekStartsOn: 1, in: inLot });
  const to = addDays(from, 7, { in: inLot });
  return { from, to, label: `Week of ${format(from, "MMM d", { in: inLot })} – ${format(subDays(to, 1, { in: inLot }), "MMM d, yyyy", { in: inLot })}` };
}

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const sp = await searchParams;
  const period = ["day", "week", "month"].includes(one(sp.period) ?? "") ? one(sp.period)! : "week";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.date) ?? "") ? one(sp.date)! : localDayKey(subDays(new Date(), period === "day" ? 1 : 0));
  const range = periodRange(period, date);
  const now = new Date();
  const to = range.to > now ? now : range.to;
  const q = { from: range.from.toISOString(), to: to.toISOString() };
  const supabase = await getServerSupabase();
  const [kpis, daily, cal] = await Promise.all([rpc.kpis(supabase, q), rpc.dailyStats(supabase, q), rpc.calibrationHistory(supabase)]);
  const k = kpis.ok ? kpis.data : null;
  const residuals = cal.ok ? cal.data.filter((c) => c.at >= q.from && c.at <= q.to) : [];
  const csv = `/api/export/daily?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`;

  const tiles: { label: string; v: string; d?: number | null; invert?: boolean; hint?: string }[] = [
    { label: "Peak occupancy", v: k ? `${fmtInt(k.peak_occ)} · ${fmtPct(k.peak_pct)}` : "—", d: delta(k?.peak_occ, k?.prev?.peak_occ), hint: k?.peak_at ? fmt(k.peak_at, "EEE MMM d, HH:mm 'ET'") : undefined },
    { label: "Hours ≥ 85%", v: fmtNum(k?.hours_effectively_full, 1), d: delta(k?.hours_effectively_full, k?.prev?.hours_effectively_full), invert: true },
    { label: "Turnover / day", v: fmtNum(k?.turnover, 2), d: delta(k?.turnover, k?.prev?.turnover) },
    { label: "Avg length of stay", v: fmtDwell(k?.avg_dwell_min), d: delta(k?.avg_dwell_min, k?.prev?.avg_dwell_min), hint: `median ${fmtDwell(k?.median_dwell_min)}` },
    { label: "Unique vehicles", v: fmtInt(k?.unique_vehicles), d: delta(k?.unique_vehicles, k?.prev?.unique_vehicles) },
    { label: "Entries / exits", v: `${fmtInt(k?.entries)} / ${fmtInt(k?.exits)}`, d: delta(k?.entries, k?.prev?.entries) },
    { label: "Bounces", v: `${fmtInt(k?.bounces)} · ${fmtPct(k?.bounce_rate, 1)}`, d: delta(k?.bounces, k?.prev?.bounces), invert: true },
    { label: "Overnight", v: fmtInt(k?.overnight), d: delta(k?.overnight, k?.prev?.overnight), invert: true },
    { label: "Utilization", v: fmtPct(k?.utilization, 1), d: delta(k?.utilization, k?.prev?.utilization) },
    { label: "Exit match rate", v: fmtPct(k?.match_rate, 1), d: delta(k?.match_rate, k?.prev?.match_rate) },
    {
      label: "Reconciliation residual",
      v: residuals.length ? residuals.map((r) => (r.residual != null && r.residual > 0 ? `+${r.residual}` : String(r.residual ?? "—"))).join(", ") : "none",
      hint: `${residuals.length} reconciliation${residuals.length === 1 ? "" : "s"}`,
    },
  ];

  return (
    <>
      <PageHeader title="Reports" subtitle="On-demand “Parking Pulse” — print to PDF or download CSV" actions={<ReportControls period={period} date={date} csvHref={csv} />} />
      <Panel className="print:border-0">
        <PanelHeader
          title={`Parking Pulse — ${range.label}`}
          subtitle={`${appConfig.lot.name} · capacity ${appConfig.lot.capacity} · generated ${fmt(now, "MMM d yyyy, HH:mm")} ET · compared with the previous ${period}`}
        />
        <PanelBody>
          {!kpis.ok ? (
            <ErrorState error={kpis.error} />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {tiles.map((t) => {
                const good = t.d == null ? null : t.invert ? t.d < 0 : t.d > 0;
                return (
                  <div key={t.label} className="rounded-lg border bg-muted/15 p-4">
                    <p className="text-[12px] text-muted-foreground">{t.label}</p>
                    <p className="num mt-1 text-xl font-semibold">{t.v}</p>
                    <p className="num mt-1 text-[11.5px] text-muted-foreground">
                      {t.d != null && (
                        <span className={cn("mr-1.5 font-semibold", good ? "text-success" : "text-destructive")}>
                          {t.d >= 0 ? "▲ +" : "▼ "}
                          {(t.d * 100).toFixed(1)}%
                        </span>
                      )}
                      {t.hint}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
          {daily.ok && daily.data.length > 0 && (
            <div className="scrollbar-thin mt-6 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <caption className="mb-2 text-left text-[13px] font-semibold">Daily breakdown</caption>
                <thead>
                  <tr className="border-b text-left text-[11.5px] text-muted-foreground uppercase">
                    {["Day", "Peak", "Peak %", "Hours ≥85%", "Entries", "Exits", "Bounces", "Overnight", "Unique", "Avg dwell", "P90 dwell"].map((h) => (
                      <th key={h} scope="col" className="py-2 pr-3 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {daily.data.map((d) => (
                    <tr key={d.day} className="num border-b border-border/60 last:border-0">
                      <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(d.day + "T12:00:00", "EEE MMM d")}</td>
                      <td className="pr-3">{fmtInt(d.peak_occ)}</td>
                      <td className="pr-3">{fmtPct(d.peak_pct, 1)}</td>
                      <td className="pr-3">{fmtNum(d.hours_effectively_full, 1)}</td>
                      <td className="pr-3">{fmtInt(d.entries)}</td>
                      <td className="pr-3">{fmtInt(d.exits)}</td>
                      <td className="pr-3">{fmtInt(d.bounces)}</td>
                      <td className="pr-3">{fmtInt(d.overnight)}</td>
                      <td className="pr-3">{fmtInt(d.unique_vehicles)}</td>
                      <td className="pr-3">{fmtDwell(d.avg_dwell_min)}</td>
                      <td className="pr-3">{fmtDwell(d.p90_dwell_min)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-5 text-[11.5px] text-muted-foreground">
            Definitions: dwell uses closed sessions only; overnight = present at 03:00 ET; occupancy is the flow estimate re-anchored at each admin reconciliation
            (residual = estimate − visual count). Days without data are omitted, never shown as zero.
          </p>
        </PanelBody>
      </Panel>
    </>
  );
}
