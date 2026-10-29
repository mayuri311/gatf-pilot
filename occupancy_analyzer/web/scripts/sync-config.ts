/**
 * Pre-build step (plan doc 12 §2, doc 13 §3):
 *   1. Parse + validate ../../config/config.yaml.
 *   2. Write the non-secret subset to src/generated/app-config.json (the app imports it).
 *   3. Upsert `lots`, `cameras` and append `lot_capacity_history` (when the capacity changed)
 *      using the service-role key via PostgREST.
 *
 * Flags: --generate-only  (skip step 3)
 * Env:   SYNC_CONFIG_STRICT=1 makes a DB failure fail the build (use on Vercel).
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { createClient } from "@supabase/supabase-js";
import { configSchema } from "./config-schema";
import { loadEnv, REPO_ROOT, supabaseAdminEnv, WEB_ROOT } from "./_env";

loadEnv();

const CONFIG_PATH = process.env.CONFIG_PATH
  ? path.resolve(WEB_ROOT, process.env.CONFIG_PATH)
  : path.join(REPO_ROOT, "config", "config.yaml");
const OUT_PATH = path.join(WEB_ROOT, "src", "generated", "app-config.json");
const STRICT = process.env.SYNC_CONFIG_STRICT === "1";
const GENERATE_ONLY = process.argv.includes("--generate-only");

function log(msg: string) {
  console.log(`[sync-config] ${msg}`);
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config not found at ${CONFIG_PATH}`);
  }
  const raw = parseYaml(fs.readFileSync(CONFIG_PATH, "utf8"));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(parsed.error.issues);
    throw new Error("config.yaml failed validation");
  }
  const cfg = parsed.data;
  const generatedAt = new Date().toISOString();

  const out = {
    generated_at: generatedAt,
    source: path.relative(WEB_ROOT, CONFIG_PATH),
    lot: {
      lot_id: cfg.parkinglot.lot_id,
      name: cfg.parkinglot.name,
      capacity: cfg.parkinglot.capacity,
      timezone: cfg.parkinglot.timezone,
      effective_pct: cfg.parkinglot.effective_capacity_pct ?? 0.85,
    },
    cameras: cfg.cameras,
    storage: { bucket: cfg.supabase.bucket ?? "event-snapshots" },
    auth: { bootstrap_admin_email: cfg.auth.bootstrap_admin_email ?? null },
    ai: cfg.ai,
    heartbeat: cfg.heartbeat,
    retention: cfg.retention,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  log(`wrote ${path.relative(WEB_ROOT, OUT_PATH)} (lot ${out.lot.lot_id}, capacity ${out.lot.capacity})`);

  if (GENERATE_ONLY) return;

  const env = supabaseAdminEnv();
  if (!env) {
    const msg = "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping DB sync";
    if (STRICT) throw new Error(msg);
    log(msg);
    return;
  }

  const db = createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: lotErr } = await db.from("lots").upsert(
    {
      lot_id: out.lot.lot_id,
      name: out.lot.name,
      capacity: out.lot.capacity,
      timezone: out.lot.timezone,
      settings: {
        effective_pct: out.lot.effective_pct,
        // engine.setting() reads this flat key for the online/offline cutoff.
        heartbeat_offline_s: out.heartbeat.offline_after_s,
        heartbeat: out.heartbeat,
        retention: out.retention,
      },
      config_synced_at: generatedAt,
    },
    { onConflict: "lot_id" },
  );
  if (lotErr) throw new Error(`lots upsert: ${lotErr.message}`);

  const { error: camErr } = await db.from("cameras").upsert(
    out.cameras.map((c) => ({ ...c, lot_id: out.lot.lot_id, active: true })),
    { onConflict: "camera_id" },
  );
  if (camErr) throw new Error(`cameras upsert: ${camErr.message}`);

  // Cameras removed from the YAML are deactivated, never deleted (history references them).
  const keep = out.cameras.map((c) => c.camera_id);
  const { error: deactErr } = await db
    .from("cameras")
    .update({ active: false })
    .eq("lot_id", out.lot.lot_id)
    .not("camera_id", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
  if (deactErr) log(`warning: could not deactivate removed cameras: ${deactErr.message}`);

  const { data: last, error: histErr } = await db
    .from("lot_capacity_history")
    .select("capacity, valid_from")
    .eq("lot_id", out.lot.lot_id)
    .order("valid_from", { ascending: false })
    .limit(1);
  if (histErr) throw new Error(`lot_capacity_history read: ${histErr.message}`);
  if (!last?.length || last[0].capacity !== out.lot.capacity) {
    const { error } = await db
      .from("lot_capacity_history")
      .insert({ lot_id: out.lot.lot_id, capacity: out.lot.capacity, valid_from: generatedAt });
    if (error) throw new Error(`lot_capacity_history insert: ${error.message}`);
    log(`capacity history: ${last?.[0]?.capacity ?? "∅"} → ${out.lot.capacity}`);
  } else {
    log(`capacity unchanged (${out.lot.capacity})`);
  }
  log(`synced lot + ${out.cameras.length} cameras to ${env.url}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (STRICT || (/config/.test(msg) && /validation|not found/.test(msg))) {
    console.error(`[sync-config] FAILED: ${msg}`);
    process.exit(1);
  }
  console.warn(`[sync-config] DB sync skipped: ${msg} (set SYNC_CONFIG_STRICT=1 to fail the build)`);
});
