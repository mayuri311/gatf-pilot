"use client";

import NumberFlow from "@number-flow/react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { StateBadge } from "@/components/common/badges";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_META, type OccState } from "@/lib/occupancy";
import { fmtAge, fmtHM } from "@/lib/format";

export function BulletBar({
  occupancy,
  capacity,
  bandLow,
  bandHigh,
  effectivePct,
  state,
}: {
  occupancy: number;
  capacity: number;
  bandLow: number | null;
  bandHigh: number | null;
  effectivePct: number;
  state: OccState;
}) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / capacity) * 100))}%`;
  return (
    <div className="relative pt-5 pb-5" aria-hidden>
      <div className="relative h-3.5 overflow-hidden rounded-full bg-muted">
        {bandLow != null && bandHigh != null && (
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: pct(bandLow),
              width: `calc(${pct(bandHigh)} - ${pct(bandLow)})`,
              background: `color-mix(in oklab, ${STATE_META[state].color} 28%, transparent)`,
            }}
          />
        )}
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
          style={{ width: pct(occupancy), background: STATE_META[state].color }}
        />
      </div>
      <div className="absolute top-2.5 bottom-2.5 w-px bg-foreground/70" style={{ left: `${effectivePct * 100}%` }} />
      <span
        className="num absolute top-0 -translate-x-1/2 text-[10.5px] text-muted-foreground"
        style={{ left: `${effectivePct * 100}%` }}
      >
        {Math.round(effectivePct * 100)}%
      </span>
      <div className="num absolute bottom-0 left-0 text-[10.5px] text-muted-foreground">0</div>
      <div className="num absolute right-0 bottom-0 text-[10.5px] text-muted-foreground">{capacity}</div>
    </div>
  );
}

export function HeroTile({
  occupancy,
  capacity,
  bandLow,
  bandHigh,
  openSessions,
  effectivePct,
  state,
  lastReconciledAt,
  updatedAt,
  lastInAt,
  lastOutAt,
  stale,
  staleReason,
  now,
  kiosk,
}: {
  occupancy: number;
  capacity: number;
  bandLow: number | null;
  bandHigh: number | null;
  openSessions: number | null;
  effectivePct: number;
  state: OccState;
  lastReconciledAt: string | null;
  updatedAt: string | null;
  lastInAt?: string | null;
  lastOutAt?: string | null;
  stale: boolean;
  staleReason?: string | null;
  now: Date;
  kiosk?: boolean;
}) {
  const free = Math.max(0, capacity - occupancy);
  const pct = capacity ? occupancy / capacity : 0;
  const drift = openSessions != null ? openSessions - occupancy : null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] text-foreground/80">
            Occupancy now
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="About this number">
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-[12px] leading-snug">
                Estimated vehicles present: open sessions corrected for expected ghosts and missed reads, re-anchored at each admin reconciliation, with its uncertainty band. Capacity{" "}
                {capacity} comes from config/config.yaml.
              </TooltipContent>
            </Tooltip>
          </p>
        </div>
        <StateBadge state={state} size={kiosk ? "lg" : "sm"} />
      </div>

      <div className={cn("mt-3 transition-[filter,opacity]", stale && "stale")}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={cn("num leading-none font-semibold tracking-[-0.03em]", kiosk ? "text-[120px]" : "text-[64px]")}>
            <NumberFlow value={occupancy} />
          </span>
          <span className={cn("num text-muted-foreground", kiosk ? "text-4xl" : "text-2xl")}>/ {capacity}</span>
          {bandLow != null && bandHigh != null && (
            <span
              className="num rounded-md border bg-muted/40 px-2 py-0.5 text-[13px] text-foreground/85"
              title="Uncertainty band"
            >
              ≈ {bandLow}–{bandHigh}
            </span>
          )}
        </div>
        <p className={cn("mt-2 text-muted-foreground", kiosk ? "text-2xl" : "text-[14px]")}>
          <span className="num font-semibold text-foreground">{free}</span> spaces free ·{" "}
          <span className="num font-semibold text-foreground">{Math.round(pct * 100)}%</span> full
        </p>
        <BulletBar
          occupancy={occupancy}
          capacity={capacity}
          bandLow={bandLow}
          bandHigh={bandHigh}
          effectivePct={effectivePct}
          state={state}
        />
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-3 text-[12px]">
        <div className="rounded-lg border bg-muted/20 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <span className="text-dir-in" aria-hidden>▶</span> Last entry
          </dt>
          <dd className="num mt-0.5 text-[14px] font-semibold">
            {fmtHM(lastInAt ?? null)} <span className="text-[11.5px] font-normal text-muted-foreground">{lastInAt ? `${fmtAge(lastInAt, now)} ago` : ""}</span>
          </dd>
        </div>
        <div className="rounded-lg border bg-muted/20 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <span className="text-dir-out" aria-hidden>◀</span> Last exit
          </dt>
          <dd className="num mt-0.5 text-[14px] font-semibold">
            {fmtHM(lastOutAt ?? null)} <span className="text-[11.5px] font-normal text-muted-foreground">{lastOutAt ? `${fmtAge(lastOutAt, now)} ago` : ""}</span>
          </dd>
        </div>
      </dl>

      <dl className="mt-auto grid grid-cols-3 gap-3 border-t pt-4 text-[12px]">
        <div>
          <dt className="text-muted-foreground">Open sessions</dt>
          <dd className="num mt-0.5 text-[15px] font-semibold">{openSessions ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Drift S2−S1</dt>
          <dd className={cn("num mt-0.5 text-[15px] font-semibold", drift != null && Math.abs(drift) > 3 && "text-warning")}>
            {drift == null ? "—" : drift > 0 ? `+${drift}` : drift}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reconciled</dt>
          <dd className="num mt-0.5 text-[15px] font-semibold" title={lastReconciledAt ?? "never"}>
            {lastReconciledAt ? `${fmtAge(lastReconciledAt, now)} ago` : "never"}
          </dd>
        </div>
      </dl>
      {stale && (
        <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning" role="status">
          As of {fmtHM(updatedAt)} ET{staleReason ? ` — ${staleReason}` : ""}
        </p>
      )}
    </div>
  );
}
