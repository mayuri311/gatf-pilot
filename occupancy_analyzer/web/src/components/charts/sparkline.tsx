"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

/** Borderless sparkline that fills the bottom edge of a KPI card. */
export function Sparkline({ data, color, height = 56 }: { data: (number | null)[]; color: string; height?: number }) {
  const id = useId().replace(/:/g, "");
  const points = data.map((v, i) => ({ i, v }));
  if (points.filter((p) => p.v != null).length < 3) {
    return <div style={{ height }} aria-hidden className="border-t border-dashed border-border/60" />;
  }
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 240, height }}>
        <AreaChart data={points} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin - 1", "dataMax + 1"]} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.75}
            fill={`url(#spark-${id})`}
            isAnimationActive={false}
            connectNulls
            dot={false}
            activeDot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
