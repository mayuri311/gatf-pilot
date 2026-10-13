"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_PROPS, GRID_PROPS, TooltipBox } from "./kit";

export type BarDatum = { key: string; label: string; value: number | null; color?: string; tooltip?: { label: string; value: React.ReactNode }[] };

/** Simple vertical bar chart (thin bars, 4px rounded data-ends, single axis). */
export function SimpleBars({
  data,
  height = 240,
  color = "var(--chart-1)",
  valueFormat = (v: number) => String(v),
  refLines,
  showLabels,
  yDomain,
}: {
  data: BarDatum[];
  height?: number;
  color?: string;
  valueFormat?: (v: number) => string;
  refLines?: { y: number; label: string; color: string }[];
  showLabels?: boolean;
  yDomain?: [number, number];
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
        <BarChart data={data} margin={{ top: showLabels ? 20 : 8, right: 12, bottom: 0, left: -8 }} barCategoryGap="22%">
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="label" minTickGap={8} {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis width={44} allowDecimals={false} tickFormatter={(v) => valueFormat(Number(v))} domain={yDomain} {...AXIS_PROPS} />
          {refLines?.map((r) => (
            <ReferenceLine
              key={r.label}
              y={r.y}
              stroke={r.color}
              strokeDasharray="4 4"
              label={{ value: r.label, position: "insideTopRight", fill: r.color, fontSize: 10.5 }}
            />
          ))}
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.key} fill={d.color ?? color} />
            ))}
            {showLabels && (
              <LabelList
                dataKey="value"
                position="top"
                className="num"
                style={{ fontSize: 10.5, fill: "var(--muted-foreground)" }}
                formatter={(v: unknown) => (typeof v === "number" ? valueFormat(v) : "")}
              />
            )}
          </Bar>
          <Tooltip
            cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as BarDatum;
              return (
                <TooltipBox
                  title={d.label}
                  rows={d.tooltip ?? [{ label: "Value", value: d.value == null ? "no data" : valueFormat(d.value), color: d.color ?? color }]}
                />
              );
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
