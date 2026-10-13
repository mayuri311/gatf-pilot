export type OccState = "available" | "filling" | "effectively_full" | "full";

/** Doc 07 §3: colour + shape + label, never colour alone. */
export const STATE_META: Record<OccState, { label: string; shape: string; color: string; short: string }> = {
  available: { label: "Available", shape: "●", color: "var(--state-available)", short: "Available" },
  filling: { label: "Filling", shape: "▲", color: "var(--state-filling)", short: "Filling" },
  effectively_full: {
    label: "Effectively full",
    shape: "■",
    color: "var(--state-full)",
    short: "Eff. full",
  },
  full: { label: "FULL", shape: "■■", color: "var(--state-full-hard)", short: "FULL" },
};

export function stateFor(pct: number, effective = 0.85): OccState {
  if (pct >= 0.98) return "full";
  if (pct >= effective) return "effectively_full";
  if (pct >= 0.6) return "filling";
  return "available";
}

export function normalizeState(s: string | null | undefined, pct: number, effective = 0.85): OccState {
  if (s === "available" || s === "filling" || s === "effectively_full" || s === "full") return s;
  return stateFor(pct, effective);
}

export const QUALITY_META = {
  high: { label: "High", icon: "●", tone: "text-success" },
  medium: { label: "Medium", icon: "◐", tone: "text-warning" },
  low: { label: "Low", icon: "○", tone: "text-destructive" },
} as const;

export function confClass(c: number | null | undefined): "high" | "medium" | "low" {
  if (c == null) return "low";
  if (c >= 0.9) return "high";
  if (c >= 0.75) return "medium";
  return "low";
}

export const SESSION_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  pending_review: "Pending review",
  closed: "Closed",
  closed_inferred: "Closed (inferred)",
  closed_admin: "Closed by admin",
  expired: "Expired",
  orphan_exit: "Orphan exit",
};

export const MATCH_LABEL: Record<string, string> = {
  exact: "Exact",
  fuzzy: "Fuzzy",
  fuzzy_pending: "Fuzzy · pending",
  manual: "Manual",
};
