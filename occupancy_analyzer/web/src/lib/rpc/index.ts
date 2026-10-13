/**
 * Typed wrappers for every RPC in docs/CONTRACT.md §3. Works with both the
 * server client (RSC / route handlers / actions) and the browser client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { LOT_ID } from "../config";
import { callRpc } from "./core";
import * as S from "./schemas";

export * from "./core";
export type * from "./schemas";

type SB = SupabaseClient;
type Range = { from: string; to: string };

export const rpc = {
  liveSnapshot: (sb: SB, lot = LOT_ID) => callRpc(sb, "get_live_snapshot", { p_lot: lot }, S.liveSnapshot),

  occupancySeries: (sb: SB, r: Range, bucketMinutes: number, lot = LOT_ID) =>
    callRpc(
      sb,
      "get_occupancy_series",
      { p_lot: lot, p_from: r.from, p_to: r.to, p_bucket_minutes: bucketMinutes },
      S.arr(S.occupancyPoint),
    ),

  typicalDay: (sb: SB, dow: number, weeks = 8, lot = LOT_ID) =>
    callRpc(sb, "get_typical_day", { p_lot: lot, p_dow: dow, p_weeks: weeks }, S.arr(S.typicalSlot)),

  flowSeries: (sb: SB, r: Range, bucketMinutes: number, lot = LOT_ID) =>
    callRpc(
      sb,
      "get_flow_series",
      { p_lot: lot, p_from: r.from, p_to: r.to, p_bucket_minutes: bucketMinutes },
      S.arr(S.flowPoint),
    ),

  heatmap: (sb: SB, r: Range, metric: "occupancy" | "arrivals", lot = LOT_ID) =>
    callRpc(sb, "get_heatmap", { p_lot: lot, p_from: r.from, p_to: r.to, p_metric: metric }, S.arr(S.heatCell)),

  dailyStats: (sb: SB, r: Range, lot = LOT_ID) =>
    callRpc(sb, "get_daily_stats", { p_lot: lot, p_from: r.from, p_to: r.to }, S.arr(S.dailyStat)),

  dwellDistribution: (sb: SB, r: Range, lot = LOT_ID) =>
    callRpc(sb, "get_dwell_distribution", { p_lot: lot, p_from: r.from, p_to: r.to }, S.dwellDistribution),

  kpis: (sb: SB, r: Range, lot = LOT_ID) =>
    callRpc(sb, "get_kpis", { p_lot: lot, p_from: r.from, p_to: r.to }, S.kpis),

  listSessions: (
    sb: SB,
    q: Range & {
      status?: string[] | null;
      plate?: string | null;
      flags?: string[] | null;
      limit?: number;
      offset?: number;
    },
    lot = LOT_ID,
  ) =>
    callRpc(
      sb,
      "list_sessions",
      {
        p_lot: lot,
        p_from: q.from,
        p_to: q.to,
        p_status: q.status?.length ? q.status : null,
        p_plate: q.plate || null,
        p_flags: q.flags?.length ? q.flags : null,
        p_limit: q.limit ?? 50,
        p_offset: q.offset ?? 0,
      },
      S.paged(S.sessionRow),
    ),

  listReads: (
    sb: SB,
    q: Range & {
      camera?: string | null;
      plate?: string | null;
      quality?: string | null;
      limit?: number;
      offset?: number;
    },
    lot = LOT_ID,
  ) =>
    callRpc(
      sb,
      "list_reads",
      {
        p_lot: lot,
        p_from: q.from,
        p_to: q.to,
        p_camera: q.camera || null,
        p_plate: q.plate || null,
        p_quality: q.quality || null,
        p_limit: q.limit ?? 50,
        p_offset: q.offset ?? 0,
      },
      S.paged(S.readRow),
    ),

  searchPlates: (sb: SB, q: string) => callRpc(sb, "search_plates", { p_q: q }, S.plateSearch),

  vehicleProfile: (sb: SB, plate: string) =>
    callRpc(sb, "get_vehicle_profile", { p_plate: plate }, S.vehicleProfile),

  session: (sb: SB, sessionId: string) => callRpc(sb, "get_session", { p_session: sessionId }, S.sessionDetail),

  /** Single read incl. the per-frame reads[] timeline (DB extra beyond CONTRACT §3). */
  read: (sb: SB, readId: string) => callRpc(sb, "get_read", { p_read: readId }, S.readRow),

  /** Extra RPC (beyond CONTRACT §3): cheap count for the sidebar badge. */
  reviewCount: (sb: SB, lot = LOT_ID, opts?: { timeoutMs?: number }) =>
    callRpc(sb, "get_review_count", { p_lot: lot }, z.number().catch(0), opts),

  reviewQueue: (sb: SB, lot = LOT_ID, opts?: { timeoutMs?: number }) =>
    callRpc(sb, "get_review_queue", { p_lot: lot }, S.arr(S.reviewItem), opts),

  resolveMatch: (sb: SB, exitPass: string, entryPass: string | null, note?: string | null) =>
    callRpc(
      sb,
      "resolve_match",
      { p_exit_pass: exitPass, p_entry_pass: entryPass, p_note: note ?? null },
      S.okResult,
    ),

  correctPlate: (sb: SB, readId: string, plate: string, note?: string | null) =>
    callRpc(sb, "correct_plate", { p_read: readId, p_plate: plate, p_note: note ?? null }, S.okResult),

  reconcilePreview: (sb: SB, visualCount: number, lot = LOT_ID) =>
    callRpc(sb, "reconcile_preview", { p_lot: lot, p_visual_count: visualCount }, S.reconcilePreview),

  reconcileCommit: (sb: SB, visualCount: number, close: string[], note?: string | null, lot = LOT_ID) =>
    callRpc(
      sb,
      "reconcile_commit",
      { p_lot: lot, p_visual_count: visualCount, p_close: close, p_note: note ?? null },
      S.reconcileCommit,
    ),

  calibrationHistory: (sb: SB, lot = LOT_ID) =>
    callRpc(sb, "get_calibration_history", { p_lot: lot }, S.arr(S.calibration)),

  alerts: (sb: SB, lot = LOT_ID, opts?: { timeoutMs?: number }) =>
    callRpc(sb, "get_alerts", { p_lot: lot }, S.arr(S.alertRow), opts),

  ackAlert: (sb: SB, key: string) => callRpc(sb, "ack_alert", { p_key: key }, S.okResult),

  dataQuality: (sb: SB, r: Range, lot = LOT_ID) =>
    callRpc(sb, "get_data_quality", { p_lot: lot, p_from: r.from, p_to: r.to }, S.dataQuality),

  devices: (sb: SB, lot = LOT_ID) => callRpc(sb, "get_devices", { p_lot: lot }, S.arr(S.deviceRow)),

  systemStatus: (sb: SB) => callRpc(sb, "get_system_status", {}, S.systemStatus),

  auditLog: (sb: SB, limit = 200) => callRpc(sb, "get_audit_log", { p_limit: limit }, S.arr(S.auditRow)),

  logAudit: (sb: SB, action: string, target: string, detail: Record<string, unknown> = {}) =>
    callRpc(sb, "log_audit", { p_action: action, p_target: target, p_detail: detail }, z.unknown()),
};
