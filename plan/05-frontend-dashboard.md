# 05 — Frontend Dashboard (Next.js on Vercel Hobby)

> Information architecture, page-by-page specification, tech stack and client data flow. Updated for [doc 12](12-decisions-and-constraints.md) (D1–D28):
> - roles `admin` and `staff` (staff is read-only);
> - admin reconciliation;
> - no public page and no notifications;
> - Vercel Hobby hosting with OpenAI chat;
> - heartbeats drive device health;
> - no legacy data.
>
> Chart guidance is in [07-visualization-and-ux-guide.md](07-visualization-and-ux-guide.md). The features are in [06-feature-catalog-and-kpis.md](06-feature-catalog-and-kpis.md).

---

## 1. Tech stack (decisions)

| Concern | Choice | Why |
|---|---|---|
| Framework | **Next.js 16.x** (upgrade from 16.2.12 after the 2026-10-14 security release), App Router, React 19, TypeScript strict | Already in the repo. Read `node_modules/next/dist/docs/` before coding (per `frontend/AGENTS.md`). |
| Hosting | **Vercel Hobby** (PoC), with functions pinned near the Supabase region | D19 |
| Styling / UI | Tailwind v4 + **shadcn/ui** | |
| Charts | **shadcn/ui charts (Recharts v3)**; custom CSS-grid heatmap and calendar; ECharts 6 lazy-loaded only if box plots or zoom are needed | Doc 02 §6 |
| Server state | **TanStack Query v5** + React Server Components for initial data | |
| Tables | **TanStack Table** + **TanStack Virtual** | |
| URL state | **nuqs** | Shareable links and saved views |
| Dates | **date-fns v4 + `@date-fns/tz`**, explicit `America/New_York` | |
| Feedback | `@number-flow/react`, Sonner (in-app only) | D12 |
| Auth | **Supabase Auth (email + password) via `@supabase/ssr`**; bootstrap admin from env; `proxy.ts` uses `getClaims()` | D21 |
| AI | **`openai` SDK** with function calling; model from `config.yaml` `ai.model` | D18 |
| DB for chat | postgres.js as `gatf_readonly` through Supavisor | The localhost sidecar is not possible on Vercel |
| Config | `config/config.yaml` read at build time; `scripts/sync-config.ts` pre-build step | D1, D17 |
| Tests | Vitest + RTL, Playwright + axe | Doc 10 |

---

## 2. Information architecture

```
/                       Live (overview)                      staff, admin
/analytics              Analytics hub                        staff, admin
   ?tab=occupancy|flow|dwell|patterns|compare|forecast
/sessions               Sessions (stays)                     staff, admin
/reads                  Plate reads log + gallery            staff, admin
/vehicles/[plate]       Vehicle profile (audited)            staff, admin
/review                 Match review queue                   staff: view · admin: resolve
/alerts                 In-app alert inbox                   staff: view · admin: ack/resolve
/health                 Devices (heartbeats), data quality   staff, admin
/health/accuracy        Accuracy report (residual history)   staff, admin
/reports                On-demand reports & exports          staff, admin
/ask                    "Ask the lot" (OpenAI)               staff, admin
/admin/reconcile        ★ Reconcile occupancy                admin
/admin/users            Create staff/admin, reset password   admin
/admin/config           Read-only synced config + status     admin
/admin/audit            Audit log                            admin
/login                  Email + password (forced change on first admin login)
```

**Global chrome:**
- connection pill;
- **device chips** driven by heartbeats ("IN ● online · last read 12 s", "OUT ● offline 4 min");
- **banners** for "Reconcile recommended", "Camera offline" and "DB size";
- alerts bell, theme toggle, user menu.

The lot selector stays hidden until there is more than one lot.

---

## 3. Page specifications

