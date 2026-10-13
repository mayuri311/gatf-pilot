# GATF Parking Occupancy Dashboard — Plan

> Planning package for a parking occupancy dashboard and its backend, driven by license-plate reads. Written 2026-10-12, then revised the same day after **two rounds of stakeholder answers**; the decisions are in [doc 12](12-decisions-and-constraints.md). **No source code has been created or modified.** The SQL and code fragments are design sketches, and [`samples/`](samples/) holds the proposed JSON and config contracts.

## The setup in one paragraph

A surface lot in Pennsylvania, where cars carry a single rear plate. There is one entry lane and one exit lane, with no barrier arm. A rear-facing camera on each lane feeds a Jetson. The Jetson emits one **event v2 JSON** per finalized plate track and a **heartbeat every 60 s** (doc 13). Direction comes from `camera_id`. Events and crops sync to **Supabase Free**. The dashboard runs on **Vercel Hobby**. Capacity and cameras live in `config/config.yaml`.

## Stakeholder decisions: keep it simple

| Decided | Not in scope (for now) |
|---|---|
| Capacity and cameras come from `config/config.yaml` (v2, Vercel only), synced on every deploy | Automatic or scheduled resets; open-hours configuration |
| **The admin reconciles occupancy** from a visual count | Vehicle lists or classes: every vehicle is treated the same |
| Overnight and multi-day stays are flagged (present at 03:00), never dropped | Notifications: in-app only |
| Roles: **admin** acts; **staff** has read-only access | Public page and signage |
| Bootstrap admin `mayuri.murugs@gmail.com` must change the password at first login; the admin creates other accounts; **no emails are sent** | Revenue and pricing |
| Retention: 30 days for plaintext plates, 14 days for crops; `reads[]` compacted after 7 days | Barrier, tailgate and U-turn logic |
| Vercel Hobby and Supabase Free for the PoC | **Legacy data migration**: fresh start on event v2 |
| **OpenAI `gpt-5.6-terra`** for "Ask the lot" | Uploading rejected tracks |
| Event v2 (`captured_at_utc`, `device_id`), heartbeat every 60 s | Multi-lot comes **after** the pilot; the schema is ready from day 1 |

## Executive summary

1. **Occupancy is built from parking sessions.** Each exit read is paired with an entry read by plate. The matcher tolerates OCR confusions and weights each character by its confidence, using the alternate readings already in `reads[]`. It only compares against cars currently in the lot. A margin rule and an admin review queue catch ambiguous cases. Details are in doc 03.
2. **The headline number is the flow count (entries − exits), shown with an honest uncertainty band.** Sessions drive dwell time and "who's in the lot". **The admin corrects drift**: they count the cars, and the system proposes which ghost sessions to clear and records the residual. That residual is the pilot's accuracy metric.
3. **The backend lives in Postgres.**
   - A fresh `events` table on contract v2.
   - An insert trigger that builds reads, passes and sessions, updates occupancy, and sends one Realtime Broadcast per pass.
   - `report_heartbeat()` for device health, which also keeps the Free project from pausing.
   - pg_cron for late data, flags, rollups, compaction and retention.
   - GitHub Actions only for the nightly backup and crop deletion. Config sync happens in the Vercel build.
4. **The frontend has four modes plus a TV mode.**
   - **Live:** the hero number with its band, today vs a typical day, the feed, who's in the lot, and device chips.
   - **Analytics:** occupancy, flow, dwell, heatmaps, compare.
   - **Investigate:** sessions, reads, search, and a review queue that only admins can resolve.
   - **Admin:** reconcile, users, config view, audit log.
   - "Ask the lot" moves to **OpenAI** and uses an in-process read-only SQL tool so it runs on Vercel.
5. **Do first:**
   - Producer emits event v2 and heartbeats (samples are provided).
   - Apply config v2.
   - Fresh schema.
   - Bootstrap admin.
   - Protect `/`.
   - Platform deadlines: the Supabase Data API GRANT change on **2026-10-30** and the Next.js security release on **2026-10-14**.

## Documents

| # | Document | What's inside |
|---|---|---|
| 01 | [Current state & gaps](01-current-state-and-gaps.md) | Repo inventory, producer event shape, 15 gaps with resolutions |
| 02 | [Research findings](02-research-findings.md) | Market scan, KPIs, matching literature, PA plates, legal context, platform facts (Supabase Free and Vercel), UX findings, with sources |
| 03 | [Domain model & algorithms](03-domain-model-and-algorithms.md) | Normalization, de-dup, fuzzy matching, session lifecycle and flags, occupancy band, admin reconciliation, late data, quality metrics |
| 04 | [Backend architecture](04-backend-architecture.md) | Diagram, fresh v2 schema, trigger pipeline, heartbeat RPC, jobs, RPC/API (admin-only writes), realtime, OpenAI chat, pitfalls, producer changes |
| 05 | [Frontend dashboard](05-frontend-dashboard.md) | Stack, routes, page specs with a wireframe, reconcile page, users, chat, data flow, directory layout |
| 06 | [Feature catalog & KPIs](06-feature-catalog-and-kpis.md) | Prioritized catalog, descoped list, KPI dictionary, in-app alert rules, demo list |
| 07 | [Visualization & UX guide](07-visualization-and-ux-guide.md) | Chart chooser, colour and accessibility, realtime UX, formatting, plate display rules |
| 08 | [Security, privacy & compliance](08-security-privacy-compliance.md) | Practical secrets minimum, threat model, admin/staff matrix, bootstrap admin, retention, OpenAI processing, audit, backups |
| 09 | [Roadmap & milestones](09-roadmap-and-milestones.md) | Phases 0–5; MVP live on Vercel Hobby around week 5–6; multi-lot after the pilot |
| 10 | [Testing & validation](10-testing-and-validation.md) | Test pyramid, 20 scenarios (including heartbeat, contract and role tests), simulator, field validation via reconciliations |
| 11 | [Risks & open questions](11-risks-and-open-questions.md) | All questions resolved; 14 risks |
| 12 | [Decisions & constraints](12-decisions-and-constraints.md) | **Authoritative** record of D1–D28 and their consequences |
| 13 | [Data contracts](13-data-contracts.md) | **Event v2**, **heartbeat v1** and **config v2**, with [samples](samples/) |
| 14 | [Implementation layout, offline testing & simulator](14-implementation-layout-offline-testing-simulator.md) | `occupancy_analyzer/` folder layout, 3 levels of offline testing (files → local Supabase → full stack), `occsim` simulator spec, pending items P1–P7 |

### Samples

- [`samples/event.v2.json`](samples/event.v2.json): plate event, using today's format plus `schema_version`, `device_id` and `captured_at_utc`.
- [`samples/heartbeat.v1.json`](samples/heartbeat.v1.json): the 60-second heartbeat.
- [`samples/config.yaml`](samples/config.yaml): copy of the **applied** `config/config.yaml` v2.

## Suggested reading order

- **Decision-makers:** this README, then docs 12, 09 and 06.
- **Producer (edge) owner:** doc 13 and the samples.
- **Backend developers:** docs 12, 13, 03, 04, 10, then 08.
- **Frontend developers:** docs 12, 05, 07 and 06, then 04 §5–6.
