"use client";

import { cn } from "@/lib/utils";
import type { ConnState } from "@/lib/realtime/useLotChannel";
import type { DeviceRow } from "@/lib/rpc";
import { fmtAge } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const CONN = {
  live: { label: "Live", cls: "text-success border-success/30 bg-success/10", dot: "bg-success pulse-dot" },
  connecting: { label: "Connecting…", cls: "text-muted-foreground border-border bg-muted/40", dot: "bg-muted-foreground" },
  reconnecting: { label: "Reconnecting…", cls: "text-warning border-warning/30 bg-warning/10", dot: "bg-warning" },
  offline: { label: "Offline · polling", cls: "text-destructive border-destructive/30 bg-destructive/10", dot: "bg-destructive" },
} as const;

export function ConnectionPill({ state }: { state: ConnState }) {
  const c = CONN[state];
  return (
    <span className={cn("inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-[12px] font-medium", c.cls)}>
      <span className={cn("size-1.5 rounded-full", c.dot)} style={{ color: "var(--success)" }} aria-hidden />
      {c.label}
    </span>
  );
}

export function deviceHealth(d: DeviceRow): "ok" | "warn" | "down" {
  if (!d.online) return "down";
  if (!d.camera_connected || (d.status && d.status !== "ok")) return "warn";
  return "ok";
}

export function DeviceChip({ device, now }: { device: DeviceRow; now: Date }) {
  const h = deviceHealth(device);
  const dir = device.direction === "out" ? "OUT" : device.direction === "in" ? "IN" : device.device_id;
  const tone =
    h === "ok"
      ? "border-border text-foreground/85"
      : h === "warn"
        ? "border-warning/40 text-warning bg-warning/5"
        : "border-destructive/40 text-destructive bg-destructive/5";
  const dot = h === "ok" ? "bg-success" : h === "warn" ? "bg-warning" : "bg-destructive";
  const text =
    h === "down"
      ? device.last_seen
        ? `offline ${fmtAge(device.last_seen, now)}`
        : "no heartbeat yet"
      : `last read ${fmtAge(device.last_read_at ?? device.last_event_at, now)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("inline-flex h-7 items-center gap-2 rounded-full border bg-card px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring", tone)}>
          <span className="num font-semibold">{device.direction === "out" ? "◀" : "▶"} {dir}</span>
          <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
          <span className="sr-only">{h === "ok" ? "online" : h === "warn" ? "degraded" : "offline"}</span>
          <span className="num text-muted-foreground">{text}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-[12px]">
        <div className="num space-y-0.5">
          <div>{device.device_id} · {device.camera_id}</div>
          <div>status {device.status ?? "—"} · camera {device.camera_connected ? "connected" : "DISCONNECTED"}</div>
          <div>fps {device.fps ?? "—"} · backlog {device.pending_uploads ?? 0}</div>
          <div>heartbeat {fmtAge(device.last_seen, now)} ago</div>
          {device.message && <div>“{device.message}”</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
