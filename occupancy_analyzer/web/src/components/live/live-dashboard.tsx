"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CarFront, Clock3, LogIn, LogOut, MoonStar } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { useLotChannel, type LotUpdate } from "@/lib/realtime/useLotChannel";
import {
  rpc,
  type DailyStat,
  type Kpis,
  type LiveSnapshot,
  type OccupancyPoint,
  type PassRow,
  type RpcError,
  type TypicalSlot,
} from "@/lib/rpc";
import { LOT_ID } from "@/lib/config";
import { delta, fmtDwell, fmtHM } from "@/lib/format";
import { normalizeState, STATE_META } from "@/lib/occupancy";
import { todayRange } from "@/lib/range";
import { Panel, PanelHeader } from "@/components/common/panel";
import { ErrorState } from "@/components/common/states";
import { PageHeader } from "@/components/common/page-header";
import { KpiCard } from "@/components/charts/kpi-card";
import { Legend } from "@/components/charts/kit";
import { OccupancyChart, occupancyLegend } from "@/components/charts/occupancy-chart";
import { SessionSheet } from "@/components/tables/session-sheet";
import { ConnectionPill, DeviceChip, deviceHealth } from "./connection";
import { HeroTile } from "./hero";
import { LiveFeed } from "./live-feed";
import { Swimlanes } from "./swimlanes";
import { CameraOfflineBanner, ReconcileBanner } from "./banners";

const SERIES_REFRESH_MS = 5 * 60_000;
const ANNOUNCE_MIN_MS = 30_000;

export type LiveProps = {
  initialSnapshot: LiveSnapshot | null;
  snapshotError: RpcError | null;
  initialSeries: OccupancyPoint[];
  seriesError: RpcError | null;
  typical: TypicalSlot[];
  dowLabel: string;
  dayStartMs: number;
  kpis: Kpis | null;
  daily: DailyStat[];
  isAdmin: boolean;
  kiosk: boolean;
  /** Server render time — the client starts from it so SSR and hydration agree. */
  nowIso: string;
};

