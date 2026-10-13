/**
 * Env loading for the tsx scripts (Next.js loads .env.local itself at runtime).
 *
 * Order: web/.env.local, web/.env, then ONLY the allow-listed keys from the
 * repo-root ../../.env (BOOTSTRAP_ADMIN_PASSWORD, OPENAI_API_KEY). The root
 * .env also holds the *hosted* Supabase URL/key for the Python producer; we
 * deliberately never pick those up so a local build cannot write to hosted.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

export const WEB_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");

const ROOT_ALLOW = ["BOOTSTRAP_ADMIN_PASSWORD", "OPENAI_API_KEY"];

function loadFile(file: string, allow?: string[]) {
  if (!fs.existsSync(file)) return;
  const parsed = parse(fs.readFileSync(file));
  for (const [k, v] of Object.entries(parsed)) {
    if (allow && !allow.includes(k)) continue;
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}

export function loadEnv() {
  loadFile(path.join(WEB_ROOT, ".env.local"));
  loadFile(path.join(WEB_ROOT, ".env"));
  loadFile(path.join(REPO_ROOT, ".env"), ROOT_ALLOW);
}

export function supabaseAdminEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return { url, key };
}
