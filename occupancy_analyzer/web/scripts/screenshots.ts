/**
 * Visual QA: logs in and screenshots pages in dark + light at 1440×900.
 *
 *   BASE_URL=http://localhost:3000 SHOT_EMAIL=… SHOT_PASSWORD=… OUT_DIR=./shots \
 *   PAGES="/,/analytics" THEMES=dark,light FULL=1 npx tsx scripts/screenshots.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve(process.env.OUT_DIR ?? "shots");
const EMAIL = process.env.SHOT_EMAIL ?? "";
const PASSWORD = process.env.SHOT_PASSWORD ?? "";
const PAGES = (process.env.PAGES ?? "/").split(",").filter(Boolean);
const THEMES = (process.env.THEMES ?? "dark,light").split(",");
const FULL = process.env.FULL === "1";
const WIDTH = Number(process.env.WIDTH ?? 1440);
const HEIGHT = Number(process.env.HEIGHT ?? 900);

const slug = (p: string) => (p === "/" ? "live" : p.replace(/^\//, "").replace(/[/?=&]+/g, "_"));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: theme === "light" ? "light" : "dark" });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("theme", t);
      } catch {}
    }, theme);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
    if (EMAIL) {
      await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await page.fill("#email", EMAIL);
      await page.fill("#password", PASSWORD);
      await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), page.click("button[type=submit]")]);
    }
    for (const p of PAGES) {
      await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 1200));
      const file = path.join(OUT, `${slug(p)}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: FULL });
      console.log(file);
    }
    await ctx.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
