"use client";

import { useMemo } from "react";
import type { HeatCell } from "@/lib/rpc";
import { cn } from "@/lib/utils";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * 7×24 hour × weekday heatmap as a CSS grid (doc 07 §2): single-hue sequential
 * ramp; empty cells (no data) are hatched, never shown as zero.
 */
export function WeekHeatmap({
  cells,
  format = (v: number) => v.toFixed(0),
  unit,
}: {
  cells: HeatCell[];
  format?: (v: number) => string;
  unit?: string;
}) {
  const { grid, max } = useMemo(() => {
    const g = new Map<string, number | null>();
    let m = 0;
    for (const c of cells) {
      g.set(`${c.dow}-${c.hour}`, c.value);
      if (c.value != null && c.value > m) m = c.value;
    }
    return { grid: g, max: m };
  }, [cells]);

  return (
    <div className="scrollbar-thin overflow-x-auto pb-1">
      <div
        className="grid min-w-[640px] gap-[3px]"
        style={{ gridTemplateColumns: "40px repeat(24, minmax(18px, 1fr))" }}
        role="table"
        aria-label="Hour by weekday heatmap"
      >
        <div role="row" className="contents">
          <span role="columnheader" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} role="columnheader" className="num text-center text-[10px] text-muted-foreground">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </span>
          ))}
        </div>
        {ORDER.map((d) => (
          <div role="row" className="contents" key={d}>
            <span role="rowheader" className="self-center text-[11px] text-muted-foreground">
              {DOW[d]}
            </span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = grid.get(`${d}-${h}`);
              const has = v !== undefined && v !== null;
              const intensity = has && max > 0 ? 0.08 + 0.85 * ((v as number) / max) : 0;
              return (
                <span
                  role="cell"
                  key={h}
                  title={`${DOW[d]} ${String(h).padStart(2, "0")}:00 ET — ${has ? format(v as number) + (unit ? ` ${unit}` : "") : "no data"}`}
                  className={cn("aspect-[1.3] min-h-[18px] rounded-[3px] transition-transform hover:scale-110 hover:ring-1 hover:ring-foreground/40", !has && "heat-empty")}
                  style={
                    has
                      ? { background: `color-mix(in oklab, var(--chart-1) ${Math.round(intensity * 100)}%, var(--card))` }
                      : undefined
                  }
                >
                  <span className="sr-only">{has ? format(v as number) : "no data"}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <HeatLegend max={max} format={format} unit={unit} />
    </div>
  );
}

export function HeatLegend({ max, format, unit }: { max: number; format: (v: number) => string; unit?: string }) {
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
      <span className="heat-empty inline-block h-2.5 w-4 rounded-[2px]" aria-hidden /> no data
      <span className="ml-3 num">0</span>
      <span
        className="h-2.5 w-28 rounded-[2px]"
        style={{ background: "linear-gradient(90deg, color-mix(in oklab, var(--chart-1) 8%, var(--card)), var(--chart-1))" }}
        aria-hidden
      />
      <span className="num">
        {format(max)}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}
