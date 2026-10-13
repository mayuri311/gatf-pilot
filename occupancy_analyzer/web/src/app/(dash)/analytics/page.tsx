import type { Metadata } from "next";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc, type RpcResult } from "@/lib/rpc";
import { resolveRange, localDayKey } from "@/lib/range";
import { appConfig } from "@/lib/config";
import { PageHeader } from "@/components/common/page-header";
import { RangeControls, UrlTabs } from "@/components/common/range-controls";
import {
  CompareSection,
  DwellSection,
  FlowSection,
  KpiStrip,
  OccupancySection,
  PatternsSection,
} from "@/components/analytics/sections";

export const metadata: Metadata = { title: "Analytics" };

const TABS = [
  { id: "occupancy", label: "Occupancy" },
  { id: "flow", label: "Flow" },
  { id: "dwell", label: "Dwell" },
  { id: "patterns", label: "Patterns" },
  { id: "compare", label: "Compare" },
];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
function r<T>(res: RpcResult<T>, fallback: T) {
  return res.ok ? { data: res.data, error: null } : { data: fallback, error: res.error };
}

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const sp = await searchParams;
  const tab = TABS.some((t) => t.id === one(sp.tab)) ? one(sp.tab)! : "occupancy";
  const range = resolveRange(one(sp.preset), one(sp.from), one(sp.to));
  const q = { from: range.fromIso, to: range.toIso };
  const supabase = await getServerSupabase();
  const multiDay = range.days > 2;
  const fromDay = localDayKey(range.from);
  const toDay = localDayKey(new Date(range.to.getTime() - 1));

  const [kpis, daily] = await Promise.all([rpc.kpis(supabase, q), rpc.dailyStats(supabase, q)]);
  const dailyR = r(daily, []);

  let body: React.ReactNode = null;
  if (tab === "occupancy") {
    const [series, cal] = await Promise.all([rpc.occupancySeries(supabase, q, range.bucketMinutes), rpc.calibrationHistory(supabase)]);
    body = (
      <OccupancySection
        series={r(series, [])}
        daily={dailyR}
        calibrations={cal.ok ? cal.data.filter((c) => c.at >= range.fromIso && c.at <= range.toIso) : []}
        capacity={appConfig.lot.capacity}
        effectivePct={appConfig.lot.effective_pct}
        multiDay={multiDay}
        fromDay={fromDay}
        toDay={toDay}
      />
    );
  } else if (tab === "flow") {
    const bucket = range.days <= 2 ? 15 : range.days <= 14 ? 60 : 1440;
    const flow = await rpc.flowSeries(supabase, q, bucket);
    body = <FlowSection flow={r(flow, [])} kpis={kpis.ok ? kpis.data : null} multiDay={multiDay} bucket={bucket} />;
  } else if (tab === "dwell") {
    const dist = await rpc.dwellDistribution(supabase, q);
    body = <DwellSection dist={r(dist, null)} daily={dailyR} />;
  } else if (tab === "patterns") {
    const metric = one(sp.metric) === "arrivals" ? "arrivals" : "occupancy";
    const heat = await rpc.heatmap(supabase, q, metric);
    const base = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "metric") base.set(k, v);
    const href = (m: string) => {
      const u = new URLSearchParams(base);
      u.set("metric", m);
      return `/analytics?${u.toString()}`;
    };
    body = <PatternsSection heat={r(heat, [])} metric={metric} hrefs={{ occupancy: href("occupancy"), arrivals: href("arrivals") }} />;
  } else {
    const span = range.to.getTime() - range.from.getTime();
    const prevQ = { from: new Date(range.from.getTime() - span).toISOString(), to: range.fromIso };
    const prevDaily = await rpc.dailyStats(supabase, prevQ);
    body = (
      <CompareSection
        kpis={r(kpis, null)}
        label={range.label}
        prevLabel={`${localDayKey(new Date(prevQ.from))} → ${localDayKey(new Date(range.from.getTime() - 1))}`}
        daily={dailyR.data}
        prevDaily={prevDaily.ok ? prevDaily.data : []}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Occupancy, flow, dwell and weekly patterns — all times America/New_York"
        actions={<RangeControls label={range.label} active={range.preset} />}
      />
      <KpiStrip kpis={r(kpis, null)} daily={dailyR.data} />
      <div className="mt-6 mb-5">
        <UrlTabs tabs={TABS} value={tab} />
      </div>
      {body}
    </>
  );
}
