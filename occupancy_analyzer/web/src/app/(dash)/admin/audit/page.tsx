import type { Metadata } from "next";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { PageHeader } from "@/components/common/page-header";
import { Panel } from "@/components/common/panel";
import { EmptyState, ErrorState } from "@/components/common/states";
import { AuditTable } from "@/components/admin/audit-table";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  const res = await rpc.auditLog(await getServerSupabase(), 500);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Plate searches, profile and image views, exports, overrides, reconciliations and user changes — latest 500" />
      <Panel>
        {!res.ok ? (
          <div className="p-5"><ErrorState error={res.error} /></div>
        ) : res.data.length === 0 ? (
          <div className="p-5"><EmptyState title="Nothing logged yet" /></div>
        ) : (
          <AuditTable rows={res.data} />
        )}
      </Panel>
    </>
  );
}
