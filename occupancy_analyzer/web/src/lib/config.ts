import generated from "@/generated/app-config.json";

/**
 * Non-secret config parsed from repo-root config/config.yaml by
 * scripts/sync-config.ts (runs as predev / prebuild). Safe for client bundles.
 */
export type AppConfig = {
  generated_at: string;
  source: string;
  lot: { lot_id: string; name: string; capacity: number; timezone: string; effective_pct: number };
  cameras: { camera_id: string; direction: "in" | "out"; device_id: string }[];
  storage: { bucket: string };
  auth: { bootstrap_admin_email: string | null };
  ai: { enabled: boolean; provider: string; model: string };
  heartbeat: { interval_s: number; offline_after_s: number };
  retention: { plate_text_days: number; crop_days: number; reads_full_days: number };
};

export const appConfig = generated as AppConfig;
export const LOT_ID = appConfig.lot.lot_id;
export const TZ = appConfig.lot.timezone || "America/New_York";
