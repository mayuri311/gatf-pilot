"use client";

import { useState, useTransition } from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { CalendarRange, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRESETS } from "@/lib/range";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const rangeParsers = {
  preset: parseAsString.withDefault("7d"),
  from: parseAsString,
  to: parseAsString,
};

/** Date presets + custom range, stored in the URL (shareable views). Triggers a server re-render. */
export function RangeControls({
  label,
  active,
  presets = PRESETS.map((p) => p.id),
}: {
  label: string;
  /** The preset the server resolved (handles per-page defaults). */
  active: string;
  presets?: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useQueryStates(rangeParsers, { shallow: false, startTransition, history: "push" });
  const [from, setFrom] = useState(q.from ?? "");
  const [to, setTo] = useState(q.to ?? "");
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Date range" className="inline-flex h-9 items-center rounded-lg border bg-card p-0.5">
        {PRESETS.filter((p) => presets.includes(p.id)).map((p) => {
          const on = active === p.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => setQ({ preset: p.id, from: null, to: null })}
              className={cn(
                "h-8 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                on && "bg-primary/12 text-primary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_30%,transparent)]",
              )}
            >
              {p.label}
            </button>
          );
        })}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-pressed={active === "custom"}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active === "custom" && "bg-primary/12 text-primary",
              )}
            >
              <CalendarRange className="size-3.5" /> Custom
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (from && to) {
                  setQ({ preset: "custom", from, to: to < from ? from : to });
                  setOpen(false);
                }
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="rc-from" className="text-xs">From</Label>
                  <Input id="rc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="num h-8 text-xs" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rc-to" className="text-xs">To</Label>
                  <Input id="rc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="num h-8 text-xs" required />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">Local dates (ET), inclusive.</p>
              <Button type="submit" size="sm" className="w-full">Apply</Button>
            </form>
          </PopoverContent>
        </Popover>
      </div>
      <span className="num flex items-center gap-1.5 text-[12px] text-muted-foreground" aria-live="polite">
        {pending && <Loader2 className="size-3.5 animate-spin" />}
        {label}
      </span>
    </div>
  );
}

/** Segmented tab bar stored in `?tab=` (server re-render). */
export function UrlTabs({ tabs, value, param = "tab" }: { tabs: { id: string; label: string }[]; value: string; param?: string }) {
  const [pending, startTransition] = useTransition();
  const [, setQ] = useQueryStates({ [param]: parseAsString }, { shallow: false, startTransition, history: "push" });
  return (
    <div role="tablist" aria-label="Sections" className={cn("flex gap-1 overflow-x-auto border-b", pending && "opacity-80")}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => setQ({ [param]: t.id })}
            className={cn(
              "relative -mb-px h-10 shrink-0 border-b-2 border-transparent px-3 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              active && "border-primary text-foreground",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
