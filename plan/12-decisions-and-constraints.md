# 12 — Decisions & Constraints

> Stakeholder answers (round 1: Q1–Q15; round 2: Q-A–Q-J, both 2026-10-12) and what each one changes in the design. **This document overrides any earlier doc that disagrees with it.** Docs 01–11 have been updated to match.
>
> **Overall direction: keep it simple.** No barrier logic, no vehicle classes, no notifications, no public page, no pricing, no legacy migration.

---

## 1. Decision table

| # | Topic | Decision | Design consequence |
|---|---|---|---|
| D1 | Capacity | `config/config.yaml` → `parkinglot.capacity` | Synced to the DB on every Vercel deploy. Read-only in the UI (§2). |
| D2 | Reset | **Admin-driven reconciliation** from a visual count; no automatic reset | §3 workflow |
| D3 | Overnight / multi-day | Not allowed, but assumed to happen | Flagged and counted, never dropped |
| D4 | Roles | `admin`, `staff` | See D22 for who can do what |
| D5 | Special vehicles | None; every vehicle is treated the same | No lists or segments |
| D6 | Retention | 30 days plaintext plates, 14 days crops | Plus compaction of the per-frame `reads[]` after 7 days (§4) |
| D7 | Hosting | Vercel | §5 |
| D8 | Database | Supabase Free for the PoC | §4 |
| D9 | Producer fields | The producer adds `captured_at_utc` and `device_id` | Event contract v2 (doc 13) |
| D10 | Barrier | None; keep it simple | No tailgate or U-turn rules, no batch re-match |
| D11 | Public page | Not needed | Internal TV mode only |
| D12 | Notifications | None yet | In-app banner and inbox only |
| D13 | Revenue | None | — |
| D14 | Multi-lot | After the pilot | `lot_id` everywhere from day 1 |
| ~~D15~~ | ~~Legacy data: migrate~~ | **Superseded by D16** | — |
| **D16** | Legacy data (Q-A) | **Not migrated. Fresh start.** The producer will emit new JSON that follows contract v2. | The `events` table is created fresh (old table renamed to `events_v0` and ignored). No legacy cameras, flags or migration tool. |
| **D17** | Config (Q-B) | **Vercel only. The config is simplified.** | Proposed `config.yaml` v2 removes `server`, `ai.chat_store_path`, `logging` and the inline keys; adds `cameras`, `heartbeat` and `retention` (doc 13 §3) |
| **D18** | LLM (Q-C) | **OpenAI only** | The "Ask the lot" chat route moves from the Anthropic SDK to the OpenAI SDK with function calling, using the same `execute_sql` tool and guards. The model is set in `config.yaml` (`ai.model`). |
| **D19** | Vercel plan (Q-D) | **Hobby for the PoC** | 300 s function limit with Fluid Compute is fine. Revisit Pro when the pilot becomes production (Hobby is described as non-commercial). No Vercel Cron dependence. |
| **D20** | Open hours (Q-E) | **Keep it very simple: no open-hours config** | "Overnight" means present at **03:00 local**. Camera health comes from **heartbeats**, not from "no reads during open hours". |
| **D21** | Admin accounts (Q-F) | **One default admin, created from env vars**; other accounts are **invite-only** | Email + password auth. The bootstrap admin comes from `auth.bootstrap_admin_email` (config) plus the `BOOTSTRAP_ADMIN_PASSWORD` env var and must change the password at first login. The admin creates staff accounts (email + temporary password) in `/admin/users`, so no outbound email is needed. Public sign-up is disabled. |
| **D22** | Review queue (Q-G) | **Only admins resolve** | **Staff is read-only:** they view everything, search, export and chat. **Admin:** resolves matches, corrects plates, acknowledges alerts, reconciles, manages users. |
| **D23** | Heartbeat (Q-H) | **Every 60 s**, simple flat JSON | Contract in doc 13 §2. Latest row per device only. Offline after 180 s. Also keeps the Free project from pausing. |
| **D24** | Rejected tracks (Q-I) | **Bare minimum: not uploaded** | Rejected tracks stay local. No unknown-plate passes. Missed reads are absorbed by admin reconciliation. |
| **D26** | OpenAI model | **`gpt-5.6-terra`** | `ai.model` in `config/config.yaml` |
| **D27** | Config v2 | **Approved and applied** on 2026-10-12 | `config/config.yaml` is overwritten with v2. Its former keys were moved to the repo-root `.env` (gitignored). **Remove `config/` from `.gitignore`** so Vercel can read the file. |
| **D28** | Default admin | **`mayuri.murugs@gmail.com`** | `auth.bootstrap_admin_email` in config, password from the `BOOTSTRAP_ADMIN_PASSWORD` env var. **No real emails are sent**: accounts are created server-side with `email_confirm: true`, and the admin resets passwords (doc 08 §2). |
| **D25** | Keys (Q-J) | **The owner accepts the current key handling** | The plan doesn't block on rotation. Practical constraint: Vercel reads secrets only from project env vars, and the committed YAML must not contain them (doc 13 §3). |

