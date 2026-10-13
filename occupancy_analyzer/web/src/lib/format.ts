import { tz } from "@date-fns/tz";
import { format, differenceInSeconds } from "date-fns";
import { TZ } from "./config";

/** All UI times are America/New_York (doc 07 §6). */
export const inLot = tz(TZ);

type Dateish = string | number | Date | null | undefined;

function toDate(v: Dateish): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmt(v: Dateish, pattern: string, fallback = "—"): string {
  const d = toDate(v);
  return d ? format(d, pattern, { in: inLot }) : fallback;
}

export const fmtClock = (v: Dateish) => fmt(v, "HH:mm:ss");
export const fmtHM = (v: Dateish) => fmt(v, "HH:mm");
export const fmtDateTime = (v: Dateish) => fmt(v, "MMM d, HH:mm");
export const fmtDateTimeFull = (v: Dateish) => fmt(v, "EEE MMM d yyyy, HH:mm:ss 'ET'");
export const fmtDay = (v: Dateish) => fmt(v, "EEE, MMM d");
export const fmtShortDay = (v: Dateish) => fmt(v, "MMM d");

/** Dwell: `52 m`, `1 h 52 m`, `3 d 4 h` (doc 07 §6). */
export function fmtDwell(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "—";
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} m`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d} d ${h} h`;
  return `${h} h ${String(m % 60).padStart(2, "0")} m`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** Ratio (0..1) to a percentage string. Tiles: 0 decimals; tables: 1 decimal. */
export function fmtPct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtConf(c: number | null | undefined): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return "—";
  return c.toFixed(2);
}

/** Compact age: `12 s`, `4 min`, `2 h 5 m`, `3 d`. */
export function fmtAge(v: Dateish, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return "never";
  const s = Math.max(0, differenceInSeconds(now, d));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} h ${m} m` : `${h} h`;
  }
  return `${Math.floor(s / 86400)} d`;
}

export function ageSeconds(v: Dateish, now: Date = new Date()): number | null {
  const d = toDate(v);
  return d ? Math.max(0, differenceInSeconds(now, d)) : null;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Relative change between current and previous; null when not computable. */
export function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}
