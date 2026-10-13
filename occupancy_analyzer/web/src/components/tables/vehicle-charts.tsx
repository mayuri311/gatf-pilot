"use client";

import type { SessionRow } from "@/lib/rpc";
import { fmt, fmtDwell } from "@/lib/format";
import { ChartCard } from "@/components/charts/kit";
import { SimpleLine } from "@/components/charts/line-simple";
import { SimpleBars } from "@/components/charts/bars";
import { EmptyState } from "@/components/common/states";

export function VehicleCharts({ sessions, usualHour }: { sessions: SessionRow[]; usualHour: number | null }) {
  const closed = sessions.filter((s) => s.dwell_min != null && s.exit_at).sort((a, b) => Date.parse(a.entry_at ?? "") - Date.parse(b.entry_at ?? ""));
  const dwell = closed.map((s) => ({ x: s.session_id, label: fmt(s.entry_at, "MMM d"), y: s.dwell_min }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: String(h).padStart(2, "0"), value: 0, color: h === usualHour ? "var(--chart-4)" : "var(--chart-1)" }));
  for (const s of sessions) {
    if (!s.entry_at) continue;
    const h = Number(fmt(s.entry_at, "H"));
    if (hours[h]) hours[h].value += 1;
  }
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <ChartCard title="Is the stay getting longer?" subtitle="Dwell per visit (closed sessions)" legend={[{ label: "Dwell", color: "var(--chart-1)" }]}>
        {dwell.length < 2 ? (
          <EmptyState title="Not enough closed visits" compact className="mx-2" />
        ) : (
          <SimpleLine data={dwell} valueFormat={(v) => fmtDwell(v)} tickFormat={(v) => (v >= 120 ? `${Math.round(v / 60)} h` : `${Math.round(v)} m`)} name="Dwell" height={220} />
        )}
      </ChartCard>
      <ChartCard title="When does this vehicle arrive?" subtitle={`Entries by local hour (ET)${usualHour != null ? ` · usual ${String(usualHour).padStart(2, "0")}:00 highlighted` : ""}`}>
        {sessions.length === 0 ? <EmptyState title="No visits" compact className="mx-2" /> : <SimpleBars data={hours} height={220} />}
      </ChartCard>
    </div>
  );
}