export function LiveDashboard(props: LiveProps) {
  const { kiosk, isAdmin } = props;
  const [snap, setSnap] = useState<LiveSnapshot | null>(props.initialSnapshot);
  const [snapError, setSnapError] = useState<RpcError | null>(props.snapshotError);
  const [lastOkAt, setLastOkAt] = useState<number>(() => (props.initialSnapshot ? Date.parse(props.nowIso) : 0));
  const [series, setSeries] = useState(props.initialSeries);
  const seriesAt = useRef(0);
  const [now, setNow] = useState(() => new Date(props.nowIso));

  // Feed state (pausable — WCAG 2.2.2)
  const [feed, setFeed] = useState<PassRow[]>(props.initialSnapshot?.recent_passes ?? []);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState<PassRow[]>([]);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const [openSession, setOpenSession] = useState<string | null>(null);

  const flash = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setFreshIds(new Set(ids));
    window.setTimeout(() => setFreshIds(new Set()), 1600);
  }, []);

  const mergeFeed = useCallback(
    (incoming: PassRow[]) => {
      if (pausedRef.current) {
        setPending((p) => {
          const known = new Set(p.map((x) => x.pass_id));
          return [...incoming.filter((x) => !known.has(x.pass_id)), ...p].slice(0, 100);
        });
        return;
      }
      setFeed((cur) => {
        const known = new Set(cur.map((x) => x.pass_id));
        const add = incoming.filter((x) => !known.has(x.pass_id));
        if (add.length) flash(add.map((a) => a.pass_id));
        const merged = [...add, ...cur.map((c) => incoming.find((i) => i.pass_id === c.pass_id) ?? c)];
        merged.sort((a, b) => Date.parse(b.event_at ?? "") - Date.parse(a.event_at ?? ""));
        return merged.slice(0, 50);
      });
    },
    [flash],
  );

  const refetch = useCallback(async () => {
    const sb = getBrowserSupabase();
    const r = await rpc.liveSnapshot(sb);
    if (r.ok) {
      setSnap(r.data);
      setSnapError(null);
      setLastOkAt(Date.now());
      mergeFeed(r.data.recent_passes);
    } else {
      setSnapError(r.error);
    }
    if (Date.now() - seriesAt.current > SERIES_REFRESH_MS) {
      seriesAt.current = Date.now();
      const { fromIso, toIso } = todayRange();
      const s = await rpc.occupancySeries(sb, { from: fromIso, to: toIso }, 15);
      if (s.ok) setSeries(s.data);
    }
  }, [mergeFeed]);

  const onUpdate = useCallback(
    (u: LotUpdate) => {
      setSnap((s) =>
        s
          ? {
              ...s,
              occupancy: u.occupancy ?? s.occupancy,
              band_low: u.band_low ?? s.band_low,
              band_high: u.band_high ?? s.band_high,
              open_sessions: u.open_sessions ?? s.open_sessions,
              state: u.state ?? s.state,
              updated_at: u.ts ?? s.updated_at,
              lot: u.capacity ? { ...s.lot, capacity: u.capacity } : s.lot,
            }
          : s,
      );
      setLastOkAt(Date.now());
      if (u.pass) mergeFeed([u.pass]);
    },
    [mergeFeed],
  );

  const conn = useLotChannel(
    LOT_ID,
    {
      onUpdate,
      onResync: refetch,
      onDevice: (d) =>
        setSnap((s) =>
          s
            ? {
                ...s,
                devices: s.devices.map((x) =>
                  x.device_id === d.device_id
                    ? { ...x, status: d.status ?? x.status, camera_connected: d.camera_connected ?? x.camera_connected }
                    : x,
                ),
              }
            : s,
        ),
    },
    true,
  );

  useEffect(() => {
    seriesAt.current = Date.now();
    const t = window.setInterval(() => setNow(new Date()), 5000);
    return () => window.clearInterval(t);
  }, []);

  // Kiosk: keep the screen awake.
  useEffect(() => {
    if (!kiosk || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
      .request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      lock?.release().catch(() => {});
    };
  }, [kiosk]);

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      const buffered = pending;
      setPending([]);
      pausedRef.current = false;
      mergeFeed(buffered);
    } else {
      setPaused(true);
    }
  };

  const capacity = snap?.lot.capacity ?? 100;
  const effectivePct = snap?.lot.effective_pct ?? 0.85;
  const occupancy = snap?.occupancy ?? 0;
  const pct = capacity ? occupancy / capacity : 0;
  const state = normalizeState(snap?.state, pct, effectivePct);
  const devices = useMemo(() => snap?.devices ?? [], [snap?.devices]);
  const offline = devices.filter((d) => deviceHealth(d) === "down");
  const staleMs = now.getTime() - lastOkAt;
  const stale = !snap || (conn === "offline" && staleMs > 90_000) || staleMs > 120_000 || (devices.length > 0 && offline.length === devices.length);
  const staleReason = !snap
    ? "no snapshot"
    : devices.length > 0 && offline.length === devices.length
      ? "all cameras offline"
      : staleMs > 90_000
        ? "connection lost"
        : null;

  // One throttled status region (doc 07 §5).
  const [announcement, setAnnouncement] = useState("");
  const lastAnnounce = useRef<{ at: number; key: string }>({ at: 0, key: "" });
  useEffect(() => {
    const key = `${state}-${Math.floor(pct * 10)}`;
    const t = Date.now();
    if (key !== lastAnnounce.current.key && t - lastAnnounce.current.at > ANNOUNCE_MIN_MS) {
      lastAnnounce.current = { at: t, key };
      setAnnouncement(`Lot ${Math.round(pct * 100)}% full, ${STATE_META[state].label}`);
    }
  }, [state, pct]);

  const chartSeries = useMemo(() => {
    if (!snap) return series;
    return [
      ...series,
      {
        ts: now.toISOString(),
        occ_avg: snap.occupancy,
        occ_max: snap.occupancy,
        occ_min: snap.occupancy,
        band_low: snap.band_low,
        band_high: snap.band_high,
        capacity,
      },
    ];
  }, [series, snap, now, capacity]);

  const today = snap?.today;
  const k = props.kpis;
  const daily = props.daily;
  const spark = (key: keyof DailyStat) => daily.map((d) => (typeof d[key] === "number" ? (d[key] as number) : null));
  const hasFan = props.typical.some((s) => (s.days ?? 99) >= 3);

  return (
    <div className={kiosk ? "text-[110%]" : undefined}>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <PageHeader
        title={kiosk ? (snap?.lot.name ?? "GATF Lot") : "Lot Overview"}
        subtitle={
          <>
            {snap?.lot.name ?? "GATF Parking Lot"} · capacity <span className="num">{capacity}</span> · updated{" "}
            <span className="num">{fmtHM(snap?.updated_at ?? null)}</span> ET
          </>
        }
        actions={
          <>
            <ConnectionPill state={conn} />
            {devices.map((d) => (
              <DeviceChip key={d.camera_id ?? d.device_id} device={d} now={now} />
            ))}
          </>
        }
      />

      {!kiosk && offline.length > 0 && <CameraOfflineBanner names={offline.map((d) => `${d.direction === "out" ? "Outbound" : "Inbound"} camera (${d.device_id})`)} />}
      {!kiosk && snap?.reconcile_recommended && <ReconcileBanner reasons={snap.reconcile_reasons} isAdmin={isAdmin} />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Panel className="p-5 lg:col-span-5 xl:col-span-4">
          {snap ? (
            <HeroTile
              occupancy={occupancy}
              capacity={capacity}
              bandLow={snap.band_low}
              bandHigh={snap.band_high}
              openSessions={snap.open_sessions}
              effectivePct={effectivePct}
              state={state}
              lastReconciledAt={snap.last_reconciled_at}
              updatedAt={snap.updated_at}
              lastInAt={snap.last_in_at}
              lastOutAt={snap.last_out_at}
              stale={stale}
              staleReason={staleReason}
              now={now}
              kiosk={kiosk}
            />
          ) : snapError ? (
            <ErrorState error={snapError} />
          ) : null}
        </Panel>

        <Panel className="flex flex-col lg:col-span-7 xl:col-span-8">
          <PanelHeader
            title={`Is today unusual?`}
            subtitle={`Today vs a typical ${props.dowLabel} · 15-min steps, ET`}
            actions={<Legend items={occupancyLegend({ typical: props.typical.length > 0, fan: hasFan, band: true })} className="hidden md:flex" />}
          />
          <div className="flex-1 px-3 pt-3 pb-4">
            {props.seriesError && series.length === 0 ? (
              <ErrorState error={props.seriesError} compact className="mx-2" />
            ) : (
              <OccupancyChart
                points={chartSeries}
                capacity={capacity}
                effectivePct={effectivePct}
                typical={props.typical}
                dayStartMs={props.dayStartMs}
                dayEndMs={props.dayStartMs + 24 * 3600_000}
                nowMs={now.getTime()}
                height={kiosk ? 380 : 300}
              />
            )}
            {props.typical.length > 0 && !hasFan && (
              <p className="px-3 text-[11.5px] text-muted-foreground">Showing the typical median only — the p10–p90 band appears after ~3 weeks of history.</p>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Entries today"
          value={today?.entries}
          icon={LogIn}
          tone="var(--chart-1)"
          delta={delta(k?.entries, k?.prev?.entries)}
          deltaLabel="vs yesterday, same time"
          spark={spark("entries")}
          sub={today?.bounces != null ? <><span className="num">{today.bounces}</span> bounces (in &amp; out &lt; 5 min)</> : undefined}
          definition="Passes on the inbound camera since 00:00 ET, after de-duplication."
          stale={stale}
        />
        <KpiCard
          label="Exits today"
          value={today?.exits}
          icon={LogOut}
          tone="var(--chart-2)"
          delta={delta(k?.exits, k?.prev?.exits)}
          deltaLabel="vs yesterday, same time"
          spark={spark("exits")}
          definition="Passes on the outbound camera since 00:00 ET, after de-duplication."
          stale={stale}
        />
        <KpiCard
          label="Avg dwell (closed)"
          value={today?.avg_dwell_min}
          display={today?.avg_dwell_min != null ? fmtDwell(today.avg_dwell_min) : undefined}
          icon={Clock3}
          tone="var(--chart-3)"
          delta={delta(k?.avg_dwell_min, k?.prev?.avg_dwell_min)}
          deltaLabel="vs yesterday"
          spark={spark("avg_dwell_min")}
          definition="Mean stay of sessions closed today by a matched exit (closed, closed_inferred). Admin-closed, expired and orphan exits are excluded."
          stale={stale}
        />
        <KpiCard
          label="Overnight · multi-day"
          value={today?.overnight}
          icon={MoonStar}
          tone="var(--chart-4)"
          sub={
            <>
              <span className="num">{today?.multi_day ?? 0}</span> open &gt; 24 h ·{" "}
              <span className="num">{today?.unique_vehicles ?? "—"}</span> unique vehicles
            </>
          }
          spark={spark("overnight")}
          invert
          definition="Overnight = present at 03:00 ET (rule says it shouldn't happen). Multi-day = open longer than 24 h."
          stale={stale}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Panel className="flex flex-col lg:col-span-7">
          <PanelHeader title="Live feed" subtitle="Every pass as cameras report it · click a row for the session" />
          <div className="mt-3 flex-1">
            <LiveFeed
              passes={feed}
              paused={paused}
              onTogglePause={togglePause}
              pendingCount={pending.length}
              freshIds={freshIds}
              hidePlates={kiosk}
              onOpen={setOpenSession}
            />
          </div>
        </Panel>
        <Panel className="flex flex-col lg:col-span-5">
          <PanelHeader
            title="In the lot now"
            subtitle={
              <>
                <CarFront className="mr-1 inline size-3.5 align-[-2px]" />
                {snap?.in_lot.length ?? 0} open sessions · ⏾ flags never close a session
              </>
            }
          />
          <div className="mt-3 flex-1">
            <Swimlanes sessions={snap?.in_lot ?? []} now={now} hidePlates={kiosk} onOpen={setOpenSession} />
          </div>
        </Panel>
      </div>

      {!kiosk && <SessionSheet sessionId={openSession} onOpenChange={(o) => !o && setOpenSession(null)} />}
    </div>
  );
}
