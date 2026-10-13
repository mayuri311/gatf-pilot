import type { Metadata } from "next";
import { getServerSupabase } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { rpc } from "@/lib/rpc";
import { PageHeader } from "@/components/common/page-header";
import { Panel } from "@/components/common/panel";
import { ErrorState } from "@/components/common/states";
import { AlertsList } from "@/components/ops/alerts-list";

export const metadata: Metadata = { title: "Alerts" };

export default async function AlertsPage() {
  const [supabase, user] = await Promise.all([getServerSupabase(), getSessionUser()]);
  const res = await rpc.alerts(supabase);
  const open = res.ok ? res.data.filter((a) => !a.acked).length : 0;
  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={`In-app only — no emails or push. ${res.ok ? `${open} open · ${res.data.length - open} acknowledged` : ""}`}
      />
      <Panel>{res.ok ? <AlertsList alerts={res.data} isAdmin={user?.role === "admin"} /> : <div className="p-5"><ErrorState error={res.error} /></div>}</Panel>
    </>
  );
}
