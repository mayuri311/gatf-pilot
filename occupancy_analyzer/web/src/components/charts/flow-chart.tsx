"use client";

import { useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FlowPoint } from "@/lib/rpc";
import { fmt } from "@/lib/format";
import { AXIS_PROPS, GRID_PROPS, TooltipBox } from "./kit";

/** Diverging bars: arrivals above the axis (IN, teal), departures below (OUT, purple). */
export function FlowChart({ points, height = 280, multiDay }: { points: FlowPoint[]; height?: number; multiDay?: boolean }) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        t: Date.parse(p.ts),
        arrivals: p.arrivals,
        departures: -p.departures,
        net: p.net,
        bounces: p.bounces,
      })),
    [points],
  );
  const fmtTick = (v: number) => fmt(v, multiDay ? "MMM d" : "HH:mm");
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -8 }} barCategoryGap={2} stackOffset="sign">
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="t" type="category" tickFormatter={fmtTick} minTickGap={32} {...AXIS_PROPS} />
          <YAxis allowDecimals={false} width={44} tickFormatter={(v) => String(Math.abs(v))} {...AXIS_PROPS} />
          <ReferenceLine y={0} stroke="var(--border)" />
          <Bar dataKey="arrivals" stackId="f" fill="var(--dir-in)" radius={[3, 3, 0, 0]} isAnimationActive={false} name="Arrivals" />
          <Bar dataKey="departures" stackId="f" fill="var(--dir-out)" radius={[3, 3, 0, 0]} isAnimationActive={false} name="Departures" />
          <Line dataKey="net" type="monotone" stroke="var(--foreground)" strokeOpacity={0.55} strokeWidth={1.25} dot={false} isAnimationActive={false} name="Net" />
          <Tooltip
            cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as (typeof data)[number];
              return (
                <TooltipBox
                  title={fmt(Number(label), multiDay ? "EEE MMM d, HH:mm 'ET'" : "HH:mm 'ET'")}
                  rows={[
                    { label: "▶ Arrivals", value: r.arrivals, color: "var(--dir-in)" },
                    { label: "◀ Departures", value: -r.departures, color: "var(--dir-out)" },
                    { label: "Net", value: r.net > 0 ? `+${r.net}` : r.net },
                    { label: "Bounces", value: r.bounces },
                  ]}
                />
              );
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Cumulative arrivals vs departures; the vertical gap is occupancy, any overnight residual is drift. */
export function CumulativeChart({ points, height = 260, multiDay }: { points: FlowPoint[]; height?: number; multiDay?: boolean }) {
  const data = useMemo(() => {
    const out: { t: number; arrivals: number; departures: number }[] = [];
    for (const p of points) {
      const prev = out[out.length - 1];
      out.push({ t: Date.parse(p.ts), arrivals: (prev?.arrivals ?? 0) + p.arrivals, departures: (prev?.departures ?? 0) + p.departures });
    }
    return out;
  }, [points]);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => fmt(v, multiDay ? "MMM d" : "HH:mm")} minTickGap={36} {...AXIS_PROPS} />
          <YAxis allowDecimals={false} width={48} {...AXIS_PROPS} />
          <Line dataKey="arrivals" type="stepAfter" stroke="var(--dir-in)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="departures" type="stepAfter" stroke="var(--dir-out)" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as (typeof data)[number];
              return (
                <TooltipBox
                  title={fmt(Number(label), "EEE MMM d, HH:mm 'ET'")}
                  rows={[
                    { label: "Cum. arrivals", value: r.arrivals, color: "var(--dir-in)" },
                    { label: "Cum. departures", value: r.departures, color: "var(--dir-out)", dashed: true },
                    { label: "Gap (≈ occupancy)", value: r.arrivals - r.departures },
                  ]}
                />
              );
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
