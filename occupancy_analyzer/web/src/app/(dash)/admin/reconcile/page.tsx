import type { Metadata } from "next";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { PageHeader } from "@/components/common/page-header";
import { Panel, PanelHeader } from "@/components/common/panel";
import { ErrorState, EmptyState } from "@/components/common/states";
import { UrlTabs } from "@/components/common/range-controls";
import { ReconcileFlow } from "@/components/admin/reconcile-flow";

export const metadata: Metadata = { title: "Reconcile" };

export default async function ReconcilePage({ searchParams }: PageProps<"/admin/reconcile">) {
  const sp = await searchParams;
  const tab = sp.tab === "history" ? "history" : "count";
  const supabase = await getServerSupabase();
  const [snap, hist] = await Promise.all([
    tab === "count" ? rpc.liveSnapshot(supabase) : Promise.resolve(null),
    tab === "history" ? rpc.calibrationHistory(supabase) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title="Reconcile occupancy" subtitle="Re-anchor the estimate to a visual count and clear ghost sessions — designed for a phone" />
      <div className="mb-6">
        <UrlTabs tabs={[{ id: "count", label: "New count" }, { id: "history", label: "History" }]} value={tab} />
      </div>
      {tab === "count" ? (
        <ReconcileFlow currentEstimate={snap?.ok ? snap.data.occupancy : null} />
      ) : !hist?.ok ? (
        hist && <ErrorState error={hist.error} />
      ) : hist.data.length === 0 ? (
        <EmptyState title="No reconciliations yet" />
      ) : (
        <Panel>
          <PanelHeader title="Past reconciliations" subtitle="Residual = estimate before − visual count" />
          <div className="scrollbar-thin mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-[11.5px] text-muted-foreground uppercase">
                  {["When (ET)", "Count", "Estimate", "Residual", "Closed", "By", "Note"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium first:pl-5">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hist.data.map((c) => (
                  <tr key={c.at} className="border-b border-border/60 last:border-0">
                    <td className="num px-3 py-2.5 pl-5 whitespace-nowrap">{fmtDateTime(c.at)}</td>
                    <td className="num px-3">{fmtInt(c.visual_count)}</td>
                    <td className="num px-3">{fmtInt(c.estimate_before)}</td>
                    <td className="num px-3 font-semibold">{c.residual == null ? "—" : c.residual > 0 ? `+${c.residual}` : c.residual}</td>
                    <td className="num px-3">{fmtInt(c.closed_count)}</td>
                    <td className="px-3 text-muted-foreground">{c.actor_email ?? "—"}</td>
                    <td className="max-w-[280px] truncate px-3 text-muted-foreground">{c.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