### 3.1 Live (`/`)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ GATF Lot     ● Live   IN ● 12s   OUT ● 41s          🔔 2      ☾     user ▾       │
│ ⚠ Reconcile recommended — band ±4, 2 vehicles here > 24 h          [Reconcile]  │
├──────────────────────────┬────────────────────────────────────────────────────┤
│  42 / 100   ≈ (39–46)    │  Today vs typical Tuesday                          │
│  58 spaces free          │  ── today (step)  ░░ p10–p90  ── median  ┄ 85 %     │
│  ▓▓▓▓▓▓▓▓░░░░░  42 %  ●  │                                                    │
│  Available               │                                                    │
│  last reconciled 08:05   │                                                    │
├──────────┬───────────────┴──────┬─────────────────────┬───────────────────────┤
│ In today │ Out today │ Bounces  │ Avg dwell (closed)  │ Overnight / multi-day │
│  187 ▲12%│  145      │  6       │  1 h 52 m           │  3                    │
├──────────┴───────────┴──────────┴──────────┬──────────┴───────────────────────┤
│ Live feed (pausable)                       │ In the lot now (swimlanes)        │
│ 10:42:13 ▶IN  [crop] ABC1234   0.97        │ ███████████████ 7h 12m  ABC1234   │
│ 10:41:58 ◀OUT [crop] Z94PVE 0.93 ↔ 2h 3m   │ ██████████ 4h 05m      Z94PVE     │
│ 10:41:02 ◀OUT [crop] KLM5S21 0.61 ⚠ review │ ▒▒▒ 26h ⏾ multi-day   KLM5521    │
└────────────────────────────────────────────┴───────────────────────────────────┘
```

- **Hero tile.** Shows:
  - occupancy (S1) with the uncertainty band;
  - spaces free;
  - a bullet bar marking 85 % of capacity;
  - the state shown as a shape plus a label;
  - "last reconciled";
  - a capacity tooltip ("from config/config.yaml").
  - When data is stale, the tile greys out and adds "as of …".
- **Today vs typical.** A fan chart, showing the median only until about 3 weeks of history exist.
- **KPI strip.** Entries, exits, bounces, average dwell, and overnight/multi-day count.
- **Live feed.**
  - Each row shows a crop thumbnail (served via `/api/images`) and a match badge.
  - Exits show their dwell time.
  - A pause control stops the feed from scrolling.
  - Clicking a row opens the session drawer.
- **In the lot now.** Swimlanes, with ⏾ badges for suspect-stale and multi-day sessions.
- **Data flow.**
  1. The React Server Component calls `get_live_snapshot`.
  2. The client subscribes to the `lot:<id>` channel and listens for `update`, `device` and `alert` messages.
  3. On every `SUBSCRIBED`, the client refetches the snapshot.

### 3.2 Analytics (`/analytics`)

**Shared URL controls:**
- date presets and custom range;
- compare-to;
- weekday filter;
- exclude bounces;
- exclude low-quality reads.

| Tab | Content |
|---|---|
| **Occupancy** | Step-line with capacity (history-aware) and an 85 % line, plus the band. Peak markers, "hours ≥ 85 %", daily peak bars, calendar heatmap, and **reconciliation markers showing the residual**. |
| **Flow** | Diverging arrival/departure bars, cumulative flow, peak hour factor (PHF), bounces. |
| **Dwell** | Histogram, median and P90, duration-by-arrival heatmap, box plots by weekday, overnight/multi-day per night. |
| **Patterns** | Hour × weekday heatmap and "typical week" small multiples. |
| **Compare** | Two ranges side by side, with a KPI delta table. |
| **Forecast** (P2) | 7-day peak forecast, intraday cone, MAE. |

Every chart has:
- a coverage strip, with gaps derived from reads plus heartbeat downtime;
- a table view;
- CSV download;
- a KPI-definition tooltip.

### 3.3 Sessions (`/sessions`) and Reads (`/reads`)

- **Facets.** Status, match method, direction, camera, quality, dwell bucket, flags, and plate search (exact or similar).
- **Sessions table.** Columns: entry, exit, dwell, plate, crops on hover, match, flags.
- **Reads view.**
  - Toggles between a table and a gallery.
  - The drawer shows the crop, per-character confidence, the `reads[]` timeline (alternates only after 7 days), and links.
  - **"Correct plate" is admin only.**
- **Export.** CSV, plus saved views.

### 3.4 Vehicle profile (`/vehicles/[plate]`), audited

Shows:
- visit history and crops;
- dwell trend and usual arrival time;
- aliases and misreads;
- overnight history;
- notes (admin edits).

After 30 days only the pseudonym is shown.

### 3.5 Review (`/review`)

The review card shows the exit crop against the top 3 candidate entry crops, with a per-character diff, scores and the dwell each candidate implies.

- **Admin:** Confirm / Pick other / No match / Mark misread, with keyboard shortcuts. Decisions are saved in `match_overrides`.
- **Staff:** the same cards, read-only, with a note that only admins can resolve.

### 3.6 Alerts (`/alerts`)

An in-app inbox. Staff can view it; admins can acknowledge and resolve. The rules come from a fixed catalog with thresholds from config (doc 06 §4).

### 3.7 Health (`/health`)

- **Devices (from heartbeats):**
  - online/offline;
  - `status`, `camera_connected`, fps;
  - `pending_uploads`, clock offset, uptime, `app_version`, `message`;
  - last heartbeat;
  - last read.
- **Data quality:**
  - read rate and match rate;
  - orphan rate;
  - suspect-stale count;
  - drift meter (S2 − S1);
  - **residual history**;
  - read quality by hour.
- **Platform:** DB size vs 500 MB, storage vs 1 GB, cron failures, last backup, last config sync.
- **`/health/accuracy`:** the weekly accuracy report.

### 3.8 Reports (`/reports`)

An on-demand "Parking Pulse" for a day, week or month, as CSV or PDF. It covers:
- peak occupancy;
- hours ≥ 85 %;
- turnover;
- average length of stay (ALOS);
- unique vehicles;
- bounces;
- overnight count;
- residual.

### 3.9 Ask the lot (`/ask`, evolves `/chat`), OpenAI (D18)

The hardened design stays the same. Only the provider and the transport change:
- **Provider and transport.** The `openai` SDK with function calling runs an in-process `execute_sql` tool, using postgres.js as `gatf_readonly` through Supavisor.
- **Prompt.** A static description of the views. Questions are answered from aggregates where possible, so fewer plates go to OpenAI.
- **Rate limits.** Enforced through Postgres.
- **History.** Kept in the browser only (no `chat_store_path`).
- **Chat-to-chart (P2).** Generated SQL is shown in a collapsible panel.
- **Suggested questions.** For example: "Busiest hour last week?", "Overnight cars this month?", "How far off was the last reconciliation?"
- **Off switch.** `ai.enabled: false` in config hides the page.

### 3.10 Admin

| Page | Content |
|---|---|
| **`/admin/reconcile`** ★ | Four steps: (1) enter the visual count N; (2) compare N, S1 with its band, and S2; (3) review the proposed residue (thumbnails, keep/close checkboxes, and a live counter such as "closing 11 → open = 41"); (4) Confirm. A History tab lists past reconciliations. Works on a phone. |
| `/admin/users` | Create user (email + temporary password + role), reset password, deactivate. The bootstrap admin is forced to change the default password at first login. Audited. |
| `/admin/config` | Read-only view of the synced `config.yaml`: lot, capacity and its history, cameras/devices, heartbeat and retention settings, AI model. Shows the last sync and deploy, and a note: "To change: edit config/config.yaml → push → Vercel redeploys". |
| `/admin/audit` | Audit log viewer. |

---

## 4. Client data flow

```
RSC page ──(server supabase client, user JWT)──► RPC ──► initial props
   ▼
