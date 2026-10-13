"use client";

import { useMemo, useState } from "react";
import type { AuditRow } from "@/lib/rpc";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const actions = useMemo(() => [...new Set(rows.map((r) => r.action))].sort(), [rows]);
  const [action, setAction] = useState<string>("");
  const [q, setQ] = useState("");
  const shown = rows.filter(
    (r) =>
      (!action || r.action === action) &&
      (!q || `${r.actor_email} ${r.target} ${JSON.stringify(r.detail ?? "")}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <label className="flex h-8 items-center gap-1.5 rounded-md border bg-card pl-2.5 text-[12.5px] text-muted-foreground">
          Action
          <select value={action} onChange={(e) => setAction(e.target.value)} className="h-full bg-transparent pr-2 text-foreground outline-none">
            <option value="">All</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter actor, target, detail…"
          aria-label="Filter audit log"
          className="h-8 w-64 rounded-md border bg-card px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="num ml-auto text-[12px] text-muted-foreground">{shown.length} of {rows.length}</span>
      </div>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b text-left text-[11.5px] text-muted-foreground uppercase">
              {["When (ET)", "Actor", "Action", "Target", "Detail"].map((h) => (
                <th key={h} scope="col" className="px-3 py-2.5 font-medium first:pl-5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-b border-border/60 align-top last:border-0">
                <td className="num px-3 py-2 pl-5 whitespace-nowrap">{fmtDateTime(r.at)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.actor_email ?? "system"}</td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[11px]",
                      /reconcile|resolve|correct|role|deactivate|create|reset/.test(r.action) ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {r.action}
                  </span>
                </td>
                <td className="plate px-3 py-2 text-[12px] font-normal tracking-normal">{r.target ?? ""}</td>
                <td className="max-w-[420px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={JSON.stringify(r.detail ?? {})}>
                  {r.detail && Object.keys(r.detail as object).length ? JSON.stringify(r.detail) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
