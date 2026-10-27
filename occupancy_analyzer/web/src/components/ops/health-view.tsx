"use client";

import { Camera, CameraOff, Cpu, Database, HardDrive } from "lucide-react";
import type { Calibration, DataQuality, DeviceRow, EdgeMetrics, RpcError, SystemStatus } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { fmtAge, fmtBytes, fmtDateTime, fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { Panel, PanelBody, PanelHeader } from "@/components/common/panel";
import { ErrorState, EmptyState } from "@/components/common/states";
import { ChartCard } from "@/components/charts/kit";
import { SimpleLine } from "@/components/charts/line-simple";
import { Donut } from "@/components/charts/donut";
import { deviceHealth } from "@/components/live/connection";

type R<T> = { data: T; error: RpcError | null };

function Row({ k, v, warn }: { k: string; v: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-[12.5px] last:border-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("num text-right", warn && "font-semibold text-warning")}>{v}</dd>
    </div>
  );
}

/** Jetson system figures from the heartbeat's metrics snapshot (scripts/sysmetrics.py). */
function EdgeSystem({ m, now }: { m: EdgeMetrics; now: Date }) {
  const ramPct = m.ram_used_mb != null && m.ram_total_mb ? m.ram_used_mb / m.ram_total_mb : null;
  const ssdPct = m.ssd_free_gb != null && m.ssd_total_gb ? m.ssd_free_gb / m.ssd_total_gb : null;
  const staleMs = m.sampled_at_utc ? now.getTime() - new Date(m.sampled_at_utc).getTime() : null;
  return (
    <div className="mt-4">
      <p className="eyebrow mb-1 text-muted-foreground">
        Edge system{staleMs != null && ` · sampled ${fmtAge(m.sampled_at_utc, now)} ago`}
      </p>
      <dl>
        <Row k="CPU" v={m.cpu_pct != null ? `${fmtNum(m.cpu_pct, 0)}% avg · ${fmtNum(m.cpu_max_core_pct, 0)}% max core` : "—"} warn={(m.cpu_pct ?? 0) > 90} />
        <Row k="GPU" v={m.gpu_pct != null ? `${fmtNum(m.gpu_pct, 0)}%` : "—"} />
        <Row k="RAM" v={m.ram_used_mb != null ? `${fmtInt(m.ram_used_mb)} / ${fmtInt(m.ram_total_mb)} MB` : "—"} warn={(ramPct ?? 0) > 0.9} />
        <Row k="Temperature" v={m.temp_c != null ? `${fmtNum(m.temp_c, 1)} °C` : "—"} warn={(m.temp_c ?? 0) > 85} />
        <Row k="Power" v={m.power_w != null ? `${fmtNum(m.power_w, 1)} W` : "—"} />
        <Row k="Camera stream" v={m.camera_mbps != null ? `${fmtNum(m.camera_mbps, 2)} Mbps` : "—"} />
        <Row k="Camera link (all)" v={m.camera_rx_mbps != null ? `${fmtNum(m.camera_rx_mbps, 2)} Mbps rx` : "—"} />
        <Row
          k={`Uplink${m.uplink_iface ? ` (${m.uplink_iface})` : ""}`}
          v={m.uplink_tx_kbps != null ? `${fmtNum(m.uplink_tx_kbps, 0)} kbps up · ${fmtNum(m.uplink_rx_kbps, 0)} down` : "—"}
        />
        <Row k="SSD free" v={m.ssd_free_gb != null ? `${fmtNum(m.ssd_free_gb, 0)} of ${fmtNum(m.ssd_total_gb, 0)} GB` : "—"} warn={ssdPct != null && ssdPct < 0.05} />
        <Row
          k="Upload spool"
          v={m.upload_backlog != null ? `${fmtInt(m.upload_backlog)} pending${m.upload_gated ? " · waiting for CPU" : ""}` : "—"}
          warn={(m.upload_backlog ?? 0) > 50}
        />
        <Row k="Clips waiting" v={fmtInt(m.clip_backlog)} warn={(m.clip_backlog ?? 0) > 20} />
      </dl>
      {m.upload_last_error && (
        <p className="mt-2 truncate rounded-md bg-muted/50 px-2.5 py-1.5 text-[12px] text-muted-foreground" title={m.upload_last_error}>
          Last upload error: {m.upload_last_error}
        </p>
      )}
      {staleMs != null && staleMs > 120_000 && (
        <p className="mt-2 text-[12px] font-semibold text-warning">Metrics are stale — is sysmetrics.py running on the Jetson?</p>
      )}
    </div>
  );
}

