# 09 — Roadmap & Milestones

> Phased delivery plan, updated for [doc 12](12-decisions-and-constraints.md) (D1–D28). Since the second round of answers:
> - legacy migration is removed (fresh start on event contract v2);
> - chat uses OpenAI;
> - Vercel Hobby;
> - a bootstrap admin;
> - only admins act;
> - heartbeats;
> - rejected tracks stay local.
>
> Durations assume **one full-stack developer** and are rough estimates. Feature IDs refer to doc 06.

---

## Phase 0: Foundations (≈ 1 week)

| Task | Detail |
|---|---|
| 0.1 Contracts | Freeze **event v2**, **heartbeat v1** and **config v2** (doc 13). The owner updates the producer: `schema_version`, `camera_id`, `device_id`, `captured_at_utc`, no credentials in `source`, heartbeat every 60 s, rejected tracks kept local. |
| 0.2 Config v2 | **Done 2026-10-12:** `config/config.yaml` is replaced with v2 and the secrets are moved to the repo-root `.env`. Still to do: **remove `config/` from `.gitignore`** so Vercel can read the file; copy the secrets into Vercel env vars; write `frontend/scripts/sync-config.ts` as the pre-build step. |
| 0.3 Supabase CLI project | `occupancy_analyzer/supabase/` with `migrations/`, `seed.sql` and `tests/`, run locally with `supabase start` (doc 14 §2). Every migration includes explicit GRANTs (the 2026-10-30 change). |
| 0.4 Fresh schema | Rename `events` to `events_v0`, then create the v2 `events` table plus `lots`, `cameras`, `lot_capacity_history`, `device_heartbeats` and `report_heartbeat()` (doc 04 §3–4). |
| 0.5 Auth bootstrap | Supabase email + password with public sign-up disabled. Bootstrap admin `mayuri.murugs@gmail.com` (from `config.yaml`), password from the `BOOTSTRAP_ADMIN_PASSWORD` env var, forced to change it. No emails are sent. Protect `/` (G4). |
| 0.6 Next.js upgrade | Move to the patched 16.x after 2026-10-14. |
| 0.7 Vercel Hobby project | Env vars, region pinned near Supabase, and a pre-build config sync. |
| 0.8 Backup | GitHub Actions: nightly `pg_dump` and crop deletion. |
| 0.9 Simulator + CI | **Build first:** `occupancy_analyzer/simulator` (`occsim`) emits v2 events, heartbeats and ground truth, and can replay them to local Supabase (doc 14 §3). CI runs lint, typecheck, Vitest, `supabase test db` and config-schema validation. |

**Exit criteria:**
- A v2 sample event uploads and lands in `events`.
- A heartbeat appears in `device_heartbeats`.
- Capacity is synced from config on deploy.
- The bootstrap admin can log in and is forced to change the password.
- The first backup exists.

---

## Phase 1: Session engine (≈ 2 weeks)

| Task | Detail |
|---|---|
| 1.1 Normalization | `plate_reads`: normalized plate, key, alternates, format prior, quality. |
| 1.2 Similarity | Weighted, confusion-aware Damerau–Levenshtein in plpgsql, with pgTAP tests. |
| 1.3 De-duplication | Reads → passes. |
| 1.4 Sessionizer | Entry/exit, margin rule, review state, re-entry, bounce (doc 03 §4). |
| 1.5 Occupancy | S1/S2, band, live and timeline tables, clamp log, `reconcile_recommended`. |
| 1.6 Flags | `suspect_stale`, `overnight` (03:00 local), `multi_day`. No automatic closure. |
| 1.7 Reconciliation | `reconcile_preview` / `reconcile_commit` (admin). |
| 1.8 Late data | Watermark, `resessionize`, and replay of overrides and reconciliations. pg_cron jobs. |
| 1.9 Heartbeat watch | Offline after 180 s; device status broadcast on change. |
| 1.10 RPCs and Realtime | Doc 04 §5–6. Admin-only write RPCs (D22). |
| 1.11 Size guards | `compact_reads` (7 days), `db_size_check`. |
| 1.12 Scenarios | All tests in doc 10 §2 pass. |

**Exit criteria:**
- A 14-day simulated replay gives auto-match precision ≥ 99.5 %.
- Mean residual at simulated reconciliations is ≤ 3 % of capacity.
- A shuffled-order replay gives identical results.

