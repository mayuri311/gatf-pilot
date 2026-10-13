import type { Metadata } from "next";
import { headers } from "next/headers";
import { subDays } from "date-fns";
import { LiveDashboard } from "@/components/live/live-dashboard";
import { getSessionUser } from "@/lib/auth";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { fmt, inLot } from "@/lib/format";
import { localDow, todayRange } from "@/lib/range";

export const metadata: Metadata = { title: "Live" };

export default async function LivePage() {
  const [user, supabase, h] = await Promise.all([getSessionUser(), getServerSupabase(), headers()]);
  const now = new Date();
  const { fromIso, toIso, from } = todayRange(now);
  const dow = localDow(now);
  const twoWeeks = { from: subDays(from, 13, { in: inLot }).toISOString(), to: toIso };

  const [snap, series, typical, kpis, daily] = await Promise.all([
    rpc.liveSnapshot(supabase),
    rpc.occupancySeries(supabase, { from: fromIso, to: toIso }, 15),
    rpc.typicalDay(supabase, dow, 8),
    rpc.kpis(supabase, { from: fromIso, to: toIso }),
    rpc.dailyStats(supabase, twoWeeks),
  ]);

  return (
    <LiveDashboard
      initialSnapshot={snap.ok ? snap.data : null}
      snapshotError={snap.ok ? null : snap.error}
      initialSeries={series.ok ? series.data : []}
      seriesError={series.ok ? null : series.error}
      typical={typical.ok ? typical.data : []}
      dowLabel={fmt(now, "EEEE")}
      dayStartMs={from.getTime()}
      kpis={kpis.ok ? kpis.data : null}
      daily={daily.ok ? daily.data : []}
      isAdmin={user?.role === "admin"}
      kiosk={h.get("x-kiosk") === "1"}
      nowIso={now.toISOString()}
    />
  );
}
