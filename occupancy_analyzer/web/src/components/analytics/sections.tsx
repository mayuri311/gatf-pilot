"use client";

import { Clock3, Gauge, LogIn, Timer } from "lucide-react";
import type {
  Calibration,
  DailyStat,
  DwellDistribution,
  FlowPoint,
  HeatCell,
  Kpis,
  KpiKey,
  OccupancyPoint,
  RpcError,
} from "@/lib/rpc";
import { delta, fmt, fmtDwell, fmtInt, fmtNum, fmtPct, fmtShortDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { KpiCard } from "@/components/charts/kpi-card";
import { ChartCard, type Column } from "@/components/charts/kit";
import { OccupancyChart, occupancyLegend } from "@/components/charts/occupancy-chart";
import { CumulativeChart, FlowChart } from "@/components/charts/flow-chart";
import { SimpleBars } from "@/components/charts/bars";
import { WeekHeatmap } from "@/components/charts/heatmap";
import { CalendarHeatmap } from "@/components/charts/calendar-heatmap";
import { ErrorState, EmptyState } from "@/components/common/states";
import { Panel, PanelBody, PanelHeader } from "@/components/common/panel";

type R<T> = { data: T; error: RpcError | null };

function Guard<T>({ r, empty, children }: { r: R<T>; empty: (d: T) => boolean; children: React.ReactNode }) {
  if (r.error) return <ErrorState error={r.error} compact className="mx-2" />;
  if (empty(r.data)) return <EmptyState title="No data in this range" compact className="mx-2">Coverage gaps are shown as gaps, never as zero.</EmptyState>;
  return <>{children}</>;
}

export function KpiStrip({ kpis, daily }: { kpis: R<Kpis | null>; daily: DailyStat[] }) {
  const k = kpis.data;
  const spark = (key: keyof DailyStat) => daily.map((d) => (typeof d[key] === "number" ? (d[key] as number) : null));
  const d = (key: KpiKey) => delta(k?.[key] as number | null, k?.prev?.[key] as number | null);
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Peak occupancy"
        value={k?.peak_pct != null ? Math.round(k.peak_pct * 100) : null}
        suffix="%"
        icon={Gauge}
        tone="var(--chart-1)"
        delta={d("peak_pct")}
        deltaLabel="vs previous period"
        sub={k?.peak_at ? <>peak <span className="num">{k.peak_occ}</span> at {fmt(k.peak_at, "EEE HH:mm")}</> : undefined}
        spark={spark("peak_pct")}
        definition="max Occ(t) / C(t) in the period, with capacity from lot_capacity_history."
      />
      <KpiCard
        label="Entries"
        value={k?.entries}
        icon={LogIn}
        tone="var(--chart-2)"
        delta={d("entries")}
        deltaLabel="vs previous period"
        sub={k?.unique_vehicles != null ? <><span className="num">{fmtInt(k.unique_vehicles)}</span> unique vehicles</> : undefined}
        spark={spark("entries")}
        definition="Inbound passes after de-duplication."
      />
      <KpiCard
        label="Avg dwell"
        value={k?.avg_dwell_min}
        display={k?.avg_dwell_min != null ? fmtDwell(k.avg_dwell_min) : undefined}
        icon={Clock3}
        tone="var(--chart-3)"
        delta={d("avg_dwell_min")}
        deltaLabel="vs previous period"
        sub={k?.median_dwell_min != null ? <>median <span className="num">{fmtDwell(k.median_dwell_min)}</span></> : undefined}
        spark={spark("avg_dwell_min")}
        definition="Mean stay over closed sessions (closed, closed_inferred). Excludes admin-closed, expired and orphan exits."
      />
      <KpiCard
        label="Hours ≥ 85%"
        value={k?.hours_effectively_full}
        suffix=" h"
        icon={Timer}
        tone="var(--chart-4)"
        delta={d("hours_effectively_full")}
        deltaLabel="vs previous period"
        invert
        sub={k?.utilization != null ? <>utilization <span className="num">{fmtPct(k.utilization)}</span></> : undefined}
        spark={spark("hours_effectively_full")}
        definition="Σ Δt where Occ(t) ≥ 85% of capacity."
      />
    </div>
  );
}

