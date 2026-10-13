import { TZDate } from "@date-fns/tz";
import { addDays, differenceInCalendarDays, format, startOfDay, subDays } from "date-fns";
import { inLot } from "./format";
import { TZ } from "./config";

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"] | "custom";

export type ResolvedRange = {
  preset: PresetId;
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
  label: string;
  days: number;
  bucketMinutes: number;
};

function parseLocalDay(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new TZDate(y, m - 1, d, TZ);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export const localDayKey = (d: Date) => format(d, "yyyy-MM-dd", { in: inLot });

/** Bucket size so a chart never gets more than ~2000 points (doc 07 §1.6). */
export function bucketFor(days: number): number {
  if (days <= 2) return 15;
  if (days <= 14) return 60;
  if (days <= 62) return 180;
  return 1440;
}

export function resolveRange(
  preset: string | null | undefined,
  fromDay?: string | null,
  toDay?: string | null,
  now: Date = new Date(),
): ResolvedRange {
  const today = startOfDay(now, { in: inLot });
  let p: PresetId = (["today", "yesterday", "7d", "30d", "90d", "custom"] as const).includes(
    preset as PresetId,
  )
    ? (preset as PresetId)
    : "7d";
  let from: Date;
  let to: Date;
  let label: string;

  const cf = parseLocalDay(fromDay);
  const ct = parseLocalDay(toDay);
  if (p === "custom" && cf && ct && cf <= ct) {
    from = cf;
    to = addDays(ct, 1, { in: inLot });
    if (to > now) to = now;
    label = `${format(cf, "MMM d", { in: inLot })} – ${format(ct, "MMM d, yyyy", { in: inLot })}`;
  } else {
    if (p === "custom") p = "7d";
    switch (p) {
      case "today":
        from = today;
        to = now;
        label = "Today";
        break;
      case "yesterday":
        from = subDays(today, 1, { in: inLot });
        to = today;
        label = "Yesterday";
        break;
      case "30d":
        from = subDays(today, 29, { in: inLot });
        to = now;
        label = "Last 30 days";
        break;
      case "90d":
        from = subDays(today, 89, { in: inLot });
        to = now;
        label = "Last 90 days";
        break;
      default:
        from = subDays(today, 6, { in: inLot });
        to = now;
        label = "Last 7 days";
    }
  }
  const days = Math.max(1, differenceInCalendarDays(to, from, { in: inLot }) + (p === "today" ? 1 : 0));
  return {
    preset: p,
    from,
    to,
    fromIso: new Date(from.getTime()).toISOString(),
    toIso: new Date(to.getTime()).toISOString(),
    label,
    days,
    bucketMinutes: bucketFor(days),
  };
}

export function todayRange(now: Date = new Date()) {
  const from = startOfDay(now, { in: inLot });
  return { fromIso: new Date(from.getTime()).toISOString(), toIso: now.toISOString(), from };
}

/** Local day-of-week (0 = Sun) in the lot timezone. */
export function localDow(d: Date = new Date()): number {
  return Number(format(d, "i", { in: inLot })) % 7;
}
