import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import type { NextConfig } from "next";

/**
 * Local convenience: the repo-root .env (gitignored) holds OPENAI_API_KEY for the
 * Python tools. Pick up ONLY that key (and only when not already set) so the chat
 * route works locally without duplicating secrets. On Vercel, env vars are set
 * in the project settings and this is a no-op.
 */
(() => {
  const rootEnv = path.resolve(process.cwd(), "..", "..", ".env");
  try {
    if (!process.env.OPENAI_API_KEY && fs.existsSync(rootEnv)) {
      const parsed = parse(fs.readFileSync(rootEnv));
      if (parsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = parsed.OPENAI_API_KEY;
    }
  } catch {
    /* ignore */
  }
})();

/**
 * Cache Components is intentionally OFF: every page is per-user, auth-gated and
 * live (realtime occupancy), so there is no static shell worth prerendering and
 * request-time rendering keeps the auth model simple (proxy.ts + server checks).
 */
const nextConfig: NextConfig = {
  // Pin the workspace root: a stray ~/package-lock.json otherwise makes Turbopack guess the home dir.
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
