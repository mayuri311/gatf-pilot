"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { parseAsString, useQueryState } from "nuqs";
import { LayoutGrid, Rows3 } from "lucide-react";
import type { ReadRow } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { fmtClock, fmtDateTime } from "@/lib/format";
import { ConfidenceBadge, DirectionBadge, QualityBadge } from "@/components/common/badges";
import { Plate, PlateThumb } from "@/components/common/plate";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DataGrid, type GridColumn } from "./data-grid";
import { ReadDetailLoader } from "./read-detail";
import { CorrectPlate } from "./correct-plate";

const COLUMNS: GridColumn<ReadRow>[] = [
  { id: "time", header: "Time (ET)", cell: (r) => <span className="num text-[12.5px]">{fmtDateTime(r.event_at)}<span className="text-muted-foreground">:{fmtClock(r.event_at).slice(-2)}</span></span> },
  { id: "dir", header: "Dir", cell: (r) => <DirectionBadge direction={r.direction} /> },
  { id: "crop", header: "Crop", hideBelow: "sm", cell: (r) => <PlateThumb readId={r.read_id} alt={`Crop ${r.plate_norm ?? ""}`} className="h-7 w-20" /> },
  {
    id: "plate",
    header: "Plate",
    cell: (r) => (
      <span className="flex items-center gap-2">
        <Plate value={r.plate_norm} />
        {r.corrected && <span className="text-[10.5px] text-primary">corrected</span>}
      </span>
    ),
  },
  { id: "conf", header: "Confidence", cell: (r) => <ConfidenceBadge value={r.plate_confidence} quality={r.quality} /> },
  { id: "quality", header: "Quality", hideBelow: "md", cell: (r) => <QualityBadge quality={r.quality} /> },
  { id: "camera", header: "Camera", hideBelow: "lg", cell: (r) => <span className="num text-[12px] text-muted-foreground">{r.camera_id}</span> },
];

export function ReadsView({ rows, isAdmin }: { rows: ReadRow[]; isAdmin: boolean }) {
  const [, startTransition] = useTransition();
  const [view, setView] = useQueryState("view", parseAsString.withDefault("table").withOptions({ startTransition }));
  const [open, setOpen] = useState<ReadRow | null>(null);
  const router = useRouter();

  return (
    <>
      <div className="flex items-center justify-end gap-1 px-5 pt-3" role="group" aria-label="View">
        {(
          [
            ["table", Rows3, "Table"],
            ["gallery", LayoutGrid, "Gallery"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            onClick={() => setView(id === "table" ? null : id)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground",
              view === id && "bg-muted text-foreground",
            )}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>
      {view === "gallery" ? (
        <ul className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6" aria-label="Plate crops">
          {rows.map((r) => (
            <li key={r.read_id}>
              <button
                type="button"
                onClick={() => setOpen(r)}
                className="group w-full overflow-hidden rounded-lg border bg-muted/20 text-left transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <PlateThumb readId={r.read_id} alt={`Crop ${r.plate_norm ?? ""}`} className="h-20 w-full rounded-none border-0 border-b" />
                <div className="space-y-1.5 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Plate value={r.plate_norm} link={false} />
                    <DirectionBadge direction={r.direction} />
                  </div>
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="num text-muted-foreground">{fmtDateTime(r.event_at)}</span>
                    <ConfidenceBadge value={r.plate_confidence} quality={r.quality} />
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <DataGrid rows={rows} columns={COLUMNS} getRowId={(r) => r.read_id} onRowClick={setOpen} rowLabel={(r) => `Read ${r.plate_norm ?? ""} at ${fmtDateTime(r.event_at)}`} />
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-[520px]">
          <SheetHeader className="border-b">
            <SheetTitle>Plate read</SheetTitle>
            <SheetDescription className="num truncate text-[11px]">{open?.read_id}</SheetDescription>
          </SheetHeader>
          {open && (
            <div className="space-y-4 p-4">
              <ReadDetailLoader read={open} />
              {isAdmin ? (
                <CorrectPlate readId={open.read_id} current={open.plate_norm} onDone={() => router.refresh()} />
              ) : (
                <p className="text-[12px] text-muted-foreground">Plate corrections are admin-only.</p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