function DeviceCard({ d, now }: { d: DeviceRow; now: Date }) {
  const h = deviceHealth(d);
  const Icon = d.camera_connected ? Camera : CameraOff;
  const label = h === "ok" ? "Online" : h === "warn" ? "Degraded" : "Offline";
  const tone = h === "ok" ? "var(--success)" : h === "warn" ? "var(--warning)" : "var(--destructive)";
  return (
    <Panel className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="icon-tile" style={{ ["--tile" as string]: tone }} aria-hidden>
            <Icon className="size-[18px]" />
          </span>
          <div>
            <p className="text-[15px] font-semibold">
              {d.direction === "out" ? "◀ Outbound" : "▶ Inbound"} camera
            </p>
            <p className="num text-[12px] text-muted-foreground">
              {d.device_id} · {d.camera_id}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-medium" style={{ color: tone, borderColor: `color-mix(in oklab, ${tone} 35%, transparent)` }}>
          <span className="size-1.5 rounded-full" style={{ background: tone }} aria-hidden />
          {label}
        </span>
      </div>
      <dl className="mt-4">
        <Row k="Last heartbeat" v={`${fmtAge(d.last_seen, now)} ago`} warn={h === "down"} />
        <Row k="Last read" v={d.last_read_at ? `${fmtAge(d.last_read_at, now)} ago` : "—"} />
        <Row k="Last event (edge)" v={d.last_event_at ? `${fmtAge(d.last_event_at, now)} ago` : "—"} />
        <Row k="Status" v={d.status ?? "—"} warn={!!d.status && d.status !== "ok"} />
        <Row k="Camera stream" v={d.camera_connected ? "connected" : "disconnected"} warn={!d.camera_connected} />
        <Row k="FPS" v={fmtNum(d.fps, 1)} />
        <Row k="Pending uploads" v={fmtInt(d.pending_uploads)} warn={(d.pending_uploads ?? 0) > 50} />
        <Row k="Clock offset" v={d.clock_offset_ms != null ? `${fmtInt(d.clock_offset_ms)} ms` : "—"} warn={Math.abs(d.clock_offset_ms ?? 0) > 5000} />
        <Row k="Uptime" v={d.uptime_s != null ? `${fmtNum(d.uptime_s / 3600, 1)} h` : "—"} />
        <Row k="App version" v={d.app_version ?? "—"} />
      </dl>
      {d.message && <p className="mt-3 rounded-md bg-muted/50 px-2.5 py-1.5 text-[12px] text-muted-foreground">“{d.message}”</p>}
      {d.metrics && <EdgeSystem m={d.metrics} now={now} />}
    </Panel>
  );
}

