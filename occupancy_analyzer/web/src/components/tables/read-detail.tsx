"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { rpc, type ReadRow } from "@/lib/rpc";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { fmtClock, fmtDateTime } from "@/lib/format";
import { ConfidenceBadge, DirectionBadge, QualityBadge } from "@/components/common/badges";
import { Plate, PlateThumb } from "@/components/common/plate";
import { confClass } from "@/lib/occupancy";

const CONF_COLOR = { high: "var(--success)", medium: "var(--warning)", low: "var(--destructive)" } as const;

/** Per-character confidence bars under each plate character. */
export function CharConfidence({ plate, conf }: { plate: string; conf: (number | null)[] }) {
  const chars = plate.split("");
  return (
    <div className="flex gap-1.5" role="list" aria-label="Per-character confidence">
      {chars.map((ch, i) => {
        const c = conf[i] ?? null;
        const cls = confClass(c);
        return (
          <div key={i} role="listitem" className="flex w-7 flex-col items-center gap-1" title={`${ch}: ${c == null ? "—" : c.toFixed(3)}`}>
            <span className="plate flex h-8 w-7 items-center justify-center rounded border bg-muted/40 text-[15px]">{ch}</span>
            <span className="relative h-10 w-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span
                className="absolute inset-x-0 bottom-0 rounded-full"
                style={{ height: `${Math.max(4, (c ?? 0) * 100)}%`, background: CONF_COLOR[cls] }}
              />
            </span>
            <span className="num text-[10px] text-muted-foreground">{c == null ? "—" : Math.round(c * 100)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** reads[] timeline: one tick per frame, height = confidence, colour = agrees with consensus. */
export function ReadsTimeline({ read }: { read: ReadRow }) {
  const frames = read.reads.filter((r) => r.frame_index != null);
  if (frames.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        Per-frame reads are not included here{read.alternates.length ? " — alternates shown below" : ""}. (Kept for 7 days.)
      </p>
    );
  }
  const consensus = read.plate_norm ?? read.plate_raw ?? "";
  const counts = new Map<string, number>();
  for (const f of frames) if (f.text) counts.set(f.text, (counts.get(f.text) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return (
    <div className="space-y-3">
      <div className="flex h-16 items-end gap-px rounded-md border bg-muted/20 p-1.5" aria-label={`${frames.length} frames`}>
        {frames.map((f, i) => (
          <span
            key={i}
            className="flex-1 rounded-t-[1px]"
            title={`frame ${f.frame_index}: ${f.text || "∅"} (${f.confidence?.toFixed(2) ?? "—"})`}
            style={{
              height: `${Math.max(6, (f.confidence ?? 0) * 100)}%`,
              background: !f.text ? "var(--muted-foreground)" : f.text === consensus ? "var(--chart-1)" : "var(--chart-4)",
              opacity: f.text ? 0.9 : 0.25,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-chart-1" />matches consensus</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-chart-4" />different text</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-muted-foreground/30" />no text</span>
      </div>
      <ul className="space-y-1">
        {top.map(([text, n]) => (
          <li key={text} className="flex items-center gap-2 text-[12.5px]">
            <span className={cn("plate", text === consensus ? "text-primary" : "text-foreground/80")}>{text}</span>
            <span className="h-1.5 flex-1 rounded-full bg-muted">
              <span className="block h-full rounded-full bg-chart-1/70" style={{ width: `${(n / frames.length) * 100}%` }} />
            </span>
            <span className="num w-14 text-right text-muted-foreground">{n} fr</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReadDetail({ read, title }: { read: ReadRow; title?: string }) {
  const plate = read.plate_norm ?? read.plate_raw ?? "";
  return (
    <section className="space-y-4" aria-label={title ?? "Read"}>
      {title && <h3 className="eyebrow text-muted-foreground">{title}</h3>}
      <PlateThumb readId={read.read_id} alt={`Crop of plate ${plate}`} className="h-24 w-full max-w-[340px] rounded-md" />
      <div className="flex flex-wrap items-center gap-2">
        <Plate value={read.plate_norm} />
        {read.plate_raw && read.plate_raw !== read.plate_norm && (
          <span className="text-[12px] text-muted-foreground">
            raw <span className="plate">{read.plate_raw}</span>
          </span>
        )}
        <DirectionBadge direction={read.direction} />
        <QualityBadge quality={read.quality} />
        <ConfidenceBadge value={read.plate_confidence} quality={read.quality} />
        {read.corrected && <span className="rounded border border-primary/30 bg-primary/10 px-1.5 text-[11px] text-primary">corrected</span>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
        <dt className="text-muted-foreground">Time</dt>
        <dd className="num">{fmtDateTime(read.event_at)} <span className="text-muted-foreground">({fmtClock(read.event_at)} ET)</span></dd>
        <dt className="text-muted-foreground">Camera</dt>
        <dd className="num">{read.camera_id ?? "—"}</dd>
        {read.num_frames_used != null && (
          <>
            <dt className="text-muted-foreground">Frames used</dt>
            <dd className="num">{read.num_frames_used}</dd>
          </>
        )}
      </dl>
      {plate && read.plate_confidence_per_char.length > 0 && <CharConfidence plate={plate} conf={read.plate_confidence_per_char} />}
      <div>
        <h4 className="mb-2 text-[12px] font-medium text-muted-foreground">Per-frame reads</h4>
        <ReadsTimeline read={read} />
      </div>
      {read.alternates.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">Alternates</h4>
          <ul className="flex flex-wrap gap-1.5">
            {read.alternates.map((a) => (
              <li key={a.text} className="rounded border bg-muted/40 px-1.5 py-0.5 text-[12px]">
                <span className="plate">{a.text}</span> <span className="num text-muted-foreground">{a.weight?.toFixed(2) ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** ReadDetail that upgrades a list row to the full read (per-frame timeline) via get_read. */
export function ReadDetailLoader({ read, title }: { read: ReadRow; title?: string }) {
  const [full, setFull] = useState<{ id: string; read: ReadRow } | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.read(getBrowserSupabase(), read.read_id).then((r) => {
      if (!cancelled && r.ok && r.data) setFull({ id: read.read_id, read: r.data });
    });
    return () => {
      cancelled = true;
    };
  }, [read.read_id]);
  return <ReadDetail read={full?.id === read.read_id ? full.read : read} title={title} />;
}
