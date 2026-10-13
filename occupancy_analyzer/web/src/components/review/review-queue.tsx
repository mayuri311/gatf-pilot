"use client";

import { useEffect, useOptimistic, useState, useTransition } from "react";
import { Check, Lock, X } from "lucide-react";
import { toast } from "sonner";
import type { ReviewItem } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtDwell } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/common/panel";
import { PlateThumb } from "@/components/common/plate";
import { ConfidenceBadge } from "@/components/common/badges";
import { EmptyState } from "@/components/common/states";
import { CorrectPlate } from "@/components/tables/correct-plate";
import { resolveMatchAction } from "@/app/actions/ops";

/** Character-by-character diff (doc 07 §7): mismatches highlighted, never colour alone (underline). */
export function PlateDiff({ a, b }: { a: string; b: string }) {
  const n = Math.max(a.length, b.length);
  return (
    <span className="plate inline-flex text-[15px]" aria-label={`${b}${a === b ? ", identical" : ", differs"}`}>
      {Array.from({ length: n }, (_, i) => {
        const ch = b[i] ?? "·";
        const diff = a[i] !== b[i];
        return (
          <span key={i} className={cn("px-[1px]", diff && "rounded-sm bg-state-full/20 text-state-full underline decoration-2 underline-offset-4")}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

function ReviewCard({ item, isAdmin, onResolved, focused }: { item: ReviewItem; isAdmin: boolean; onResolved: (id: string) => void; focused: boolean }) {
  const [pending, start] = useTransition();
  const exitPlate = item.exit_read?.plate_norm ?? "";
  const exitAt = item.exit_read?.event_at ? Date.parse(item.exit_read.event_at) : null;
  const act = (entryPass: string | null, label: string) => {
    if (!isAdmin) return;
    start(async () => {
      onResolved(item.session_id);
      const r = await resolveMatchAction(item.exit_pass_id, entryPass);
      if (r.ok) toast.success(label);
      else toast.error(r.error);
    });
  };

  useEffect(() => {
    if (!focused || !isAdmin) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < Math.min(3, item.candidates.length)) {
        e.preventDefault();
        const c = item.candidates[idx];
        act(c.entry_pass_id, `Matched to ${c.plate_norm}`);
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        act(null, "Marked as no match");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Panel className={cn("overflow-hidden", focused && "ring-2 ring-primary/40", pending && "opacity-60")}>
      <div className="grid gap-0 lg:grid-cols-[300px_1fr]">
        <div className="border-b bg-muted/20 p-5 lg:border-r lg:border-b-0">
          <p className="eyebrow mb-2 text-dir-out">◀ Exit read</p>
          <PlateThumb readId={item.exit_read?.read_id} alt={`Exit crop ${exitPlate}`} className="h-20 w-full rounded-md" />
          <div className="mt-3 flex items-center justify-between">
            <span className="plate text-lg">{exitPlate || "—"}</span>
            <ConfidenceBadge value={item.exit_read?.plate_confidence} quality={item.exit_read?.quality} />
          </div>
          <p className="num mt-1 text-[12px] text-muted-foreground">{fmtDateTime(item.exit_read?.event_at)} ET</p>
          {isAdmin && item.exit_read && (
            <div className="mt-3">
              <CorrectPlate readId={item.exit_read.read_id} current={exitPlate} />
            </div>
          )}
        </div>
        <div className="p-5">
          <p className="eyebrow mb-3 text-muted-foreground">Candidate entries (top 3)</p>
          {item.candidates.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No plausible open entry. Likely an orphan exit (missed entry read).</p>
          ) : (
            <ol className="grid gap-3 md:grid-cols-3">
              {item.candidates.slice(0, 3).map((c, i) => {
                const entryAt = c.entry_at ? Date.parse(c.entry_at) : null;
                const dwell = exitAt && entryAt ? (exitAt - entryAt) / 60000 : null;
                return (
                  <li key={(c.entry_pass_id ?? "") + i} className="rounded-lg border bg-card p-3">
                    <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="num rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground">{i + 1}</span>
                      <span className="num">score {c.score?.toFixed(2) ?? "—"}</span>
                    </div>
                    <PlateThumb readId={c.read?.read_id} alt={`Entry crop ${c.plate_norm ?? ""}`} className="h-14 w-full rounded" />
                    <div className="mt-2">
                      <PlateDiff a={exitPlate} b={c.plate_norm ?? ""} />
                    </div>
                    <dl className="num mt-2 space-y-0.5 text-[11.5px] text-muted-foreground">
                      <div>in {fmtDateTime(c.entry_at)}</div>
                      <div>implies stay <span className="font-semibold text-foreground">{fmtDwell(dwell)}</span></div>
                    </dl>
                    {isAdmin && (
                      <Button size="sm" className="mt-3 w-full gap-1.5" disabled={pending || !c.entry_pass_id} onClick={() => act(c.entry_pass_id, `Matched to ${c.plate_norm}`)}>
                        <Check className="size-3.5" /> Confirm <kbd className="num ml-auto rounded bg-primary-foreground/20 px-1 text-[10px]">{i + 1}</kbd>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={pending} onClick={() => act(null, "Marked as no match")}>
                <X className="size-3.5" /> No match <kbd className="num rounded bg-muted px-1 text-[10px]">N</kbd>
              </Button>
            ) : (
              <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Lock className="size-3.5" /> Read-only — only admins resolve matches.
              </span>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function ReviewQueue({ items, isAdmin }: { items: ReviewItem[]; isAdmin: boolean }) {
  const [resolved, markResolved] = useOptimistic<string[], string>([], (s, id) => [...s, id]);
  const [focus, setFocus] = useState(0);
  const visible = items.filter((i) => !resolved.includes(i.session_id));
  if (visible.length === 0) {
    return <EmptyState title="Queue is empty">Every exit has been matched. Fuzzy matches that need a human appear here.</EmptyState>;
  }
  return (
    <div className="space-y-4">
      {isAdmin && (
        <p className="text-[12px] text-muted-foreground">
          Keyboard: <kbd className="num rounded border px-1">1</kbd>–<kbd className="num rounded border px-1">3</kbd> confirm a candidate,{" "}
          <kbd className="num rounded border px-1">N</kbd> no match — applies to the highlighted card. Click a card to focus it.
        </p>
      )}
      {visible.map((item, i) => (
        <div key={item.session_id} onClickCapture={() => setFocus(i)}>
          <ReviewCard item={item} isAdmin={isAdmin} focused={i === Math.min(focus, visible.length - 1)} onResolved={markResolved} />
        </div>
      ))}
    </div>
  );
}
