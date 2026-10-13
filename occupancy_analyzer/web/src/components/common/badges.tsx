import { ArrowLeft, ArrowRight, MoonStar, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { MATCH_LABEL, QUALITY_META, SESSION_STATUS_LABEL, STATE_META, confClass, type OccState } from "@/lib/occupancy";
import { fmtConf } from "@/lib/format";

const pill = "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11.5px] font-medium whitespace-nowrap";

export function StateBadge({ state, size = "sm" }: { state: OccState; size?: "sm" | "lg" }) {
  const m = STATE_META[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-semibold",
        size === "lg" ? "h-8 px-2.5 text-[14px]" : "h-[22px] px-1.5 text-[11.5px]",
      )}
      style={{ color: m.color, background: `color-mix(in oklab, ${m.color} 13%, transparent)` }}
    >
      <span aria-hidden className="text-[0.85em] leading-none">
        {m.shape}
      </span>
      {m.label}
    </span>
  );
}

export function DirectionBadge({ direction, compact }: { direction: "in" | "out" | null | undefined; compact?: boolean }) {
  if (!direction) return <span className="text-muted-foreground">—</span>;
  const isIn = direction === "in";
  const Icon = isIn ? ArrowRight : ArrowLeft;
  return (
    <span
      className={cn(pill, "num border-transparent")}
      style={{
        color: isIn ? "var(--dir-in)" : "var(--dir-out)",
        background: `color-mix(in oklab, ${isIn ? "var(--dir-in)" : "var(--dir-out)"} 13%, transparent)`,
      }}
    >
      <Icon className="size-3" aria-hidden />
      {compact ? (isIn ? "IN" : "OUT") : isIn ? "IN" : "OUT"}
    </span>
  );
}

export function ConfidenceBadge({ value, quality }: { value: number | null | undefined; quality?: "high" | "medium" | "low" | null }) {
  const q = quality ?? confClass(value);
  const m = QUALITY_META[q];
  return (
    <span className={cn("num inline-flex items-center gap-1 text-[12px]", m.tone)} title={`${m.label} confidence`}>
      <span aria-hidden>{m.icon}</span>
      <span className="text-foreground/90">{fmtConf(value)}</span>
      <span className="sr-only">({m.label} confidence)</span>
    </span>
  );
}

export function QualityBadge({ quality }: { quality: "high" | "medium" | "low" | null | undefined }) {
  if (!quality) return <span className="text-muted-foreground">—</span>;
  const m = QUALITY_META[quality];
  return (
    <span className={cn(pill, "border-border bg-muted/40", m.tone)}>
      <span aria-hidden>{m.icon}</span>
      <span className="text-foreground/85">{m.label}</span>
    </span>
  );
}

export function MatchBadge({ method, score }: { method: string | null | undefined; score?: number | null }) {
  if (!method) return <span className="text-[12px] text-muted-foreground">—</span>;
  const tone =
    method === "exact"
      ? "text-success border-success/25 bg-success/10"
      : method === "fuzzy_pending"
        ? "text-warning border-warning/30 bg-warning/10"
        : method === "manual"
          ? "text-primary border-primary/25 bg-primary/10"
          : "text-chart-2 border-chart-2/25 bg-chart-2/10";
  return (
    <span className={cn(pill, tone)}>
      {method === "fuzzy_pending" && <TriangleAlert className="size-3" aria-hidden />}
      {MATCH_LABEL[method] ?? method}
      {score != null && method !== "exact" && <span className="num opacity-75">{score.toFixed(2)}</span>}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "open"
      ? "text-primary border-primary/25 bg-primary/10"
      : status === "pending_review"
        ? "text-warning border-warning/30 bg-warning/10"
        : status === "orphan_exit" || status === "expired"
          ? "text-muted-foreground border-border bg-muted/50"
          : status === "closed_admin"
            ? "text-chart-5 border-chart-5/25 bg-chart-5/10"
            : "text-foreground/80 border-border bg-muted/40";
  return <span className={cn(pill, tone)}>{SESSION_STATUS_LABEL[status] ?? status}</span>;
}

export function FlagBadges({
  s,
}: {
  s: { suspect_stale?: boolean; multi_day?: boolean; overnight?: boolean; is_bounce?: boolean };
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {s.multi_day && (
        <span className={cn(pill, "border-state-full/30 bg-state-full/10 text-state-full")} title="Present for more than 24 h">
          <MoonStar className="size-3" aria-hidden />
          multi-day
        </span>
      )}
      {s.suspect_stale && !s.multi_day && (
        <span className={cn(pill, "border-warning/30 bg-warning/10 text-warning")} title="Open for more than 24 h — may have left unseen">
          <MoonStar className="size-3" aria-hidden />
          stale?
        </span>
      )}
      {s.overnight && (
        <span className={cn(pill, "border-chart-5/30 bg-chart-5/10 text-chart-5")} title="Present at 03:00 local">
          <span aria-hidden>⏾</span>
          overnight
        </span>
      )}
      {s.is_bounce && (
        <span className={cn(pill, "border-border bg-muted/50 text-muted-foreground")} title="In and out within 5 minutes">
          ↺ bounce
        </span>
      )}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: "critical" | "warning" | "info" }) {
  const tone =
    severity === "critical"
      ? "text-destructive border-destructive/30 bg-destructive/10"
      : severity === "warning"
        ? "text-warning border-warning/30 bg-warning/10"
        : "text-primary border-primary/25 bg-primary/10";
  const glyph = severity === "critical" ? "■" : severity === "warning" ? "▲" : "●";
  return (
    <span className={cn(pill, "uppercase tracking-wide", tone)}>
      <span aria-hidden className="text-[9px]">
        {glyph}
      </span>
      {severity}
    </span>
  );
}
