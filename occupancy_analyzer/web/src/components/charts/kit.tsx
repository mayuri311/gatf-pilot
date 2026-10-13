"use client";

import { useState } from "react";
import { Download, Info, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/common/panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Categorical order (validated: blue → orange → purple → teal). Green is reserved for "good". */
export const SERIES = ["var(--chart-1)", "var(--chart-4)", "var(--chart-5)", "var(--chart-2)"] as const;

export const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
export const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: AXIS_TICK,
  tickMargin: 8,
} as const;
export const GRID_PROPS = {
  vertical: false,
  stroke: "var(--grid)",
  strokeDasharray: "4 4",
} as const;

export type Column<T> = { key: keyof T & string; label: string; format?: (v: T[keyof T], row: T) => string };

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: Column<T>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.map((c) => esc(c.label)).join(","),
    ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(",")),
  ].join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type LegendEntry = { label: string; color: string; dashed?: boolean; kind?: "line" | "area" | "bar" | "dot" };

export function Legend({ items, className }: { items: LegendEntry[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]", className)} aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5" style={{ color: i.color }}>
          {i.kind === "area" ? (
            <span className="h-2.5 w-3.5 rounded-[2px]" style={{ background: `color-mix(in oklab, ${i.color} 28%, transparent)`, border: `1px solid color-mix(in oklab, ${i.color} 55%, transparent)` }} aria-hidden />
          ) : i.kind === "bar" ? (
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: i.color }} aria-hidden />
          ) : i.kind === "dot" ? (
            <span className="size-2 rounded-full" style={{ background: i.color }} aria-hidden />
          ) : (
            <svg width="18" height="8" aria-hidden>
              <line x1="0" y1="4" x2="18" y2="4" stroke={i.color} strokeWidth="1.6" strokeDasharray={i.dashed ? "3 2" : undefined} />
              <circle cx="9" cy="4" r="2.6" fill="var(--card)" stroke={i.color} strokeWidth="1.5" />
            </svg>
          )}
          <span className="text-foreground/80">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function DefinitionTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground" aria-label="Definition">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-[12px] leading-snug">{children}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Chart card: title phrased as a question, legend top-right, "view as table"
 * and "download CSV" on every chart (doc 07 §1.5).
 */
export function ChartCard<T extends Record<string, unknown>>({
  title,
  subtitle,
  legend,
  definition,
  rows,
  columns,
  filename,
  children,
  className,
  bodyClassName,
  extra,
  summary,
}: {
  title: string;
  subtitle?: React.ReactNode;
  legend?: LegendEntry[];
  definition?: React.ReactNode;
  rows?: T[];
  columns?: Column<T>[];
  filename?: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  extra?: React.ReactNode;
  /** One-sentence takeaway for screen readers. */
  summary?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const hasData = rows && columns;
  return (
    <Panel className={cn("flex flex-col", className)}>
      <PanelHeader
        title={
          <span className="inline-flex items-center gap-1">
            {title}
            {definition && <DefinitionTip>{definition}</DefinitionTip>}
          </span>
        }
        subtitle={subtitle}
        actions={
          <>
            {extra}
            {hasData && (
              <div className="no-print flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setAsTable((v) => !v)}
                  aria-pressed={asTable}
                  className={cn(
                    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                    asTable && "bg-muted text-foreground",
                  )}
                  title={asTable ? "Show chart" : "View as table"}
                  aria-label={asTable ? "Show chart" : "View as table"}
                >
                  <Table2 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => downloadCsv(filename ?? "chart.csv", toCsv(rows!, columns!))}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Download CSV"
                  aria-label="Download CSV"
                >
                  <Download className="size-3.5" />
                </button>
              </div>
            )}
          </>
        }
      />
      {legend && legend.length > 0 && !asTable && (
        <div className="flex justify-end px-5 pt-3">
          <Legend items={legend} />
        </div>
      )}
      <div className={cn("flex-1 px-3 pt-2 pb-4", bodyClassName)} role={asTable ? undefined : "figure"} aria-label={summary ?? title}>
        {asTable && hasData ? <DataTable rows={rows!} columns={columns!} /> : children}
      </div>
    </Panel>
  );
}

export function DataTable<T extends Record<string, unknown>>({ rows, columns }: { rows: T[]; columns: Column<T>[] }) {
  return (
    <div className="scrollbar-thin max-h-[360px] overflow-auto px-2">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            {columns.map((c) => (
              <th key={c.key} scope="col" className="px-2 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {columns.map((c) => (
                <td key={c.key} className="num px-2 py-1.5 whitespace-nowrap">
                  {c.format ? c.format(r[c.key], r) : r[c.key] === null || r[c.key] === undefined ? "—" : String(r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TooltipBox({
  title,
  rows,
}: {
  title: React.ReactNode;
  rows: { label: string; value: React.ReactNode; color?: string; dashed?: boolean }[];
}) {
  return (
    <div className="min-w-[160px] rounded-lg border bg-popover/95 px-3 py-2 text-[12px] shadow-xl backdrop-blur-sm">
      <div className="num mb-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            {r.color && (
              <span
                className="h-0.5 w-3 shrink-0 rounded"
                style={{ background: r.dashed ? `repeating-linear-gradient(90deg, ${r.color} 0 3px, transparent 3px 5px)` : r.color }}
                aria-hidden
              />
            )}
            <span className="text-muted-foreground">{r.label}</span>
            <span className="num ml-auto pl-3 font-semibold text-foreground">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Gradient defs for soft area fills. */
export function AreaGradient({ id, color, opacity = 0.22 }: { id: string; color: string; opacity?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={opacity} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}
