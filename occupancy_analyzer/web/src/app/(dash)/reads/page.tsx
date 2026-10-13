import type { Metadata } from "next";
import { Download } from "lucide-react";
import { getServerSupabase } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { rpc } from "@/lib/rpc";
import { resolveRange } from "@/lib/range";
import { appConfig } from "@/lib/config";
import { PageHeader } from "@/components/common/page-header";
import { RangeControls } from "@/components/common/range-controls";
import { Panel } from "@/components/common/panel";
import { EmptyState, ErrorState } from "@/components/common/states";
import { PlateFilter, SelectFilter } from "@/components/tables/filters";
import { ReadsView } from "@/components/tables/reads-view";
import { Pager } from "@/components/tables/pager";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Plate reads" };
const PAGE = 60;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReadsPage({ searchParams }: PageProps<"/reads">) {
  const sp = await searchParams;
  const range = resolveRange(one(sp.preset) ?? "today", one(sp.from), one(sp.to));
  const page = Math.max(1, Number(one(sp.page) ?? 1) || 1);
  const camera = one(sp.camera) ?? null;
  const quality = one(sp.quality) ?? null;
  const plate = one(sp.plate) ?? null;
  const [supabase, user] = await Promise.all([getServerSupabase(), getSessionUser()]);
  const res = await rpc.listReads(supabase, {
    from: range.fromIso,
    to: range.toIso,
    camera,
    quality,
    plate,
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });
  const exportQs = new URLSearchParams({ from: range.fromIso, to: range.toIso });
  if (camera) exportQs.set("camera", camera);
  if (quality) exportQs.set("quality", quality);
  if (plate) exportQs.set("plate", plate);

  return (
    <>
      <PageHeader
        title="Plate reads"
        subtitle="Every finalized plate track from both cameras — table or crop gallery"
        actions={<RangeControls label={range.label} active={range.preset} />}
      />
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <PlateFilter />
          <SelectFilter
            param="camera"
            label="Camera"
            options={appConfig.cameras.map((c) => ({ value: c.camera_id, label: `${c.direction === "in" ? "▶ IN" : "◀ OUT"} · ${c.camera_id}` }))}
          />
          <SelectFilter
            param="quality"
            label="Quality"
            options={[
              { value: "high", label: "● High (≥ 0.90)" },
              { value: "medium", label: "◐ Medium (≥ 0.75)" },
              { value: "low", label: "○ Low" },
            ]}
          />
          <Button asChild variant="outline" size="sm" className="ml-auto h-8 gap-1.5">
            <a href={`/api/export/reads?${exportQs.toString()}`} download>
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
            <EmptyState title="No reads match">Try a wider date range or clear filters.</EmptyState>
          </div>
        ) : (
          <>
            <ReadsView rows={res.data.rows} isAdmin={user?.role === "admin"} />
            <Pager total={res.data.total} pageSize={PAGE} />
          </>
        )}
      </Panel>
    </>
  );
}
