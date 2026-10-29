import type { Metadata } from "next";
import { subDays } from "date-fns";
import { getServerSupabase } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { rpc, type RpcResult } from "@/lib/rpc";
import { PageHeader } from "@/components/common/page-header";
import { HealthView } from "@/components/ops/health-view";

export const metadata: Metadata = { title: "System health" };

function r<T>(res: RpcResult<T>, fallback: T) {
  return res.ok ? { data: res.data, error: null } : { data: fallback, error: res.error };
}

export default async function HealthPage() {
  const [supabase, user] = await Promise.all([getServerSupabase(), getSessionUser()]);
  const isAdmin = user?.role === "admin";
  const now = new Date();
  const q = { from: subDays(now, 7).toISOString(), to: now.toISOString() };
  const [devices, quality, cal, system] = await Promise.all([
    rpc.devices(supabase),
    rpc.dataQuality(supabase, q),
    rpc.calibrationHistory(supabase),
    isAdmin ? rpc.systemStatus(supabase) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader
        title="System health"
        subtitle={`Cameras from heartbeats (every ${appConfig.heartbeat.interval_s} s, offline after ${appConfig.heartbeat.offline_after_s} s), data quality and platform limits`}
      />
      <HealthView
        devices={r(devices, [])}
        quality={r(quality, null)}
        calibrations={r(cal, [])}
        system={system ? r(system, null) : null}
        isAdmin={isAdmin}
        nowIso={now.toISOString()}
      />
    </>
  );
}
