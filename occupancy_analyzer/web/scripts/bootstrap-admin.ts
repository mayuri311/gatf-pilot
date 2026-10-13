/**
 * Idempotent bootstrap of the default admin (plan D21/D28, CONTRACT §6).
 *   email    = config.yaml auth.bootstrap_admin_email
 *   password = env BOOTSTRAP_ADMIN_PASSWORD (repo-root .env is allowed)
 *   app_metadata = { role: 'admin', must_change_password: true }, email_confirm: true
 * Re-running never resets an existing user's password; it only ensures role=admin.
 * Pass --reset-password to force the password back to BOOTSTRAP_ADMIN_PASSWORD.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { createClient } from "@supabase/supabase-js";
import { configSchema } from "./config-schema";
import { loadEnv, REPO_ROOT, supabaseAdminEnv } from "./_env";

loadEnv();

async function main() {
  const cfg = configSchema.parse(
    parseYaml(fs.readFileSync(path.join(REPO_ROOT, "config", "config.yaml"), "utf8")),
  );
  const email = cfg.auth.bootstrap_admin_email?.toLowerCase();
  if (!email) throw new Error("auth.bootstrap_admin_email missing in config.yaml");
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) throw new Error("BOOTSTRAP_ADMIN_PASSWORD is not set (web/.env.local or repo-root .env)");
  const env = supabaseAdminEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");

  const db = createClient(env.url, env.key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Find an existing user by email (paged; the pilot has a handful of users).
  type Found = { id: string; app_metadata: Record<string, unknown> };
  let existing: Found | null = null as Found | null;
  for (let page = 1; page < 50 && !existing; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email);
    if (u) existing = { id: u.id, app_metadata: (u.app_metadata ?? {}) as Record<string, unknown> };
    if (data.users.length < 200) break;
  }

  if (!existing) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "admin", must_change_password: true },
    });
    if (error) throw error;
    console.log(`[bootstrap-admin] created ${email} (${data.user?.id}); must change password at first login`);
    return;
  }

  const reset = process.argv.includes("--reset-password");
  const meta = existing.app_metadata ?? {};
  const needsRole = meta.role !== "admin";
  if (needsRole || reset) {
    const { error } = await db.auth.admin.updateUserById(existing.id, {
      ...(reset ? { password } : {}),
      app_metadata: { ...meta, role: "admin", ...(reset ? { must_change_password: true } : {}) },
    });
    if (error) throw error;
  }
  console.log(
    `[bootstrap-admin] ${email} already exists (${existing.id})` +
      (needsRole ? " — role set to admin" : "") +
      (reset ? " — password reset, change required" : ""),
  );
}

main().catch((err) => {
  console.error(`[bootstrap-admin] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
