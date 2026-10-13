import { KpiSkeleton } from "@/components/charts/kpi-card";

/** Generic page skeleton (shown while server components fetch RPCs). */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-56 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-muted/70" />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="h-[360px] animate-pulse rounded-[10px] border bg-card lg:col-span-2" />
        <div className="h-[360px] animate-pulse rounded-[10px] border bg-card" />
      </div>
    </div>
  );
}
