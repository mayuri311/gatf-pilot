"use client";

import { useOptimistic, useTransition } from "react";
import { BellOff, Check, Lock } from "lucide-react";
import { toast } from "sonner";
import type { AlertRow } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { fmtAge, fmtDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { SeverityBadge } from "@/components/common/badges";
import { EmptyState } from "@/components/common/states";
import { ackAlertAction } from "@/app/actions/ops";

const ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function AlertsList({ alerts, isAdmin }: { alerts: AlertRow[]; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [acked, addAck] = useOptimistic<string[], string>([], (s, k) => [...s, k]);
  const rows = [...alerts]
    .map((a) => ({ ...a, acked: a.acked || acked.includes(a.key) }))
    .sort((a, b) => Number(a.acked) - Number(b.acked) || ORDER[a.severity] - ORDER[b.severity]);
  if (rows.length === 0) return <EmptyState icon={BellOff} title="All clear">No active alerts. Rules are evaluated live from heartbeats, occupancy and data quality.</EmptyState>;
  return (
    <ul className="divide-y">
      {rows.map((a) => (
        <li key={a.key} className={cn("flex flex-wrap items-start gap-4 px-5 py-4", a.acked && "opacity-60")}>
          <SeverityBadge severity={a.severity} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium">{a.title}</p>
            {a.detail && <p className="mt-0.5 text-[13px] text-muted-foreground">{a.detail}</p>}
            <p className="num mt-1 text-[11.5px] text-muted-foreground">
              since {fmtDateTime(a.since)} ET ({fmtAge(a.since)}) · <span className="font-mono">{a.key}</span>
            </p>
          </div>
          {a.acked ? (
            <span className="flex items-center gap-1 text-[12px] text-success">
              <Check className="size-3.5" /> Acknowledged
            </span>
          ) : isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  addAck(a.key);
                  const r = await ackAlertAction(a.key);
                  if (r.ok) toast.success("Alert acknowledged");
                  else toast.error(r.error);
                })
              }
            >
              Acknowledge
            </Button>
          ) : (
            <span className="flex items-center gap-1 text-[12px] text-muted-foreground" title="Only admins acknowledge alerts">
              <Lock className="size-3.5" /> admin only
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
