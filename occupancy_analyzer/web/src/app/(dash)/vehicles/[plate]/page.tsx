import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CalendarClock, Clock3, MoonStar, Repeat } from "lucide-react";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";
import { fmtDateTime, fmtDwell, fmtInt } from "@/lib/format";
import { PageHeader } from "@/components/common/page-header";
import { Panel, PanelHeader } from "@/components/common/panel";
import { ErrorState, EmptyState } from "@/components/common/states";
import { SessionsTable } from "@/components/tables/sessions-table";
import { VehicleCharts } from "@/components/tables/vehicle-charts";
import { Button } from "@/components/ui/button";

export async function generateMetadata({ params }: PageProps<"/vehicles/[plate]">): Promise<Metadata> {
  const { plate } = await params;
  return { title: `Vehicle ${decodeURIComponent(plate).toUpperCase()}` };
}

function Stat({ icon: Icon, label, value, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border bg-card p-4">
      <span className="icon-tile" style={{ ["--tile" as string]: tone }} aria-hidden>
        <Icon className="size-[18px]" />
      </span>
      <div>
        <p className="text-[12px] text-muted-foreground">{label}</p>
        <p className="num text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}

export default async function VehiclePage({ params }: PageProps<"/vehicles/[plate]">) {
  const { plate: raw } = await params;
  const plate = decodeURIComponent(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const supabase = await getServerSupabase();
  const res = await rpc.vehicleProfile(supabase, plate);

  const back = (
    <Button asChild variant="outline" size="sm" className="gap-1.5">
      <Link href="/sessions">
        <ArrowLeft className="size-3.5" /> Sessions
      </Link>
    </Button>
  );

  if (!res.ok) {
    return (
      <>
        <PageHeader title={plate} subtitle="Vehicle profile" actions={back} />
        <ErrorState error={res.error} />
      </>
    );
  }
  const v = res.data;
  return (
    <>
      <PageHeader
        title={`Vehicle ${v.plate_norm}`}
        subtitle={
          <>
            First seen {fmtDateTime(v.first_seen)} · last seen {fmtDateTime(v.last_seen)} · profile views are audit-logged
          </>
        }
        actions={back}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="plate rounded-md border-2 border-foreground/25 bg-foreground/[0.04] px-3 py-1 text-2xl">{v.plate_norm}</span>
        {v.aliases.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            also read as
            {v.aliases.map((a) => (
              <Link key={a} href={`/vehicles/${encodeURIComponent(a)}`} className="plate rounded border bg-muted/40 px-1.5 py-0.5 text-foreground/80 hover:border-primary/40">
                {a}
              </Link>
            ))}
          </span>
        )}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={Repeat} label="Visits" value={fmtInt(v.visits)} tone="var(--chart-1)" />
        <Stat icon={Clock3} label="Avg dwell" value={fmtDwell(v.avg_dwell_min)} tone="var(--chart-3)" />
        <Stat icon={CalendarClock} label="Usual arrival" value={v.usual_arrival_hour != null ? `${String(v.usual_arrival_hour).padStart(2, "0")}:00 ET` : "—"} tone="var(--chart-2)" />
        <Stat icon={MoonStar} label="Overnight stays" value={fmtInt(v.overnight_count)} tone="var(--chart-4)" />
      </div>
      <VehicleCharts sessions={v.sessions} usualHour={v.usual_arrival_hour} />
      <Panel className="mt-5">
        <PanelHeader title="Visit history" subtitle={`${v.sessions.length} sessions · click for crops and reads`} />
        <div className="mt-3">
          {v.sessions.length ? <SessionsTable rows={v.sessions} /> : <div className="p-5"><EmptyState title="No sessions" /></div>}
        </div>
      </Panel>
    </>
  );
}
