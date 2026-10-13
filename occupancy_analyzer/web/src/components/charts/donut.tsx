"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { TooltipBox } from "./kit";

export type DonutSlice = { label: string; value: number; color: string };

/** Donut with centre label and a legend list with % on the right (Fortress style). */
export function Donut({ slices, centerValue, centerLabel, height = 200 }: { slices: DonutSlice[]; centerValue: string; centerLabel: string; height?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="relative" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 240, height }}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.label} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const s = payload[0].payload as DonutSlice;
                return <TooltipBox title={s.label} rows={[{ label: "Count", value: s.value, color: s.color }, { label: "Share", value: total ? `${((s.value / total) * 100).toFixed(1)}%` : "—" }]} />;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="num text-[22px] font-semibold">{centerValue}</span>
          <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="space-y-2.5">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2.5 text-[13px]">
            <span className="size-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
            <span className="text-foreground/80">{s.label}</span>
            <span className="num ml-auto font-semibold">{total ? `${Math.round((s.value / total) * 100)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
