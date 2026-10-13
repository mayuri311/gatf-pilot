"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_PROPS, GRID_PROPS, TooltipBox } from "./kit";

export type LinePoint = { x: string | number; label: string; y: number | null; y2?: number | null };

/** Thin 2px line with dots (Fortress style); optional dashed comparison series. */
export function SimpleLine({
  data,
  height = 220,
  color = "var(--chart-1)",
  color2 = "var(--chart-2)",
  name = "Value",
  name2,
  valueFormat = (v: number) => String(v),
  tickFormat,
  zeroLine,
  yDomain,
}: {
  data: LinePoint[];
  height?: number;
  color?: string;
  color2?: string;
  name?: string;
  name2?: string;
  valueFormat?: (v: number) => string;
  /** Compact axis labels (defaults to valueFormat). */
  tickFormat?: (v: number) => string;
  zeroLine?: boolean;
  yDomain?: [number | string, number | string];
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: -8 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="label" minTickGap={16} {...AXIS_PROPS} />
          <YAxis width={44} tickFormatter={(v) => (tickFormat ?? valueFormat)(Number(v))} domain={yDomain} {...AXIS_PROPS} />
          {zeroLine && <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.5} />}
          {name2 && (
            <Line
              dataKey="y2"
              type="monotone"
              stroke={color2}
              strokeWidth={1.75}
              strokeDasharray="5 4"
              dot={{ r: 2.5, fill: color2, strokeWidth: 0 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
          <Line
            dataKey="y"
            type="monotone"
            stroke={color}
            strokeWidth={2}
            dot={{ r: 3, fill: color, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Tooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4, strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as LinePoint;
              const rows = [{ label: name, value: p.y == null ? "no data" : valueFormat(p.y), color }];
              if (name2) rows.push({ label: name2, value: p.y2 == null ? "no data" : valueFormat(p.y2), color: color2 });
              return <TooltipBox title={p.label} rows={rows} />;
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
