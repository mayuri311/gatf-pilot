"use client";

import { useState } from "react";
import type { SessionRow } from "@/lib/rpc";
import { fmtDateTime, fmtDwell } from "@/lib/format";
import { FlagBadges, MatchBadge, StatusBadge } from "@/components/common/badges";
import { Plate, PlateThumb } from "@/components/common/plate";
import { DataGrid, type GridColumn } from "./data-grid";
import { SessionSheet } from "./session-sheet";

const COLUMNS: GridColumn<SessionRow>[] = [
  { id: "entry", header: "Entry (ET)", cell: (s) => <span className="num text-[12.5px]">{fmtDateTime(s.entry_at)}</span> },
  { id: "exit", header: "Exit (ET)", cell: (s) => <span className="num text-[12.5px] text-muted-foreground">{fmtDateTime(s.exit_at)}</span> },
  { id: "dwell", header: "Dwell", align: "right", cell: (s) => <span className="num font-medium">{fmtDwell(s.dwell_min)}</span> },
  {
    id: "plate",
    header: "Plate",
    cell: (s) => (
      <span className="flex items-center gap-2">
        <PlateThumb readId={s.entry_read_id ?? s.exit_read_id} alt={`Crop ${s.plate_norm ?? ""}`} className="hidden h-6 w-16 md:flex" />
        <Plate value={s.plate_norm} />
        {s.exit_plate && s.exit_plate !== s.plate_norm && <span className="plate text-[11px] text-muted-foreground" title="Exit read">↔ {s.exit_plate}</span>}
      </span>
    ),
  },
  { id: "status", header: "Status", cell: (s) => <StatusBadge status={s.status} /> },
  { id: "match", header: "Match", hideBelow: "md", cell: (s) => <MatchBadge method={s.match_method} score={s.match_score} /> },
  { id: "flags", header: "Flags", hideBelow: "lg", cell: (s) => <FlagBadges s={s} /> },
];

export function SessionsTable({ rows }: { rows: SessionRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <DataGrid
        rows={rows}
        columns={COLUMNS}
        getRowId={(s) => s.session_id}
        onRowClick={(s) => setOpen(s.session_id)}
        rowLabel={(s) => `Session ${s.plate_norm ?? ""} entered ${fmtDateTime(s.entry_at)}`}
      />
      <SessionSheet sessionId={open} onOpenChange={(o) => !o && setOpen(null)} />
    </>
  );
}
