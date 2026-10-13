"use client";

import { useId, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Calibration, OccupancyPoint, TypicalSlot } from "@/lib/rpc";
import { addDays, startOfDay } from "date-fns";
import { fmt, fmtHM, inLot } from "@/lib/format";
import { AXIS_PROPS, AreaGradient, GRID_PROPS, TooltipBox } from "./kit";

type Row = {
  t: number;
  occ: number | null;
  max: number | null;
  band: [number, number] | null;
  fan: [number, number] | null;
  p50: number | null;
};

function slotToTs(dayStartMs: number, slot: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(slot);
  if (!m) return null;
  return dayStartMs + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

/**
 * Occupancy over time as a step line (stepAfter), with uncertainty band,
 * capacity and 85 % reference lines, optional typical-day fan (p10–p90 + median)
 * and reconciliation markers. Missing buckets are drawn as gaps, never zero.
 */
export function OccupancyChart({
  points,
  capacity,
  effectivePct = 0.85,
  typical,
  dayStartMs,
  dayEndMs,
  nowMs,
  calibrations,
  height = 300,
  showBand = true,
  multiDay = false,
}: {
  points: OccupancyPoint[];
  capacity: number;
  effectivePct?: number;
  typical?: TypicalSlot[];
  dayStartMs?: number;
  dayEndMs?: number;
  nowMs?: number;
  calibrations?: Calibration[];
  height?: number;
  showBand?: boolean;
  multiDay?: boolean;
}) {
  const gid = useId().replace(/:/g, "");
  const showFan = (typical ?? []).some((s) => (s.days ?? 99) >= 3 && s.p10 != null && s.p90 != null);

  const data = useMemo<Row[]>(() => {
    const map = new Map<number, Row>();
    const get = (t: number) => {
      let r = map.get(t);
      if (!r) {
        r = { t, occ: null, max: null, band: null, fan: null, p50: null };
        map.set(t, r);
      }
      return r;
    };
    for (const p of points) {
      const t = Date.parse(p.ts);
      if (Number.isNaN(t)) continue;
      const r = get(t);
      r.occ = p.occ_avg != null ? Math.round(p.occ_avg * 10) / 10 : null;
      r.max = p.occ_max;
      if (p.band_low != null && p.band_high != null) r.band = [p.band_low, p.band_high];
    }
    if (typical && dayStartMs != null) {
      for (const s of typical) {
        const t = slotToTs(dayStartMs, s.slot);
        if (t == null) continue;
        const r = get(t);
        r.p50 = s.p50;
        if (showFan && s.p10 != null && s.p90 != null) r.fan = [s.p10, s.p90];
      }
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [points, typical, dayStartMs, showFan]);

  const effective = Math.round(capacity * effectivePct);
  const yMax = Math.max(capacity, ...data.map((d) => Math.max(d.occ ?? 0, d.max ?? 0, d.fan?.[1] ?? 0)));
  const domain: [number | string, number | string] = [dayStartMs ?? "dataMin", dayEndMs ?? "dataMax"];
  const calMarks = (calibrations ?? [])
    .map((c) => ({ t: Date.parse(c.at), y: c.visual_count, residual: c.residual }))
    .filter((c) => !Number.isNaN(c.t) && c.y != null && (dayStartMs == null || c.t >= dayStartMs));

  const tickFmt = (v: number) => (multiDay ? fmt(v, "MMM d") : fmtHM(v));
  // Multi-day: one tick per local midnight (thinned to ≤ 10) so labels never repeat.
  const dayTicks = useMemo(() => {
    if (!multiDay || data.length < 2) return undefined;
    const ticks: number[] = [];
    let d = startOfDay(data[0].t, { in: inLot });
    if (d.getTime() < data[0].t) d = addDays(d, 1, { in: inLot });
    const end = data[data.length - 1].t;
    while (d.getTime() <= end && ticks.length < 400) {
      ticks.push(d.getTime());
      d = addDays(d, 1, { in: inLot });
    }
    const step = Math.ceil(ticks.length / 10);
    return ticks.filter((_, i) => i % step === 0);
  }, [multiDay, data]);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
        <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: -8 }}>
          <defs>
            <AreaGradient id={`occ-${gid}`} color="var(--chart-1)" opacity={0.24} />
          </defs>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={domain}
            tickFormatter={tickFmt}
            ticks={dayTicks}
            minTickGap={36}
            {...AXIS_PROPS}
          />
          <YAxis domain={[0, Math.ceil(yMax * 1.05)]} allowDecimals={false} width={44} {...AXIS_PROPS} />
          <ReferenceArea y1={effective} y2={capacity} fill="var(--state-full)" fillOpacity={0.05} ifOverflow="hidden" />
          {showFan && (
            <Area
              dataKey="fan"
              type="monotone"
              stroke="none"
              fill="var(--chart-1)"
              fillOpacity={0.1}
              isAnimationActive={false}
              connectNulls
              name="Typical p10–p90"
            />
          )}
          {typical && (
            <Line
              dataKey="p50"
              type="monotone"
              stroke="var(--chart-6)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
              connectNulls
              name="Typical median"
            />
          )}
          {showBand && (
            <Area
              dataKey="band"
              type="stepAfter"
              stroke="none"
              fill="var(--chart-4)"
              fillOpacity={0.09}
              isAnimationActive={false}
              name="Uncertainty band"
            />
          )}
          <Area
            dataKey="occ"
            type="stepAfter"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill={`url(#occ-${gid})`}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--chart-1)" }}
            isAnimationActive={false}
            connectNulls={false}
            name="Occupancy"
          />
          <ReferenceLine
            y={effective}
            stroke="var(--state-full)"
            strokeDasharray="4 4"
            strokeOpacity={0.8}
            label={{ value: `85% · ${effective}`, position: "insideTopRight", fill: "var(--state-full)", fontSize: 10.5 }}
          />
          <ReferenceLine
            y={capacity}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.6}
            label={{ value: `capacity ${capacity}`, position: "insideTopLeft", fill: "var(--muted-foreground)", fontSize: 10.5 }}
          />
          {nowMs != null && (
            <ReferenceLine
              x={nowMs}
              stroke="var(--foreground)"
              strokeOpacity={0.35}
              strokeDasharray="2 3"
              label={{ value: "now", position: "insideTopLeft", fill: "var(--muted-foreground)", fontSize: 10.5 }}
            />
          )}
          {calMarks.length > 0 && (
            <Scatter
              data={calMarks}
              dataKey="y"
              fill="var(--chart-5)"
              shape="diamond"
              isAnimationActive={false}
              name="Reconciliation"
            />
          )}
          <Tooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4, strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as Row;
              const rows: { label: string; value: React.ReactNode; color?: string; dashed?: boolean }[] = [];
              rows.push({ label: "Occupancy", value: r.occ ?? "no data", color: "var(--chart-1)" });
              if (r.band) rows.push({ label: "Band", value: `${r.band[0]}–${r.band[1]}`, color: "var(--chart-4)" });
              if (r.max != null && multiDay) rows.push({ label: "Peak", value: r.max });
              if (r.p50 != null) rows.push({ label: "Typical median", value: r.p50, color: "var(--chart-6)", dashed: true });
              if (r.fan) rows.push({ label: "Typical p10–p90", value: `${r.fan[0]}–${r.fan[1]}` });
              return <TooltipBox title={fmt(Number(label), multiDay ? "EEE MMM d, HH:mm 'ET'" : "HH:mm 'ET'")} rows={rows} />;
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function occupancyLegend(opts: { typical?: boolean; fan?: boolean; band?: boolean }) {
  const items = [{ label: "Occupancy", color: "var(--chart-1)" }] as {
    label: string;
    color: string;
    dashed?: boolean;
    kind?: "line" | "area";
  }[];
  if (opts.typical) items.push({ label: "Typical median", color: "var(--chart-6)", dashed: true });
  if (opts.fan) items.push({ label: "Typical p10–p90", color: "var(--chart-1)", kind: "area" });
  if (opts.band) items.push({ label: "Uncertainty band", color: "var(--chart-4)", kind: "area" });
  items.push({ label: "85% effective", color: "var(--state-full)", dashed: true });
  return items;
}