---

## 2. D1 + D17: configuration

- **Proposed file:** [`samples/config.yaml`](samples/config.yaml), explained in [doc 13 §3](13-data-contracts.md). It is single-lot now. Multi-lot later turns `parkinglot` + `cameras` into a list of lots.
- **Sync:** a Vercel pre-build step (`scripts/sync-config.ts`) validates the YAML and upserts `lots`, `cameras` and `lot_capacity_history`. Change capacity by editing the YAML and redeploying.
- **Capacity history:** historical "% full" uses the capacity that applied at that time.
- **Secrets** live in Vercel env vars and the Jetson `.env` (D25). The real `config/config.yaml` is not modified by this plan.

---

## 3. D2 + D3 + D20 + D22: reconciliation, flags and roles

- **No automatic resets.** Sessions close only in these ways:
  - a matched exit;
  - a re-entry of the same plate;
  - **admin reconciliation**;
  - the 30-day retention bound.
- **Flags:**
  - `suspect_stale`: open longer than 24 h;
  - `overnight`: present at 03:00 local (D20);
  - `multi_day`: open longer than 24 h.

  Flags never close a session.
- **Reconcile occupancy** (admin only, one screen, works on a phone):

```
1. Admin counts the cars → enters N (+ optional note).
2. Screen: estimate S1 (with band), open sessions S2, difference to N.
3. System proposes residue to close: suspect_stale / multi_day → oldest → lowest-confidence.
   Admin can untick or mark "still here".
4. Confirm → selected sessions → `closed_admin`; S1 re-anchored to N; residual (estimate − N) stored;
   band collapses to ±0; audit-logged.
```

- **"Reconcile recommended" banner** (in-app) when:
  - the band half-width exceeds 2 % of capacity;
  - `abs(S2 − S1)` exceeds 3; or
  - suspect-stale sessions exist at 06:00.
- **Review queue:** only admins resolve (D22). Staff see the queue read-only.

---

## 4. D6 + D8: Supabase Free sizing and operations

The template `event.json` is ~11.4 KB, of which **`reads[]` is ~10.6 KB**. `plate.jpg` is 3.4 KB.

| Volume | 30 days of rows, full `reads[]` | With compaction (full `reads[]` 7 days, then top-5 alternates) | Crops over 14 days |
|---|---|---|---|
| 200 reads/day | ~70 MB | ~20 MB | ~10 MB |
| 2 000 reads/day | **~690 MB, over the 500 MB limit** | ~170 MB | ~95 MB |

| Free-tier constraint | Mitigation |
|---|---|
| 500 MB database | Compact `reads[]` after 7 days. DB-size gauge, with an in-app warning at 70 %. |
| **No backups** | Nightly GitHub Actions `pg_dump`, kept 14 days. |
| Pauses after 7 days of inactivity | **Heartbeats every 60 s from both Jetsons** count as activity (D23). |
| 2 M Realtime messages/month, 200 connections | One message per pass. Heartbeat changes are broadcast only when status changes. Idle tabs unsubscribe. |
| Logs kept 1 day | Audit log and ingest errors live in tables. |
| Upgrade trigger | Production, multi-lot, or database over ~350 MB → Pro. |

---

## 5. D7 + D18 + D19: Vercel and OpenAI

| Topic | Decision |
|---|---|
| Plan | **Hobby** for the PoC (D19). |
| Chat transport | In-process `execute_sql` running postgres.js as `gatf_readonly` through the Supavisor pooler (port 6543, `prepare: false`, IPv4). Replaces the localhost `postgres-mcp` sidecar. |
| Chat model | **OpenAI** (D18), using the `openai` npm SDK with function calling. Model id comes from `config.yaml` `ai.model`; the API key comes from `OPENAI_API_KEY`. The existing safety design stays: read-only role, view-only grants, `statement_timeout`, row and character caps, loop bounds, history sanitization, coverage-first prompt, SQL provenance. |
| Plate data sent to the LLM | Query results containing plates go to OpenAI's API. Note this in the ALPR use policy. Prefer aggregate views in the prompt so plates are sent only when a question needs them. |
| Rate limiting | Postgres table + RPC (the in-memory limiter is useless across Vercel instances). |
| Scheduling | pg_cron for in-DB jobs. GitHub Actions only for the nightly backup and crop deletion. Config sync runs in the Vercel build. |
| Region | Functions pinned near the Supabase region. |

---

## 6. D16: fresh start instead of legacy migration

- The old `events` table is renamed to `events_v0` and left untouched. Drop it once the pilot is running.
- A clean `events` table matching **contract v2** (doc 13 §1) is created, and the new pipeline uses only that.
- The old views (`scripts/lot_views.sql`) and the old chat prompt are retired.
- **Producer to-do (owner):** emit v2 JSON, send heartbeats, keep rejected tracks local.
