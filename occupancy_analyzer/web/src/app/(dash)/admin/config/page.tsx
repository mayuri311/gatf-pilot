import type { Metadata } from "next";
import { GitBranch } from "lucide-react";
import { appConfig } from "@/lib/config";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { fmtDateTime } from "@/lib/format";
import { PageHeader } from "@/components/common/page-header";
import { Panel, PanelBody, PanelHeader } from "@/components/common/panel";

export const metadata: Metadata = { title: "Config" };

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-border/60">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-4 py-2 text-[13px]">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="num text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type DbLot = { capacity: number; config_synced_at: string | null } | null;

export default async function ConfigPage() {
  const supabase = await getServerSupabase();
  let dbLot: DbLot = null;
  let history: { capacity: number; valid_from: string }[] = [];
  let dbCams: { camera_id: string; active: boolean }[] = [];
  let dbError: string | null = null;
  try {
    const admin = getAdminSupabase();
    const [lot, hist, cams] = await Promise.all([
      admin.from("lots").select("capacity, config_synced_at").eq("lot_id", appConfig.lot.lot_id).maybeSingle(),
      admin.from("lot_capacity_history").select("capacity, valid_from").eq("lot_id", appConfig.lot.lot_id).order("valid_from", { ascending: false }).limit(20),
      admin.from("cameras").select("camera_id, active").eq("lot_id", appConfig.lot.lot_id),
    ]);
    dbLot = (lot.data as DbLot) ?? null;
    history = (hist.data as typeof history) ?? [];
    dbCams = (cams.data as typeof dbCams) ?? [];
    dbError = lot.error?.message ?? hist.error?.message ?? null;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
  const sys = await rpc.systemStatus(supabase);
  const inSync = dbLot ? dbLot.capacity === appConfig.lot.capacity : null;

  return (
    <>
      <PageHeader title="Config" subtitle="Read-only view of config/config.yaml as synced to the database at build time" />
      <div className="mb-5 flex items-start gap-3 rounded-[10px] border bg-card px-4 py-3 text-[13px]">
        <GitBranch className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          To change: edit <span className="font-mono text-[12.5px]">config/config.yaml</span> → push → Vercel redeploys (the pre-build step{" "}
          <span className="font-mono text-[12.5px]">scripts/sync-config.ts</span> upserts lots &amp; cameras and appends capacity history).
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Lot" subtitle={`Parsed ${fmtDateTime(appConfig.generated_at)} ET from ${appConfig.source}`} />
          <PanelBody>
            <KV
              rows={[
                ["lot_id", appConfig.lot.lot_id],
                ["Name", appConfig.lot.name],
                ["Capacity (yaml)", appConfig.lot.capacity],
                ["Capacity (database)", dbLot ? `${dbLot.capacity}${inSync === false ? " ⚠ differs" : ""}` : "—"],
                ["Effective capacity", `${Math.round(appConfig.lot.effective_pct * 100)}% (${Math.round(appConfig.lot.capacity * appConfig.lot.effective_pct)})`],
                ["Timezone", appConfig.lot.timezone],
                ["Last DB sync", dbLot?.config_synced_at ? fmtDateTime(dbLot.config_synced_at) : sys.ok ? fmtDateTime(sys.data.last_config_sync) : "—"],
              ]}
            />
            {dbError && <p className="mt-3 text-[12px] text-warning">Database read: {dbError}</p>}
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Cameras & devices" />
          <PanelBody>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-[11.5px] text-muted-foreground uppercase">
                  <th scope="col" className="py-2 font-medium">Camera</th>
                  <th scope="col" className="py-2 font-medium">Direction</th>
                  <th scope="col" className="py-2 font-medium">Device</th>
                  <th scope="col" className="py-2 text-right font-medium">In DB</th>
                </tr>
              </thead>
              <tbody>
                {appConfig.cameras.map((c) => {
                  const db = dbCams.find((d) => d.camera_id === c.camera_id);
                  return (
                    <tr key={c.camera_id} className="num border-b border-border/60 last:border-0">
                      <td className="py-2">{c.camera_id}</td>
                      <td>{c.direction === "in" ? "▶ in" : "◀ out"}</td>
                      <td>{c.device_id}</td>
                      <td className="text-right">{db ? (db.active ? "● active" : "○ inactive") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Heartbeat, retention & AI" />
          <PanelBody>
            <KV
              rows={[
                ["Heartbeat interval", `${appConfig.heartbeat.interval_s} s`],
                ["Offline after", `${appConfig.heartbeat.offline_after_s} s`],
                ["Plate text kept", `${appConfig.retention.plate_text_days} days, then pseudonym`],
                ["Crops kept", `${appConfig.retention.crop_days} days`],
                ["Full per-frame reads", `${appConfig.retention.reads_full_days} days`],
                ["Storage bucket", appConfig.storage.bucket],
                ["AI chat", appConfig.ai.enabled ? "enabled" : "disabled"],
                ["AI provider / model", `${appConfig.ai.provider} · ${appConfig.ai.model}`],
                ["Bootstrap admin", appConfig.auth.bootstrap_admin_email ?? "—"],
              ]}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Capacity history" subtitle="Historical % full uses the capacity in force at the time" />
          <PanelBody>
            {history.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No capacity history rows.</p>
            ) : (
              <KV rows={history.map((h) => [fmtDateTime(h.valid_from), h.capacity] as [string, React.ReactNode])} />
            )}
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
