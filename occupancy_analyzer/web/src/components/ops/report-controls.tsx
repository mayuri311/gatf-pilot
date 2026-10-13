"use client";

import { useTransition } from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { Download, Loader2, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function ReportControls({ period, date, csvHref }: { period: string; date: string; csvHref: string }) {
  const [pending, startTransition] = useTransition();
  const [, setQ] = useQueryStates({ period: parseAsString, date: parseAsString }, { shallow: false, startTransition });
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Period" className="inline-flex h-9 items-center rounded-lg border bg-card p-0.5">
        {["day", "week", "month"].map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            onClick={() => setQ({ period: p })}
            className={cn("h-8 rounded-md px-3 text-[12.5px] font-medium text-muted-foreground capitalize hover:text-foreground", period === p && "bg-primary/12 text-primary")}
          >
            {p}
          </button>
        ))}
      </div>
      <label className="sr-only" htmlFor="rep-date">Date</label>
      <input
        id="rep-date"
        type="date"
        value={date}
        onChange={(e) => e.target.value && setQ({ date: e.target.value })}
        className="num h-9 rounded-lg border bg-card px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      <Button asChild variant="outline" className="h-9 gap-1.5">
        <a href={csvHref} download>
          <Download className="size-4" /> CSV
        </a>
      </Button>
      <Button className="h-9 gap-1.5" onClick={() => window.print()}>
        <Printer className="size-4" /> Print / PDF
      </Button>
    </div>
  );
}
