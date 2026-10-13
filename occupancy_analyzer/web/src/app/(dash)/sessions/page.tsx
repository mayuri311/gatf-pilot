import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { resolveRange } from "@/lib/range";
import { SESSION_STATUS_LABEL } from "@/lib/occupancy";
import { PageHeader } from "@/components/common/page-header";
import { RangeControls } from "@/components/common/range-controls";
import { Panel } from "@/components/common/panel";
import { EmptyState, ErrorState } from "@/components/common/states";
import { FacetFilter, PlateFilter } from "@/components/tables/filters";
import { SessionsTable } from "@/components/tables/sessions-table";
import { Pager } from "@/components/tables/pager";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Sessions" };
const PAGE = 50;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const list = (v: string | string[] | undefined) => (one(v) ?? "").split(",").filter(Boolean);

export default async function SessionsPage({ searchParams }: PageProps<"/sessions">) {
  const sp = await searchParams;
  const range = resolveRange(one(sp.preset), one(sp.from), one(sp.to));
  const page = Math.max(1, Number(one(sp.page) ?? 1) || 1);
  const status = list(sp.status);
  const flags = list(sp.flags);
  const plate = one(sp.plate) ?? "";
  const supabase = await getServerSupabase();
  const res = await rpc.listSessions(supabase, {
    from: range.fromIso,
    to: range.toIso,
    status,
    flags,
    plate,
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });

  const exportQs = new URLSearchParams({ from: range.fromIso, to: range.toIso });
  if (status.length) exportQs.set("status", status.join(","));
  if (flags.length) exportQs.set("flags", flags.join(","));
  if (plate) exportQs.set("plate", plate);

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle="Every stay from entry to exit — click a row for crops, confidence and the reads timeline"
        actions={<RangeControls label={range.label} active={range.preset} />}
      />
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <PlateFilter />
          <FacetFilter
            param="status"
            label="Status"
            options={Object.entries(SESSION_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <FacetFilter
            param="flags"
            label="Flags"
            options={[
              { value: "overnight", label: "⏾ Overnight" },
              { value: "multi_day", label: "Multi-day" },
              { value: "suspect_stale", label: "Suspect stale" },
              { value: "bounce", label: "↺ Bounce" },
            ]}
          />
          <Button asChild variant="outline" size="sm" className="ml-auto h-8 gap-1.5">
            <a href={`/api/export/sessions?${exportQs.toString()}`} download>
              <Download className="size-3.5" /> CSV
            </a>
          </Button>
        </div>
        {!res.ok ? (
          <div className="p-5">
            <ErrorState error={res.error} />
          </div>
        ) : res.data.rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No sessions match">
              Try a wider date range or clear filters. <Link href="/sessions" className="text-primary hover:underline">Reset</Link>
            </EmptyState>
          </div>
        ) : (
          <>
            <SessionsTable rows={res.data.rows} />
            <Pager total={res.data.total} pageSize={PAGE} />
          </>
        )}
      </Panel>
    </>
  );
}
