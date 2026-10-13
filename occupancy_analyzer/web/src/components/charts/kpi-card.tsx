"use client";

import NumberFlow from "@number-flow/react";
import { TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";
import { DefinitionTip } from "./kit";

export type KpiCardProps = {
  label: string;
  value: number | null | undefined;
  /** Optional preformatted display (e.g. dwell "1 h 52 m"); NumberFlow is used otherwise. */
  display?: string;
  suffix?: string;
  icon: LucideIcon;
  tone: string;
  /** Relative change vs comparison period (0.12 = +12%). */
  delta?: number | null;
  deltaLabel?: string;
  /** When "down is good" (e.g. bounces), invert colouring. */
  invert?: boolean;
  spark?: (number | null)[];
  sub?: React.ReactNode;
  definition?: React.ReactNode;
  stale?: boolean;
};

export function KpiCard({
  label,
  value,
  display,
  suffix,
  icon: Icon,
  tone,
  delta,
  deltaLabel,
  invert,
  spark,
  sub,
  definition,
  stale,
}: KpiCardProps) {
  const up = (delta ?? 0) >= 0;
  const good = invert ? !up : up;
  return (
    <div
      className={cn(
        "relative flex min-h-[168px] flex-col overflow-hidden rounded-[10px] border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:shadow-none",
        stale && "stale",
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-[13px] text-foreground/80">
            {label}
            {definition && <DefinitionTip>{definition}</DefinitionTip>}
          </p>
          <p className="num mt-2 text-[26px] leading-none font-semibold tracking-[-0.02em] text-foreground">
            {value === null || value === undefined ? (
              <span className="text-muted-foreground">—</span>
            ) : display ? (
              display
            ) : (
              <NumberFlow value={value} format={{ maximumFractionDigits: 1 }} suffix={suffix} />
            )}
          </p>
        </div>
        <span className="icon-tile shrink-0" style={{ ["--tile" as string]: tone }} aria-hidden>
          <Icon className="size-[19px]" strokeWidth={1.75} />
        </span>
      </div>
      <div className="mt-3 flex min-h-5 flex-wrap items-center gap-x-1.5 px-5 text-[12px]">
        {delta != null && Number.isFinite(delta) ? (
          <>
            <span className={cn("num inline-flex items-center gap-1 font-semibold", good ? "text-success" : "text-destructive")}>
              {up ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
              {up ? "+" : ""}
              {(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}%
            </span>
            <span className="text-muted-foreground">{deltaLabel}</span>
          </>
        ) : sub ? (
          <span className="text-muted-foreground">{sub}</span>
        ) : (
          <span className="text-muted-foreground/70">no comparison yet</span>
        )}
      </div>
      {delta != null && sub && <div className="px-5 pt-0.5 text-[12px] text-muted-foreground">{sub}</div>}
      <div className="mt-auto">{spark && <Sparkline data={spark} color={tone} />}</div>
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div className="flex min-h-[168px] flex-col rounded-[10px] border bg-card p-5">
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-7 w-20 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-3 w-36 animate-pulse rounded bg-muted" />
      <div className="mt-auto h-10 w-full animate-pulse rounded bg-muted/60" />
    </div>
  );
}