const occColumns: Column<OccupancyPoint>[] = [
  { key: "ts", label: "Time (ET)", format: (v) => fmt(v as string, "yyyy-MM-dd HH:mm") },
  { key: "occ_avg", label: "Avg", format: (v) => fmtNum(v as number, 1) },
  { key: "occ_max", label: "Max" },
  { key: "occ_min", label: "Min" },
  { key: "band_low", label: "Band low" },
  { key: "band_high", label: "Band high" },
  { key: "capacity", label: "Capacity" },
];

const dailyColumns: Column<DailyStat>[] = [
  { key: "day", label: "Day" },
  { key: "peak_occ", label: "Peak" },
  { key: "peak_pct", label: "Peak %", format: (v) => fmtPct(v as number, 1) },
  { key: "entries", label: "Entries" },
  { key: "exits", label: "Exits" },
  { key: "bounces", label: "Bounces" },
  { key: "overnight", label: "Overnight" },
  { key: "avg_dwell_min", label: "Avg dwell", format: (v) => fmtDwell(v as number) },
  { key: "hours_effectively_full", label: "Hours ≥85%", format: (v) => fmtNum(v as number, 1) },
];

export function OccupancySection({
  series,
  daily,
  calibrations,
  capacity,
  effectivePct,
  multiDay,
  fromDay,
  toDay,
}: {
  series: R<OccupancyPoint[]>;
  daily: R<DailyStat[]>;
  calibrations: Calibration[];
  capacity: number;
  effectivePct: number;
  multiDay: boolean;
  fromDay: string;
  toDay: string;
}) {
  const peakBars = daily.data.map((d) => {
    const pct = d.peak_pct;
    const color = pct == null ? undefined : pct >= effectivePct ? "var(--state-full)" : pct >= 0.6 ? "var(--chart-3)" : "var(--chart-1)";
    return {
      key: d.day,
      label: fmtShortDay(d.day + "T12:00:00"),
      value: pct != null ? Math.round(pct * 100) : null,
      color,
      tooltip: [
        { label: "Peak", value: `${d.peak_occ ?? "—"} (${fmtPct(pct)})` },
        { label: "At", value: fmt(d.peak_at, "HH:mm") },
        { label: "Hours ≥85%", value: fmtNum(d.hours_effectively_full, 1) },
      ],
    };
  });
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <ChartCard
        className="xl:col-span-3"
        title="How did occupancy evolve?"
        subtitle={`Step line with uncertainty band · ◆ = reconciliation (visual count) · ET`}
        legend={occupancyLegend({ band: true })}
        rows={series.data}
        columns={occColumns}
        filename="occupancy.csv"
        definition="Occupancy = flow count S1 clamped to [0, C(t)]. Gaps mean no data (camera/heartbeat downtime), never zero."
      >
        <Guard r={series} empty={(d) => d.length === 0}>
          <OccupancyChart points={series.data} capacity={capacity} effectivePct={effectivePct} calibrations={calibrations} multiDay={multiDay} height={320} />
        </Guard>
      </ChartCard>
      <ChartCard
        className="xl:col-span-2"
        title="Are we meeting targets?"
        subtitle="Daily peak % · under 60% · ideal 60–85% · over 85%"
        legend={[
          { label: "Under 60%", color: "var(--chart-1)", kind: "bar" },
          { label: "Ideal 60–85%", color: "var(--chart-3)", kind: "bar" },
          { label: "Over 85%", color: "var(--state-full)", kind: "bar" },
        ]}
        rows={daily.data}
        columns={dailyColumns}
        filename="daily-peaks.csv"
      >
        <Guard r={daily} empty={(d) => d.length === 0}>
          <SimpleBars
            data={peakBars}
            valueFormat={(v) => `${v}%`}
            refLines={[{ y: Math.round(effectivePct * 100), label: "85%", color: "var(--state-full)" }]}
            yDomain={[0, 100]}
            height={260}
          />
        </Guard>
      </ChartCard>
      <ChartCard title="Long-term pattern" subtitle="Calendar of daily peak % · click a day to drill in" rows={daily.data} columns={dailyColumns} filename="calendar.csv">
        <Guard r={daily} empty={(d) => d.length === 0}>
          <div className="px-2 pt-2">
            <CalendarHeatmap days={daily.data} fromDay={fromDay} toDay={toDay} />
          </div>
        </Guard>
      </ChartCard>
    </div>
  );
}

