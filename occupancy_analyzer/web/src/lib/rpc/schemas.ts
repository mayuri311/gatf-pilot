/**
 * Tolerant zod schemas for every RPC in docs/CONTRACT.md §3.
 * Missing/invalid scalar fields degrade to null/false/[] instead of failing the
 * whole payload, so a partially-deployed DB never crashes the UI.
 */
import { z } from "zod";
import { appConfig } from "../config";

export const num = z.number().nullable().catch(null);
export const int0 = z.number().catch(0);
export const str = z.string().nullable().catch(null);
export const bool = z.boolean().catch(false);
export const arr = <T extends z.ZodTypeAny>(item: T) => z.array(item).catch([]);
const strArr = z.array(z.string()).catch([]);
const numArr = z.array(z.number().nullable().catch(null)).catch([]);

export const alternate = z.object({ text: z.string().catch(""), weight: num });
export const frameRead = z.object({
  frame_index: num,
  text: z.string().catch(""),
  confidence: num,
  clean: bool,
});

export const readRow = z.object({
  read_id: z.string(),
  camera_id: str,
  direction: z.enum(["in", "out"]).nullable().catch(null),
  event_at: str,
  plate_norm: str,
  plate_raw: str,
  plate_confidence: num,
  plate_confidence_per_char: numArr,
  quality: z.enum(["high", "medium", "low"]).nullable().catch(null),
  alternates: arr(alternate),
  reads: arr(frameRead),
  image_path: str,
  pass_id: str,
  corrected: bool,
  num_frames_used: num,
  track: z.record(z.string(), z.unknown()).nullable().catch(null),
});
export type ReadRow = z.infer<typeof readRow>;

export const sessionRow = z.object({
  session_id: z.string(),
  plate_norm: str,
  entry_at: str,
  exit_at: str,
  dwell_min: num,
  status: z.string().catch("open"),
  match_method: str,
  match_score: num,
  closed_reason: str,
  is_bounce: bool,
  suspect_stale: bool,
  overnight: bool,
  multi_day: bool,
  entry_read_id: str,
  exit_read_id: str,
  entry_image: str,
  exit_image: str,
  entry_confidence: num,
  exit_confidence: num,
  exit_plate: str,
});
export type SessionRow = z.infer<typeof sessionRow>;

export const passRow = z.object({
  pass_id: z.string(),
  direction: z.enum(["in", "out"]).catch("in"),
  event_at: str,
  plate_norm: str,
  plate_confidence: num,
  quality: z.enum(["high", "medium", "low"]).nullable().catch(null),
  read_id: str,
  image_path: str,
  session_id: str,
  match_method: str,
  dwell_min: num,
  read_count: num,
  status: str,
});
export type PassRow = z.infer<typeof passRow>;

export const deviceRow = z.object({
  device_id: z.string(),
  camera_id: str,
  direction: z.enum(["in", "out"]).nullable().catch(null),
  online: bool,
  status: str,
  camera_connected: bool,
  fps: num,
  last_seen: str,
  last_event_at: str,
  pending_uploads: num,
  clock_offset_ms: num,
  uptime_s: num,
  app_version: str,
  message: str,
  last_read_at: str,
});
export type DeviceRow = z.infer<typeof deviceRow>;

export const alertRow = z.object({
  key: z.string(),
  severity: z.enum(["critical", "warning", "info"]).catch("info"),
  title: z.string().catch("Alert"),
  detail: str,
  since: str,
  acked: bool,
});
export type AlertRow = z.infer<typeof alertRow>;

const lotDefaults = {
  lot_id: appConfig.lot.lot_id,
  name: appConfig.lot.name,
  capacity: appConfig.lot.capacity,
  timezone: appConfig.lot.timezone,
  effective_pct: appConfig.lot.effective_pct,
};

export const liveSnapshot = z.object({
  lot: z
    .object({
      lot_id: z.string().catch(lotDefaults.lot_id),
      name: z.string().catch(lotDefaults.name),
      capacity: z.number().catch(lotDefaults.capacity),
      timezone: z.string().catch(lotDefaults.timezone),
      effective_pct: z.number().catch(lotDefaults.effective_pct),
    })
    .catch(lotDefaults),
  occupancy: int0,
  band_low: num,
  band_high: num,
  open_sessions: num,
  pct: num,
  state: str,
  updated_at: str,
  last_in_at: str,
  last_out_at: str,
  last_reconciled_at: str,
  reconcile_recommended: bool,
  reconcile_reasons: strArr,
  today: z
    .object({
      entries: num,
      exits: num,
      bounces: num,
      avg_dwell_min: num,
      overnight: num,
      multi_day: num,
      unique_vehicles: num,
    })
    .catch({
      entries: null,
      exits: null,
      bounces: null,
      avg_dwell_min: null,
      overnight: null,
      multi_day: null,
      unique_vehicles: null,
    }),
  devices: arr(deviceRow),
  recent_passes: arr(passRow),
  in_lot: arr(sessionRow),
  alerts: arr(alertRow),
});
export type LiveSnapshot = z.infer<typeof liveSnapshot>;

export const occupancyPoint = z.object({
  ts: z.string(),
  occ_avg: num,
  occ_max: num,
  occ_min: num,
  band_low: num,
  band_high: num,
  capacity: num,
});
export type OccupancyPoint = z.infer<typeof occupancyPoint>;

export const typicalSlot = z.object({ slot: z.string(), p10: num, p50: num, p90: num, days: num });
export type TypicalSlot = z.infer<typeof typicalSlot>;