---

## Phase 2: MVP dashboard on Vercel Hobby (≈ 2–3 weeks)

| Task | Features |
|---|---|
| 2.1 Shell | Navigation, connection pill, **heartbeat device chips**, banners, bell, theme. |
| 2.2 Live | A1–A5, A7, A11, B7. |
| 2.3 **Reconcile** | `/admin/reconcile` with history (D4). |
| 2.4 Users | `/admin/users`: create staff and admins, reset passwords (H1). |
| 2.5 Analytics v1 | B1, B2, B3, with coverage strips (D2). |
| 2.6 Investigation | Sessions and reads tables, search (C1), drawer (C2), CSV (F1). |
| 2.7 Operations | Review queue (D3: admin resolves); in-app alerts (E1); health with devices, Free-tier gauges and config view (D1, D12, D13). |
| 2.8 Image route | Signed URL plus audit. |
| 2.9 E2E | Playwright and axe. |

**Exit criteria (MVP).** Running on Vercel Hobby against the real cameras:
- Occupancy updates within 5 s of a car passing.
- A camera unplugged shows "offline" within about 3 min.
- An admin can reconcile from a phone.
- Staff accounts are read-only.

**→ Field validation starts here** (doc 10 §4). The admin reconciles at least daily for 2 weeks.

---

## Phase 3: Pilot-complete (P1) (≈ 2–3 weeks)

| Area | Features |
|---|---|
| Health | Data quality (D5, D6, D9), accuracy report (D11), upload backlog and clock-skew alerts. |
| Analytics v2 | B4, B5, B6, B8, B9, B10, B11, B16, A6, A8. |
| Vehicles | Profile (C3), plate correction by admin (C4). |
| Reports | Parking Pulse (F2), saved views (F3). |
| Kiosk | `?kiosk=1`, with plates hidden by default (A10). |
| Governance | Audit log (H3); retention: 30-day pseudonymization and 14-day crops (H4); ALPR use policy (it mentions OpenAI processing) and signage. |
| Ask the lot | **OpenAI** function calling with in-process read-only SQL via Supavisor, new views and prompt, Postgres rate limiter (G1). |

**Exit criteria:**
- Two or more weeks of field data meet the doc 10 §4 targets.
- The reconciliation residual is ≤ 3 % of capacity on most days.
- The policy is written.

---

## Phase 4: Differentiators (P2) (≈ 2–3 weeks, pick by interest)

Forecast and ETA (B12, A9), self-calibrating OCR (D7), lot replay (B15), anomalies and annotations (B13, B14), chat-to-chart and narrative (G2, G3), read quality by hour (D8), health grade (D10), frequent visitors (C5), XLSX export (F4).

---

## Phase 5: Post-pilot (production and multi-lot, D14)

| Task | Detail |
|---|---|
| Plans | **Supabase Pro** (backups, logs, limits). **Vercel Pro** (commercial use). |
| Multi-lot | `parkinglots:` list in config, `user_lots` scoping in RLS and Realtime, lot switcher, portfolio overview, per-lot reconciliation. |
| Revisit | Notifications, scheduled reports, open hours, uploading rejected tracks, nightly re-match. Only if the pilot shows a need. |
| P3 | Video jump-to (D15), weather overlay (B18). |

---

## Milestone summary

| Milestone | When (est.) | Demo |
|---|---|---|
| M0 Foundations | end of week 1 | v2 event and heartbeat ingested; config synced on deploy; bootstrap admin login |
| M1 Engine | week 3 | Replay metrics (precision, residuals) |
| **M2 MVP live on Vercel Hobby** | week 5–6 | Live dashboard on real cameras; device offline detection; admin reconciliation from a phone |
| M3 Pilot-complete | week 8–9 | Accuracy report, full analytics, OpenAI chat |
| M4 Differentiators | week 11–12 | Forecast, replay, self-calibration |
| M5 Production / multi-lot | post-pilot | Second lot onboarded via config |

## Before starting

All decisions are made (D1–D28). The only housekeeping left before the first Vercel deploy:
- remove `config/` from `.gitignore`, so the Vercel build can read the now secret-free `config/config.yaml`;
- copy the secrets from `.env` into the Vercel project env vars, and add `BOOTSTRAP_ADMIN_PASSWORD`.
