"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CarFront, Clock3, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { rpc, type PlateHit } from "@/lib/rpc";
import { fmtDateTime } from "@/lib/format";
import { NAV } from "./nav";
import type { ShellProps } from "./types";

const normalize = (q: string) => q.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function CommandPalette({
  open,
  onOpenChange,
  user,
  aiEnabled,
}: { open: boolean; onOpenChange: (o: boolean) => void } & Pick<ShellProps, "user" | "aiEnabled">) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ exact: PlateHit[]; similar: PlateHit[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plate = normalize(q);

  useEffect(() => {
    if (plate.length < 2) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      setLoading(true);
      const res = await rpc.searchPlates(getBrowserSupabase(), plate);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setHits(res.data);
        setError(null);
      } else {
        setHits(null);
        setError(res.error.kind === "missing" ? "Plate search isn't available yet." : "Plate search failed.");
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [plate]);

  const go = (href: string) => {
    onOpenChange(false);
    setQ("");
    router.push(href);
  };

  const showPlates = plate.length >= 2;
  const nav = NAV.filter((g) => !g.adminOnly || user.role === "admin").flatMap((g) =>
    g.items.filter((i) => !i.requiresAi || aiEnabled).map((i) => ({ ...i, group: g.label })),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] translate-y-0 overflow-hidden rounded-xl p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Search plates and pages</DialogTitle>
        <DialogDescription className="sr-only">Type a plate (exact or similar) or a page name</DialogDescription>
        <Command loop>
      <CommandInput value={q} onValueChange={setQ} placeholder="Search plates or jump to a page…" className="font-mono" />
      <CommandList>
        <CommandEmpty>{loading ? "Searching…" : "No matches."}</CommandEmpty>
        {showPlates && (
          <>
            {error && (
              <CommandGroup heading="Plates">
                <CommandItem disabled value={`err-${plate}`}>
                  {error}
                </CommandItem>
              </CommandGroup>
            )}
            {hits && hits.exact.length > 0 && (
              <CommandGroup heading="Exact plate">
                {hits.exact.map((h) => (
                  <CommandItem key={"e" + h.plate_norm} value={`plate ${h.plate_norm} ${q}`} onSelect={() => go(`/vehicles/${encodeURIComponent(h.plate_norm)}`)}>
                    <CarFront />
                    <span className="plate">{h.plate_norm}</span>
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock3 className="size-3" /> {fmtDateTime(h.last_seen)} · <span className="num">{h.visits ?? 0}</span> visits
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {hits && hits.similar.length > 0 && (
              <CommandGroup heading="Similar plates">
                {hits.similar.map((h) => (
                  <CommandItem key={"s" + h.plate_norm} value={`similar ${h.plate_norm} ${q}`} onSelect={() => go(`/vehicles/${encodeURIComponent(h.plate_norm)}`)}>
                    <CarFront className="opacity-60" />
                    <span className="plate">{h.plate_norm}</span>
                    {h.similarity != null && (
                      <span className="num text-xs text-muted-foreground">{Math.round(h.similarity * 100)}%</span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{fmtDateTime(h.last_seen)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Search">
              <CommandItem value={`sessions ${q}`} onSelect={() => go(`/sessions?plate=${encodeURIComponent(plate)}`)}>
                <Search /> Sessions with plate <span className="plate">{plate}</span>
              </CommandItem>
              <CommandItem value={`reads ${q}`} onSelect={() => go(`/reads?plate=${encodeURIComponent(plate)}`)}>
                <Search /> Reads with plate <span className="plate">{plate}</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        <CommandGroup heading="Go to">
          {nav.map((i) => (
            <CommandItem key={i.href} value={`${i.label} ${i.group}`} onSelect={() => go(i.href)}>
              <i.icon />
              {i.label}
              <span className="ml-auto text-xs text-muted-foreground">{i.group}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
