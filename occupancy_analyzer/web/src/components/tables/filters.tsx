"use client";

import { useEffect, useState, useTransition } from "react";
import { parseAsArrayOf, parseAsString, useQueryStates } from "nuqs";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Plate search box synced (debounced) to `?plate=`; resets paging. */
export function PlateFilter({ placeholder = "Plate…" }: { placeholder?: string }) {
  const [, startTransition] = useTransition();
  const [q, setQ] = useQueryStates(
    { plate: parseAsString, page: parseAsString },
    { shallow: false, startTransition },
  );
  const [v, setV] = useState(q.plate ?? "");
  useEffect(() => {
    const norm = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (norm === (q.plate ?? "")) return;
    const t = window.setTimeout(() => setQ({ plate: norm || null, page: null }), 350);
    return () => window.clearTimeout(t);
  }, [v, q.plate, setQ]);
  return (
    <label className="relative flex h-8 items-center">
      <span className="sr-only">Filter by plate</span>
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        className="plate h-8 w-40 rounded-md border bg-card pr-7 pl-8 text-[12.5px] uppercase outline-none placeholder:font-sans placeholder:tracking-normal placeholder:normal-case focus-visible:ring-2 focus-visible:ring-ring"
      />
      {v && (
        <button type="button" onClick={() => setV("")} className="absolute right-1.5 text-muted-foreground hover:text-foreground" aria-label="Clear plate filter">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

/** Multi-select facet stored as a comma list in the URL. */
export function FacetFilter({ param, label, options }: { param: string; label: string; options: { value: string; label: string }[] }) {
  const [, startTransition] = useTransition();
  const [q, setQ] = useQueryStates(
    { [param]: parseAsArrayOf(parseAsString).withDefault([]), page: parseAsString },
    { shallow: false, startTransition },
  );
  const selected = (q[param] as string[]) ?? [];
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    setQ({ [param]: next.length ? next : null, page: null });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md border border-dashed bg-card px-2.5 text-[12.5px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            selected.length > 0 && "border-solid border-primary/40 text-foreground",
          )}
        >
          {label}
          {selected.length > 0 && <span className="num rounded bg-primary/15 px-1 text-[11px] text-primary">{selected.length}</span>}
          <ChevronDown className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <ul role="listbox" aria-multiselectable aria-label={label}>
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <span className={cn("flex size-4 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>
                    {on && <Check className="size-3" />}
                  </span>
                  {o.label}
                </button>
              </li>
            );
          })}
        </ul>
        {selected.length > 0 && (
          <button type="button" onClick={() => setQ({ [param]: null, page: null })} className="mt-1 w-full rounded border-t px-2 py-1.5 text-center text-[12px] text-muted-foreground hover:text-foreground">
            Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Single-select facet (`?param=value`). */
export function SelectFilter({ param, label, options }: { param: string; label: string; options: { value: string; label: string }[] }) {
  const [, startTransition] = useTransition();
  const [q, setQ] = useQueryStates({ [param]: parseAsString, page: parseAsString }, { shallow: false, startTransition });
  const value = q[param] as string | null;
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-md border bg-card pl-2.5 text-[12.5px] text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => setQ({ [param]: e.target.value || null, page: null })}
        className="h-full rounded-md bg-transparent pr-2 text-foreground outline-none"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
