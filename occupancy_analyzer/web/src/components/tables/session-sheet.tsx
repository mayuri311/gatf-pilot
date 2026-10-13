"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { rpc, type RpcError, type SessionDetail } from "@/lib/rpc";
import { fmtDateTime, fmtDwell } from "@/lib/format";
import { ErrorState } from "@/components/common/states";
import { FlagBadges, MatchBadge, StatusBadge } from "@/components/common/badges";
import { ReadDetail } from "./read-detail";

/** Session drawer: entry/exit crops, per-char confidence, reads[] timeline, match details. */
export function SessionSheet({ sessionId, onOpenChange }: { sessionId: string | null; onOpenChange: (open: boolean) => void }) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<RpcError | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    rpc.session(getBrowserSupabase(), sessionId).then((r) => {
      if (cancelled) return;
      setLoadedId(sessionId);
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else {
        setData(null);
        setError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const loading = sessionId !== null && loadedId !== sessionId;

  return (
    <Sheet open={!!sessionId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[560px]">
        <SheetHeader className="border-b">
          <SheetTitle>Session</SheetTitle>
          <SheetDescription className="num truncate text-[11px]">{sessionId}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 p-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading session…
            </div>
          )}
          {!loading && error && <ErrorState error={error} compact />}
          {!loading && data && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={data.status} />
                <MatchBadge method={data.match_method} score={data.match_score} />
                <FlagBadges s={data} />
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
                <dt className="text-muted-foreground">Plate</dt>
                <dd>
                  {data.plate_norm ? (
                    <Link href={`/vehicles/${encodeURIComponent(data.plate_norm)}`} className="plate inline-flex items-center gap-1 text-primary hover:underline">
                      {data.plate_norm} <ArrowRight className="size-3" />
                    </Link>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt className="text-muted-foreground">Entry</dt>
                <dd className="num">{fmtDateTime(data.entry_at)}</dd>
                <dt className="text-muted-foreground">Exit</dt>
                <dd className="num">{fmtDateTime(data.exit_at)}</dd>
                <dt className="text-muted-foreground">Dwell</dt>
                <dd className="num font-semibold">{fmtDwell(data.dwell_min)}</dd>
                {data.closed_reason && (
                  <>
                    <dt className="text-muted-foreground">Closed by</dt>
                    <dd>{data.closed_reason}</dd>
                  </>
                )}
              </dl>
              {data.entry_read && <ReadDetail read={data.entry_read} title="Entry read ▶" />}
              {data.exit_read && <ReadDetail read={data.exit_read} title="Exit read ◀" />}
              {data.candidates.length > 0 && (
                <div>
                  <h3 className="eyebrow mb-2 text-muted-foreground">Match candidates</h3>
                  <ul className="space-y-1.5">
                    {data.candidates.map((c, i) => (
                      <li key={i} className="flex items-center gap-3 rounded-md border px-3 py-2 text-[12.5px]">
                        <span className="plate">{c.plate_norm ?? "—"}</span>
                        <span className="num text-muted-foreground">{fmtDateTime(c.entry_at)}</span>
                        <span className="num ml-auto">{c.score?.toFixed(2) ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