export const flowPoint = z.object({
  ts: z.string(),
  arrivals: int0,
  departures: int0,
  net: int0,
  bounces: int0,
});
export type FlowPoint = z.infer<typeof flowPoint>;

export const heatCell = z.object({ dow: z.number(), hour: z.number(), value: num });
export type HeatCell = z.infer<typeof heatCell>;

export const dailyStat = z.object({
  day: z.string(),
  peak_occ: num,
  peak_pct: num,
  peak_at: str,
  entries: num,
  exits: num,
  bounces: num,
  overnight: num,
  unique_vehicles: num,
  avg_dwell_min: num,
  median_dwell_min: num,
  p90_dwell_min: num,
  hours_effectively_full: num,
  avg_occ: num,
});
export type DailyStat = z.infer<typeof dailyStat>;

export const dwellDistribution = z.object({
  buckets: arr(z.object({ label: z.string().catch("?"), count: int0 })),
  median_min: num,
  p90_min: num,
  avg_min: num,
  total: num,
});
export type DwellDistribution = z.infer<typeof dwellDistribution>;

const kpiCore = {
  entries: num,
  exits: num,
  bounces: num,
  bounce_rate: num,
  unique_vehicles: num,
  avg_dwell_min: num,
  median_dwell_min: num,
  turnover: num,
  peak_occ: num,
  peak_pct: num,
  peak_at: str,
  utilization: num,
  hours_effectively_full: num,
  overnight: num,
  match_rate: num,
};
export const kpiSet = z.object(kpiCore);
export const kpis = z.object({ ...kpiCore, prev: kpiSet.nullable().catch(null) });
export type Kpis = z.infer<typeof kpis>;
export type KpiKey = keyof typeof kpiCore;

export const paged = <T extends z.ZodTypeAny>(row: T) =>
  z.object({ total: int0, rows: arr(row) });

export const plateHit = z.object({
  plate_norm: z.string(),
  last_seen: str,
  visits: num,
  similarity: num,
});
export const plateSearch = z.object({ exact: arr(plateHit), similar: arr(plateHit) });
export type PlateHit = z.infer<typeof plateHit>;

export const vehicleProfile = z.object({
  plate_norm: z.string(),
  first_seen: str,
  last_seen: str,
  visits: num,
  avg_dwell_min: num,
  usual_arrival_hour: num,
  overnight_count: num,
  aliases: strArr,
  sessions: arr(sessionRow),
});
export type VehicleProfile = z.infer<typeof vehicleProfile>;

export const sessionDetail = sessionRow.extend({
  entry_read: readRow.nullable().catch(null),
  exit_read: readRow.nullable().catch(null),
  candidates: arr(
    z.object({
      session_id: str,
      entry_pass_id: str,
      plate_norm: str,
      entry_at: str,
      score: num,
      read: readRow.nullable().catch(null),
    }),
  ),
});
export type SessionDetail = z.infer<typeof sessionDetail>;

export const reviewCandidate = z.object({
  session_id: str,
  entry_pass_id: str,
  plate_norm: str,
  entry_at: str,
  score: num,
  read: readRow.nullable().catch(null),
});
export type ReviewCandidate = z.infer<typeof reviewCandidate>;
export const reviewItem = z.object({
  session_id: z.string(),
  exit_pass_id: z.string(),
  exit_read: readRow.nullable().catch(null),
  status: str,
  candidates: arr(reviewCandidate),
});
export type ReviewItem = z.infer<typeof reviewItem>;

export const okResult = z.object({ ok: z.boolean().catch(true) }).catch({ ok: true });

export const reconcilePreview = z.object({
  estimate: num,
  band_low: num,
  band_high: num,
  open_sessions: num,
  visual_count: num,
  to_close_count: num,
  proposed: arr(sessionRow.extend({ reason: str })),
  /** All open sessions ordered by proposal priority (extra, beyond CONTRACT). */
  open: arr(sessionRow.extend({ reason: str })),
});
export type ReconcilePreview = z.infer<typeof reconcilePreview>;

export const reconcileCommit = z.object({ residual: num, closed: num });

export const calibration = z.object({
  at: z.string(),
  visual_count: num,
  estimate_before: num,
  residual: num,
  closed_count: num,
  actor_email: str,
  note: str,
});
export type Calibration = z.infer<typeof calibration>;

export const dataQuality = z.object({
  reads: num,
  passes: num,
  read_rate_high: num,
  exit_match_rate: num,
  exact_share: num,
  orphan_exits: num,
  fuzzy_pending: num,
  suspect_stale: num,
  fragments: num,
  drift: num,
  per_camera: arr(z.object({ camera_id: z.string().catch("?"), reads: num, avg_conf: num, low_quality: num })),
  conf_by_hour: arr(z.object({ hour: z.number().catch(0), avg_conf: num })),
});
export type DataQuality = z.infer<typeof dataQuality>;

export const systemStatus = z.object({
  db_size_bytes: num,
  db_limit_bytes: z.number().catch(524288000),
  events: num,
  reads: num,
  sessions: num,
  oldest_event: str,
  last_config_sync: str,
  capacity: num,
  ingest_errors_24h: num,
});
export type SystemStatus = z.infer<typeof systemStatus>;

export const auditRow = z.object({
  at: z.string(),
  actor_email: str,
  action: z.string().catch("?"),
  target: str,
  detail: z.unknown().optional(),
});
export type AuditRow = z.infer<typeof auditRow>;
