import { cookies, headers } from "next/headers";
import { AppShell } from "@/components/shell/app-shell";
import { requireUser, initials, displayName } from "@/lib/auth";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc, dataOr } from "@/lib/rpc";
import { appConfig } from "@/lib/config";

export default async function DashLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const [cookieStore, h, supabase] = await Promise.all([cookies(), headers(), getServerSupabase()]);
  const kiosk = h.get("x-kiosk") === "1";

  const [alertsRes, reviewRes] = kiosk
    ? [null, null]
    : // Shell badges must never block a page: short cutoff, counts are best-effort.
      await Promise.all([rpc.alerts(supabase, undefined, { timeoutMs: 1500 }), rpc.reviewCount(supabase, undefined, { timeoutMs: 1500 })]);
  const alerts = alertsRes ? dataOr(alertsRes, []) : [];
  const reviewCount = reviewRes ? dataOr(reviewRes, 0) : 0;

  return (
    <AppShell
      user={{ email: user.email, name: displayName(user.email), initials: initials(user.email), role: user.role }}
      counts={{ review: reviewCount, alerts: alerts.filter((a) => !a.acked).length }}
      alerts={alerts}
      aiEnabled={appConfig.ai.enabled}
      kiosk={kiosk}
      initialCollapsed={cookieStore.get("gatf_sidebar_collapsed")?.value === "1"}
    >
      {children}
    </AppShell>
  );
}