const flowColumns: Column<FlowPoint>[] = [
  { key: "ts", label: "Time (ET)", format: (v) => fmt(v as string, "yyyy-MM-dd HH:mm") },
  { key: "arrivals", label: "Arrivals" },
  { key: "departures", label: "Departures" },
  { key: "net", label: "Net" },
  { key: "bounces", label: "Bounces" },
];

export function FlowSection({ flow, kpis, multiDay, bucket }: { flow: R<FlowPoint[]>; kpis: Kpis | null; multiDay: boolean; bucket: number }) {
  const totals = flow.data.reduce((a, p) => ({ arr: a.arr + p.arrivals, dep: a.dep + p.departures, b: a.b + p.bounces }), { arr: 0, dep: 0, b: 0 });
  // Peak hour factor on arrivals: V_hr / (4 × V_15max) — only meaningful for 15-min buckets.
  let phf: number | null = null;
  if (bucket === 15 && flow.data.length >= 4) {
    let best = { vhr: 0, v15: 0 };
    for (let i = 0; i + 3 < flow.data.length; i++) {
      const w = flow.data.slice(i, i + 4).map((p) => p.arrivals);
      const vhr = w.reduce((s, x) => s + x, 0);
      if (vhr > best.vhr) best = { vhr, v15: Math.max(...w) };
    }
    phf = best.v15 ? best.vhr / (4 * best.v15) : null;
  }
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <ChartCard
        className="xl:col-span-3"
        title="When do cars arrive and leave?"
        subtitle={`Arrivals ▶ above the axis, departures ◀ below · ${bucket >= 1440 ? "daily" : bucket >= 60 ? `${bucket / 60}-hour` : `${bucket}-min`} buckets · ET`}
        legend={[
          { label: "▶ Arrivals", color: "var(--dir-in)", kind: "bar" },
          { label: "◀ Departures", color: "var(--dir-out)", kind: "bar" },
          { label: "Net", color: "var(--foreground)" },
        ]}
        rows={flow.data}
        columns={flowColumns}
        filename="flow.csv"
      >
        <Guard r={flow} empty={(d) => d.length === 0}>
          <FlowChart points={flow.data} multiDay={multiDay} height={300} />
        </Guard>
      </ChartCard>
      <ChartCard
        className="xl:col-span-2"
        title="Does the count drift?"
        subtitle="Cumulative arrivals vs departures — the gap is occupancy; a residual gap overnight is drift"
        legend={[
          { label: "Cumulative arrivals", color: "var(--dir-in)" },
          { label: "Cumulative departures", color: "var(--dir-out)", dashed: true },
        ]}
      >
        <Guard r={flow} empty={(d) => d.length === 0}>
          <CumulativeChart points={flow.data} multiDay={multiDay} />
        </Guard>
      </ChartCard>
      <Panel>
        <PanelHeader title="Flow summary" subtitle="Selected range" />
        <PanelBody>
          <dl className="grid grid-cols-2 gap-4">
            {[
              ["Arrivals", fmtInt(totals.arr)],
              ["Departures", fmtInt(totals.dep)],
              ["Flow balance", totals.arr ? fmtPct(totals.dep / totals.arr) : "—"],
              ["Bounces", `${fmtInt(totals.b)}${kpis?.bounce_rate != null ? ` · ${fmtPct(kpis.bounce_rate, 1)}` : ""}`],
              ["Turnover / day", fmtNum(kpis?.turnover, 2)],
              ["Peak hour factor", phf != null ? phf.toFixed(2) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border bg-muted/20 p-3">
                <dt className="text-[12px] text-muted-foreground">{k}</dt>
                <dd className="num mt-1 text-lg font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          {bucket !== 15 && <p className="mt-3 text-[11.5px] text-muted-foreground">Peak hour factor needs 15-min buckets — pick Today or Yesterday.</p>}
        </PanelBody>
      </Panel>
    </div>
  );
}

export function DwellSection({ dist, daily }: { dist: R<DwellDistribution | null>; daily: R<DailyStat[]> }) {
  const d = dist.data;
  const total = d?.buckets.reduce((s, b) => s + b.count, 0) ?? 0;
  const bars = (d?.buckets ?? []).map((b, i) => ({
    key: b.label + i,
    label: b.label,
    value: b.count,
    tooltip: [
      { label: "Sessions", value: fmtInt(b.count) },
      { label: "Share", value: total ? fmtPct(b.count / total, 1) : "—" },
    ],
  }));
  const overnight = daily.data.map((x) => ({
    key: x.day,
    label: fmtShortDay(x.day + "T12:00:00"),
    value: x.overnight,
    color: "var(--chart-5)",
  }));
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <ChartCard
        className="xl:col-span-2"
        title="How long do people stay?"
        subtitle="Closed sessions by dwell bucket"
        rows={d?.buckets ?? []}
        columns={[
          { key: "label", label: "Bucket" },
          { key: "count", label: "Sessions" },
        ]}
        filename="dwell.csv"
        definition="Closed sessions only (closed, closed_inferred); bounces excluded unless stated."
      >
        {dist.error ? (
          <ErrorState error={dist.error} compact className="mx-2" />
        ) : !d || total === 0 ? (
          <EmptyState title="No closed sessions in this range" compact className="mx-2" />
        ) : (
          <SimpleBars data={bars} showLabels height={280} color="var(--chart-1)" />
        )}
      </ChartCard>
      <Panel>
        <PanelHeader title="Dwell statistics" subtitle="Closed sessions" />
        <PanelBody className="space-y-3">
          {[
            ["Median", fmtDwell(d?.median_min)],
            ["P90", fmtDwell(d?.p90_min)],
            ["Average", fmtDwell(d?.avg_min)],
            ["Sessions", fmtInt(d?.total)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between border-b border-border/60 pb-2 last:border-0">
              <span className="text-[13px] text-muted-foreground">{k}</span>
              <span className="num text-xl font-semibold">{v}</span>
            </div>
          ))}
        </PanelBody>
      </Panel>
      <ChartCard
        className="xl:col-span-3"
        title="Is the “no overnight” rule bent?"
        subtitle="Sessions present at 03:00 ET, per night"
        rows={daily.data}
        columns={dailyColumns}
        filename="overnight.csv"
      >
        <Guard r={daily} empty={(x) => x.length === 0}>
          <SimpleBars data={overnight} height={220} showLabels />
        </Guard>
      </ChartCard>
    </div>
  );
}

export function PatternsSection({ heat, metric, hrefs }: { heat: R<HeatCell[]>; metric: "occupancy" | "arrivals"; hrefs: Record<"occupancy" | "arrivals", string> }) {
  return (
    <ChartCard
      title="What does a typical week look like?"
      subtitle={metric === "occupancy" ? "Average occupancy by local hour × weekday" : "Arrivals by local hour × weekday"}
      rows={heat.data}
      columns={[
        { key: "dow", label: "Weekday (0=Sun)" },
        { key: "hour", label: "Hour (ET)" },
        { key: "value", label: metric === "occupancy" ? "Avg occupancy" : "Arrivals" },
      ]}
      filename={`heatmap-${metric}.csv`}
      extra={
        <div role="group" aria-label="Metric" className="inline-flex h-7 items-center rounded-md border p-0.5 text-[12px]">
          {(["occupancy", "arrivals"] as const).map((m) => (
            <a
              key={m}
              href={hrefs[m]}
              aria-current={metric === m ? "true" : undefined}
              className={cn("rounded px-2 py-0.5 text-muted-foreground hover:text-foreground", metric === m && "bg-muted text-foreground")}
            >
              {m === "occupancy" ? "Avg occupancy" : "Arrivals"}
            </a>
          ))}
        </div>
      }
    >
      <Guard r={heat} empty={(d) => d.length === 0}>
        <div className="px-2 pt-2">
          <WeekHeatmap cells={heat.data} format={(v) => (metric === "occupancy" ? v.toFixed(0) : v.toFixed(0))} unit={metric === "occupancy" ? "cars" : "arrivals"} />
        </div>
      </Guard>
    </ChartCard>
  );
}

const COMPARE_ROWS: { key: KpiKey; label: string; fmt: (v: number | null) => string; invert?: boolean }[] = [
  { key: "entries", label: "Entries", fmt: (v) => fmtInt(v) },
  { key: "exits", label: "Exits", fmt: (v) => fmtInt(v) },
  { key: "unique_vehicles", label: "Unique vehicles", fmt: (v) => fmtInt(v) },
  { key: "peak_occ", label: "Peak occupancy", fmt: (v) => fmtInt(v) },
  { key: "peak_pct", label: "Peak %", fmt: (v) => fmtPct(v, 1) },
  { key: "utilization", label: "Utilization", fmt: (v) => fmtPct(v, 1) },
  { key: "hours_effectively_full", label: "Hours ≥ 85%", fmt: (v) => fmtNum(v, 1), invert: true },
  { key: "avg_dwell_min", label: "Avg dwell", fmt: (v) => fmtDwell(v) },
  { key: "median_dwell_min", label: "Median dwell", fmt: (v) => fmtDwell(v) },
  { key: "turnover", label: "Turnover / day", fmt: (v) => fmtNum(v, 2) },
  { key: "bounces", label: "Bounces", fmt: (v) => fmtInt(v), invert: true },
  { key: "bounce_rate", label: "Bounce rate", fmt: (v) => fmtPct(v, 1), invert: true },
  { key: "overnight", label: "Overnight", fmt: (v) => fmtInt(v), invert: true },
  { key: "match_rate", label: "Exit match rate", fmt: (v) => fmtPct(v, 1) },
];

export function CompareSection({ kpis, label, prevLabel, daily, prevDaily }: { kpis: R<Kpis | null>; label: string; prevLabel: string; daily: DailyStat[]; prevDaily: DailyStat[] }) {
  const k = kpis.data;
  const bars = daily.map((d, i) => ({
    key: d.day,
    label: `Day ${i + 1}`,
    value: d.entries,
    tooltip: [
      { label: fmtShortDay(d.day + "T12:00:00"), value: fmtInt(d.entries) },
      { label: prevDaily[i] ? fmtShortDay(prevDaily[i].day + "T12:00:00") : "previous", value: fmtInt(prevDaily[i]?.entries) },
    ],
  }));
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
      <Panel className="xl:col-span-3">
        <PanelHeader title="How does this period compare?" subtitle={`${label} vs the previous period of equal length (${prevLabel})`} />
        <PanelBody>
          {kpis.error ? (
            <ErrorState error={kpis.error} compact />
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-[12px] text-muted-foreground">
                  <th scope="col" className="py-2 font-medium">KPI</th>
                  <th scope="col" className="py-2 text-right font-medium">This period</th>
                  <th scope="col" className="py-2 text-right font-medium">Previous</th>
                  <th scope="col" className="py-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r) => {
                  const cur = (k?.[r.key] as number | null) ?? null;
                  const prev = (k?.prev?.[r.key] as number | null) ?? null;
                  const dd = delta(cur, prev);
                  const good = dd == null ? null : r.invert ? dd < 0 : dd > 0;
                  return (
                    <tr key={r.key} className="border-b border-border/60 last:border-0">
                      <td className="py-2">{r.label}</td>
                      <td className="num py-2 text-right font-semibold">{r.fmt(cur)}</td>
                      <td className="num py-2 text-right text-muted-foreground">{r.fmt(prev)}</td>
                      <td className={cn("num py-2 text-right", good == null ? "text-muted-foreground" : good ? "text-success" : "text-destructive")}>
                        {dd == null ? "—" : `${dd >= 0 ? "▲ +" : "▼ "}${(dd * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>
      <ChartCard className="xl:col-span-2" title="Entries, day by day" subtitle="Hover a bar to see the matching previous day">
        {bars.length ? <SimpleBars data={bars} height={300} /> : <EmptyState title="No daily data" compact />}
      </ChartCard>
    </div>
  );
}