Client components ── TanStack Query ──┐  setQueryData from 'update' / 'device' / 'alert'
   └── useLotChannel(lotId) ── Realtime private channel
          on SUBSCRIBED → refetch snapshot; idle > 30 min → unsubscribe; error → 15 s polling
```

The browser only ever holds the publishable key and the user's session.

---

## 5. TV / kiosk mode (internal)

`/?kiosk=1` runs on a staff login on an office screen. It:
- hides navigation and uses dark mode;
- scales type to the viewport;
- keeps the screen awake (Wake Lock);
- rotates views;
- auto-reloads after each deploy;
- **hides plates and crops by default**.

---

## 6. Responsive and accessibility

- **Mobile.** Hero and banners come first, and the feed becomes cards. The reconcile page is designed for a phone.
- **WCAG 2.2 AA:**
  - a pause control on the live feed;
  - a single throttled status region;
  - targets of at least 24 px;
  - a table view for every chart;
  - never colour alone.

---

## 7. Directory layout (proposed)

```
occupancy_analyzer/web/src/        (new app; the old frontend/ is left untouched — doc 14)
  app/(dash)/page.tsx  analytics/  sessions/  reads/  vehicles/[plate]/  review/  alerts/  health/  reports/  ask/
  app/(admin)/admin/{reconcile,users,config,audit}/page.tsx
  app/login/page.tsx
  app/api/images/[readId]/route.ts  app/api/export/[kind]/route.ts  app/api/health/route.ts  app/api/chat/route.ts
  components/{charts,live,tables,reconcile,ui}/*
  lib/supabase/{server,browser,admin}.ts   lib/db/readonly.ts   lib/ai/openai.ts
  lib/realtime/useLotChannel.ts   lib/format/*   lib/auth/rbac.ts   lib/rpc/*   lib/config.ts (parsed config.yaml)
  proxy.ts            (protect everything except /login)
occupancy_analyzer/web/scripts/sync-config.ts      (Vercel pre-build)
occupancy_analyzer/web/scripts/bootstrap-admin.ts  (idempotent default admin, no email)
```
