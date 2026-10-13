"use client";

import { useMemo } from "react";
import Link from "next/link";
import { addDays, format, parseISO, startOfWeek } from "date-fns";
import type { DailyStat } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { fmtPct } from "@/lib/format";

/** Calendar heatmap of daily peak % (Mon-first weeks as columns). Click a day to drill in. */
export function CalendarHeatmap({ days, fromDay, toDay }: { days: DailyStat[]; fromDay: string; toDay: string }) {
  const { weeks, months } = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const start = startOfWeek(parseISO(fromDay), { weekStartsOn: 1 });
    const end = parseISO(toDay);
    const w: { key: string; cells: { day: string; stat?: DailyStat; inRange: boolean }[] }[] = [];
    const m: { idx: number; label: string }[] = [];
    let cur = start;
    let wi = 0;
    while (cur <= end && wi < 60) {
      const cells = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(cur, i);
        const key = format(d, "yyyy-MM-dd");
        cells.push({ day: key, stat: byDay.get(key), inRange: key >= fromDay && key <= toDay });
        if (d.getDate() === 1 || (wi === 0 && i === 0)) m.push({ idx: wi, label: format(d, "MMM") });
      }
      w.push({ key: format(cur, "yyyy-MM-dd"), cells });
      cur = addDays(cur, 7);
      wi++;
    }
    return { weeks: w, months: m };
  }, [days, fromDay, toDay]);

  return (
    <div className="scrollbar-thin overflow-x-auto pb-1">
      <div className="inline-flex gap-2">
        <div className="grid grid-rows-[14px_repeat(7,16px)] gap-[3px] text-[10px] text-muted-foreground">
          <span />
          {["Mon", "", "Wed", "", "Fri", "", "Sun"].map((l, i) => (
            <span key={i} className="leading-4">
              {l}
            </span>
          ))}
        </div>
        {weeks.map((w, wi) => (
          <div key={w.key} className="grid grid-rows-[14px_repeat(7,16px)] gap-[3px]">
            <span className="text-[10px] leading-3 text-muted-foreground">{months.find((m) => m.idx === wi)?.label ?? ""}</span>
            {w.cells.map((c) => {
              const pct = c.stat?.peak_pct;
              const has = pct != null;
              const color =
                !has ? undefined : pct >= 0.85 ? "var(--state-full)" : pct >= 0.6 ? "var(--state-filling)" : "var(--chart-1)";
              const strength = has ? 25 + Math.round(Math.min(1, pct) * 75) : 0;
              const label = `${c.day}: ${has ? `peak ${fmtPct(pct)} (${c.stat?.peak_occ ?? "—"})` : "no data"}`;
              return c.inRange ? (
                <Link
                  key={c.day}
                  href={`/analytics?tab=occupancy&preset=custom&from=${c.day}&to=${c.day}`}
                  title={label}
                  aria-label={label}
                  className={cn("size-4 rounded-[3px] outline-none hover:ring-1 hover:ring-foreground/50 focus-visible:ring-2 focus-visible:ring-ring", !has && "heat-empty")}
                  style={has ? { background: `color-mix(in oklab, ${color} ${strength}%, var(--card))` } : undefined}
                />
              ) : (
                <span key={c.day} className="size-4" aria-hidden />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-chart-1" aria-hidden />● under 60%</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-state-filling" aria-hidden />▲ 60–85%</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-state-full" aria-hidden />■ ≥ 85%</span>
        <span className="flex items-center gap-1.5"><span className="heat-empty size-2.5 rounded-[2px]" aria-hidden />no data</span>
      </div>
    </div>
  );
}