function Metric({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/15 p-3.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className={cn("num mt-1 text-xl font-semibold", warn && "text-warning")}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function HealthView({
  devices,
  quality,
  calibrations,
  system,
  isAdmin,
  nowIso,
}: {
  devices: R<DeviceRow[]>;
  quality: R<DataQuality | null>;
  calibrations: R<Calibration[]>;
  system: R<SystemStatus | null> | null;
  isAdmin: boolean;
  nowIso: string;
}) {
  const now = new Date(nowIso);
  const q = quality.data;
  const exact = q?.exact_share ?? null;
  const matchMix =
    q && q.exit_match_rate != null && exact != null
      ? [
          { label: "Exact match", value: Math.round(exact * 100), color: "var(--chart-1)" },
          { label: "Fuzzy / manual", value: Math.max(0, Math.round((q.exit_match_rate - exact) * 100)), color: "var(--chart-4)" },
          { label: "Unmatched exits", value: Math.max(0, Math.round((1 - q.exit_match_rate) * 100)), color: "var(--chart-5)" },
        ]
      : null;
  const resid = [...calibrations.data].reverse().map((c) => ({ x: c.at, label: fmtDateTime(c.at), y: c.residual }));
  const sys = system?.data;
  const dbPct = sys?.db_size_bytes != null ? sys.db_size_bytes / sys.db_limit_bytes : null;

  return (
    <div className="space-y-5">
      <section aria-labelledby="dev-h">
        <h2 id="dev-h" className="eyebrow mb-3 text-muted-foreground">Devices · from heartbeats</h2>
        {devices.error ? (
          <ErrorState error={devices.error} />
        ) : devices.data.length === 0 ? (
          <EmptyState icon={Cpu} title="No heartbeats yet">Devices appear after their first heartbeat (every 60 s). Offline after 180 s of silence.</EmptyState>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {devices.data.map((d) => (
              <DeviceCard key={d.camera_id ?? d.device_id} d={d} now={now} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Data quality" subtitle="Last 7 days" />
          <PanelBody>
            {quality.error ? (
              <ErrorState error={quality.error} compact />
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Reads" value={fmtInt(q?.reads)} hint={`${fmtInt(q?.passes)} passes`} />
                <Metric label="High-quality reads" value={fmtPct(q?.read_rate_high, 1)} hint="confidence ≥ 0.90" />
                <Metric label="Exit match rate" value={fmtPct(q?.exit_match_rate, 1)} />
                <Metric label="Exact share" value={fmtPct(q?.exact_share, 1)} />
                <Metric label="Orphan exits" value={fmtInt(q?.orphan_exits)} warn={(q?.orphan_exits ?? 0) > 5} />
                <Metric label="Fuzzy pending" value={fmtInt(q?.fuzzy_pending)} warn={(q?.fuzzy_pending ?? 0) > 20} />
                <Metric label="Suspect stale" value={fmtInt(q?.suspect_stale)} warn={(q?.suspect_stale ?? 0) > 0} />
                <Metric
                  label="Drift S2 − S1"
                  value={q?.drift == null ? "—" : q.drift > 0 ? `+${q.drift}` : String(q.drift)}
                  hint="open sessions − flow estimate"
                  warn={Math.abs(q?.drift ?? 0) > 3}
                />
              </div>
            )}
            {q && q.per_camera.length > 0 && (
              <table className="mt-5 w-full text-[12.5px]">
                <thead>
                  <tr className="border-b text-left text-[11.5px] text-muted-foreground uppercase">
                    <th scope="col" className="py-2 font-medium">Camera</th>
                    <th scope="col" className="py-2 text-right font-medium">Reads</th>
                    <th scope="col" className="py-2 text-right font-medium">Avg confidence</th>
                    <th scope="col" className="py-2 text-right font-medium">Low quality</th>
                  </tr>
                </thead>
                <tbody>
                  {q.per_camera.map((c) => (
                    <tr key={c.camera_id} className="border-b border-border/60 last:border-0">
                      <td className="num py-2">{c.camera_id}</td>
                      <td className="num py-2 text-right">{fmtInt(c.reads)}</td>
                      <td className="num py-2 text-right">{c.avg_conf?.toFixed(3) ?? "—"}</td>
                      <td className="num py-2 text-right">{fmtInt(c.low_quality)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="How are exits matched?" subtitle="Share of exits, last 7 days" />
          <PanelBody>
            {matchMix ? <Donut slices={matchMix} centerValue={fmtPct(q?.exit_match_rate)} centerLabel="matched" height={190} /> : <EmptyState title="No exits yet" compact />}
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard
          title="Is read quality worse at certain hours?"
          subtitle="Average plate confidence by local hour (glare, night)"
          legend={[{ label: "Avg confidence", color: "var(--chart-1)" }]}
          rows={q?.conf_by_hour ?? []}
          columns={[
            { key: "hour", label: "Hour (ET)" },
            { key: "avg_conf", label: "Avg confidence" },
          ]}
          filename="confidence-by-hour.csv"
        >
          {q && q.conf_by_hour.length ? (
            <SimpleLine
              data={q.conf_by_hour.map((h) => ({ x: h.hour, label: String(h.hour).padStart(2, "0"), y: h.avg_conf }))}
              valueFormat={(v) => v.toFixed(2)}
              name="Avg confidence"
              yDomain={["auto", 1]}
            />
          ) : (
            <EmptyState title="No reads" compact className="mx-2" />
          )}
        </ChartCard>
        <ChartCard
          title="How close is the estimate to reality?"
          subtitle="Residual (estimate − admin visual count) at each reconciliation"
          legend={[{ label: "Residual", color: "var(--chart-5)" }]}
          rows={calibrations.data}
          columns={[
            { key: "at", label: "At" },
            { key: "visual_count", label: "Visual count" },
            { key: "estimate_before", label: "Estimate" },
            { key: "residual", label: "Residual" },
            { key: "closed_count", label: "Closed" },
            { key: "actor_email", label: "By" },
          ]}
          filename="residuals.csv"
        >
          {calibrations.error ? (
            <ErrorState error={calibrations.error} compact className="mx-2" />
          ) : resid.length ? (
            <SimpleLine data={resid} color="var(--chart-5)" name="Residual" zeroLine valueFormat={(v) => (v > 0 ? `+${v}` : String(v))} />
          ) : (
            <EmptyState title="No reconciliations yet" compact className="mx-2">An admin reconciles from a visual count on /admin/reconcile.</EmptyState>
          )}
        </ChartCard>
      </div>

      {isAdmin && system && (
        <Panel>
          <PanelHeader title="Platform" subtitle="Supabase Free guards · admin only" />
          <PanelBody>
            {system.error ? (
              <ErrorState error={system.error} compact />
            ) : (
              <div className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
                <div>
                  <div className="flex items-center gap-2 text-[13px]">
                    <Database className="size-4 text-muted-foreground" /> Database size
                    <span className="num ml-auto font-semibold">
                      {fmtBytes(sys?.db_size_bytes)} / {fmtBytes(sys?.db_limit_bytes)}
                    </span>
                  </div>
                  <div className="relative mt-2 h-2.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={Math.round((dbPct ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Database size used">
                    <div className={cn("h-full rounded-full", (dbPct ?? 0) > 0.7 ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, (dbPct ?? 0) * 100)}%` }} />
                    <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: "70%" }} title="70% warning" />
                  </div>
                  <p className="num mt-1.5 text-[11.5px] text-muted-foreground">{fmtPct(dbPct, 1)} used · warning at 70%</p>
                </div>
                <dl>
                  <Row k="Events" v={fmtInt(sys?.events)} />
                  <Row k="Reads" v={fmtInt(sys?.reads)} />
                  <Row k="Sessions" v={fmtInt(sys?.sessions)} />
                  <Row k="Oldest event" v={fmtDateTime(sys?.oldest_event)} />
                  <Row k="Ingest errors (24 h)" v={fmtInt(sys?.ingest_errors_24h)} warn={(sys?.ingest_errors_24h ?? 0) > 0} />
                  <Row k="Last config sync" v={fmtDateTime(sys?.last_config_sync)} />
                  <Row k="Capacity" v={fmtInt(sys?.capacity)} />
                </dl>
              </div>
            )}
            <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <HardDrive className="size-3.5" /> Backups run nightly via GitHub Actions (pg_dump); status is not reported to the app yet.
            </p>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}
