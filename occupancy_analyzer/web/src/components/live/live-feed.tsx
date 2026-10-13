"use client";

import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PassRow } from "@/lib/rpc";
import { fmtClock, fmtDwell } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ConfidenceBadge, DirectionBadge, MatchBadge } from "@/components/common/badges";
import { Plate, PlateThumb } from "@/components/common/plate";
import { EmptyState } from "@/components/common/states";

export function LiveFeed({
  passes,
  paused,
  onTogglePause,
  pendingCount,
  freshIds,
  hidePlates,
  onOpen,
}: {
  passes: PassRow[];
  paused: boolean;
  onTogglePause: () => void;
  pendingCount: number;
  freshIds: Set<string>;
  hidePlates?: boolean;
  onOpen: (sessionId: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pb-2">
        <span className="text-[12px] text-muted-foreground">
          {paused ? (
            <span className="text-warning">
              Paused{pendingCount > 0 && <> · <span className="num font-semibold">{pendingCount}</span> new</>}
            </span>
          ) : (
            "Newest first"
          )}
        </span>
        <Button variant="outline" size="sm" onClick={onTogglePause} aria-pressed={paused} className="h-7 gap-1.5">
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      {passes.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState title="No passes yet today" compact>
            New entries and exits appear here as cameras report them.
          </EmptyState>
        </div>
      ) : (
        <ol className="scrollbar-thin max-h-[440px] flex-1 overflow-y-auto" aria-label="Recent passes">
          {passes.map((p) => {
            const pending = p.match_method === "fuzzy_pending" || p.status === "pending_review";
            return (
              <li key={p.pass_id}>
                <button
                  type="button"
                  disabled={!p.session_id}
                  onClick={() => p.session_id && onOpen(p.session_id)}
                  className={cn(
                    "flex w-full items-center gap-3 border-t px-5 py-2 text-left text-[13px] transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none disabled:cursor-default",
                    freshIds.has(p.pass_id) && "row-flash",
                  )}
                >
                  <span className="num w-[62px] shrink-0 text-[12px] text-muted-foreground">{fmtClock(p.event_at)}</span>
                  <DirectionBadge direction={p.direction} />
                  {!hidePlates && <PlateThumb readId={p.read_id} alt={`Plate crop ${p.plate_norm ?? ""}`} className="hidden h-7 w-[72px] sm:flex" />}
                  <Plate value={p.plate_norm} link={false} hidden={hidePlates} />
                  <ConfidenceBadge value={p.plate_confidence} quality={p.quality} />
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {p.direction === "out" && p.dwell_min != null && (
                      <span className="num text-[12px] text-muted-foreground" title="Dwell">
                        ↔ {fmtDwell(p.dwell_min)}
                      </span>
                    )}
                    {pending ? (
                      <MatchBadge method="fuzzy_pending" />
                    ) : p.direction === "out" ? (
                      p.match_method ? (
                        <MatchBadge method={p.match_method} />
                      ) : (
                        <span className="text-[11.5px] text-muted-foreground">unmatched</span>
                      )
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
