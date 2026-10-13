"use client";

import { MoonStar } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionRow } from "@/lib/rpc";
import { fmtDwell, fmtHM } from "@/lib/format";
import { Plate } from "@/components/common/plate";
import { EmptyState } from "@/components/common/states";

function bucketColor(min: number) {
  if (min < 60) return "color-mix(in oklab, var(--chart-1) 55%, transparent)";
  if (min < 240) return "var(--chart-1)";
  if (min < 480) return "var(--chart-4)";
  return "var(--state-full)";
}

/** "In the lot now": open sessions as swimlanes (oldest first), ⏾ for stale / multi-day. */
export function Swimlanes({
  sessions,
  now,
  hidePlates,
  onOpen,
}: {
  sessions: SessionRow[];
  now: Date;
  hidePlates?: boolean;
  onOpen: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="px-5 pb-5">
        <EmptyState title="Nobody in the lot" compact>
          Open sessions appear here after an entry is read.
        </EmptyState>
      </div>
    );
  }
  const rows = sessions.map((s) => {
    const ageMin = s.entry_at ? Math.max(0, (now.getTime() - Date.parse(s.entry_at)) / 60000) : (s.dwell_min ?? 0);
    return { s, ageMin };
  });
  const scale = Math.max(12 * 60, Math.min(24 * 60, Math.max(...rows.map((r) => r.ageMin))));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pb-2 text-[11px] text-muted-foreground">
        <span>Oldest first · {sessions.length} open</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded bg-chart-1/55" />&lt;1h</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded bg-chart-1" />1–4h</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded bg-chart-4" />4–8h</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded bg-state-full" />8h+</span>
        </span>
      </div>
      <ol className="scrollbar-thin max-h-[440px] flex-1 overflow-y-auto px-5 pb-4" aria-label="Vehicles in the lot">
        {rows.map(({ s, ageMin }) => {
          const flagged = s.multi_day || s.suspect_stale;
          return (
            <li key={s.session_id}>
              <button
                type="button"
                onClick={() => onOpen(s.session_id)}
                className="group grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-md py-1.5 text-left hover:bg-muted/30 focus-visible:bg-muted/50 focus-visible:outline-none"
                aria-label={`${hidePlates ? "Vehicle" : s.plate_norm} in for ${fmtDwell(ageMin)}${flagged ? ", flagged" : ""}`}
              >
                <span className="relative h-5 overflow-hidden rounded bg-muted/50">
                  <span
                    className={cn("absolute inset-y-0 left-0 rounded", flagged && "bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgba(0,0,0,0.25)_3px_6px)]")}
                    style={{ width: `${Math.max(2, Math.min(100, (ageMin / scale) * 100))}%`, backgroundColor: bucketColor(ageMin) }}
                  />
                  <span className="num absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold text-white mix-blend-normal drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">
                    {fmtDwell(ageMin)}
                  </span>
                  {flagged && (
                    <span className="absolute inset-y-0 right-1.5 flex items-center gap-1 text-[11px] text-state-full">
                      <MoonStar className="size-3" aria-hidden />
                      {s.multi_day ? "multi-day" : "stale?"}
                    </span>
                  )}
                </span>
                <span className="flex w-[118px] items-center justify-end gap-2">
                  <span className="num text-[11px] text-muted-foreground">{fmtHM(s.entry_at)}</span>
                  <Plate value={s.plate_norm} link={false} hidden={hidePlates} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
