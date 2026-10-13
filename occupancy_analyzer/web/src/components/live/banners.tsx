import Link from "next/link";
import { Scale, TriangleAlert, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReconcileBanner({ reasons, isAdmin }: { reasons: string[]; isAdmin: boolean }) {
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-[10px] border border-warning/35 bg-warning/[0.07] px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning">
        <TriangleAlert className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">Reconcile recommended</p>
        <p className="text-[12.5px] text-muted-foreground">{reasons.length ? reasons.join(" · ") : "The estimate may have drifted from reality."}</p>
      </div>
      {isAdmin ? (
        <Button asChild size="sm" className="h-8 gap-1.5">
          <Link href="/admin/reconcile">
            <Scale className="size-3.5" /> Reconcile now
          </Link>
        </Button>
      ) : (
        <span className="text-[12px] text-muted-foreground">An admin needs to reconcile.</span>
      )}
    </div>
  );
}

export function CameraOfflineBanner({ names }: { names: string[] }) {
  return (
    <div role="alert" className="mb-6 flex items-center gap-3 rounded-[10px] border border-destructive/35 bg-destructive/[0.07] px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/15 text-destructive">
        <VideoOff className="size-4" />
      </span>
      <div>
        <p className="text-[14px] font-semibold">Camera offline</p>
        <p className="text-[12.5px] text-muted-foreground">{names.join(" · ")} — occupancy may be missing passes until it recovers.</p>
      </div>
    </div>
  );
}
