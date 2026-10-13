# 04 — Backend Architecture (Supabase / Postgres)

> Planned design. All SQL below is a **sketch for review**; none of it has been applied. Updated for the decisions in [doc 12](12-decisions-and-constraints.md) (D1–D28): capacity from config, admin reconciliation, roles `admin`/`staff` where only admins act, Vercel Hobby + Supabase Free, OpenAI chat, no notifications or public page, **fresh start on event contract v2 with no legacy migration**, heartbeats every 60 s, and `lot_id` everywhere for later multi-lot.
>
> Wire formats are in [doc 13](13-data-contracts.md). Facts were verified as of 2026-10-12 unless marked *[unverified]*.

---

## 1. Principles

1. **Raw data is immutable and everything derived can be rebuilt.** `events` holds exactly what the edge sent (contract v2), written by upsert on `event_id`. Reads, passes, sessions, occupancy and rollups can all be rebuilt from `events` + `match_overrides` + `occupancy_calibrations`.
2. **The logic lives in Postgres.** plpgsql triggers plus `pg_cron` give a transactional engine that pgTAP can test, with no extra service. Outside the database there are only two GitHub Actions jobs (backup and crop deletion) and the Vercel build step that syncs config.
3. **Push updates to the browser.** Supabase Realtime **Broadcast on private channels**, not Postgres Changes ([Supabase recommendation](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)).
4. **Least privilege.** Each device can only insert. The browser holds only the publishable key. The chat role can only SELECT views. RLS is on everywhere.
5. **Be honest about data quality.** Coverage, freshness and the uncertainty band are part of every API response.
6. **Keep it simple.** No notifications, lists, pricing, public page, barrier rules, unknown-plate passes or legacy migration.

---

## 2. Architecture

```
 ┌───────────── Edge (Jetson ×2) ──────────────────┐
 │ plate_ocr_reader.py  camera_id=inbound_cam_01  ──┐ event v2 JSON + plate.jpg   (rejected tracks stay local)
 │ plate_ocr_reader.py  camera_id=outbound_cam_01 ──┤
 │ supabase_sync.py (bg upload) / upload_events.py (catch-up)
 │ heartbeat v1 every 60 s → rpc report_heartbeat   │
 └──────────────────┬───────────────────────────────┘
                    │ HTTPS (per-device secret key)
 ┌──────────────────▼──────────── Supabase (Free) ───────────────────────────────────┐
 │ Storage: event-snapshots (private) ◄── plate crops (≈3.4 KB, 14-day retention)     │
 │ lots / cameras / lot_capacity_history ◄── synced from config.yaml at Vercel build  │
 │ device_heartbeats (latest per device) ◄── report_heartbeat()                       │
 │                                                                                    │
 │ events (raw v2) ──AFTER INSERT──► ingest_event()                                   │
 │                                     ├─ validate (schema_version, camera, skew)      │
 │                                     ├─ normalize   → plate_reads                    │
 │                                     ├─ dedup       → passes                         │
 │                                     ├─ sessionize  → parking_sessions               │
 │                                     ├─ occupancy   → occupancy_live / _timeline     │
 │                                     ├─ in-app rules→ alerts                         │
 │                                     └─ safe_broadcast('lot:<lot_id>')               │
 │ pg_cron: resessionize · session flags · rollups · heartbeat watch · reconcile check │
 │          · reads[] compaction (7 d) · retention (30 d → HMAC) · DB-size check       │
 │ Views (lot_*) + RPC functions                                                       │
 └───────┬──────────────────────────────┬──────────────────────────────┬──────────────┘
         │ RPC (user JWT)               │ Realtime Broadcast (private) │ postgres.js as gatf_readonly
 ┌───────▼──────────────────────────────▼──────────────────────────────▼──────────────┐
 │ Next.js 16 on Vercel Hobby — prebuild: sync-config.ts; RSC; route handlers: images,  │
 │ export, health, chat (OpenAI + in-process read-only SQL); Supabase Auth (email+pw)  │
 └─────────────────────────────────────────────────────────────────────────────────────┘
 GitHub Actions (nightly): pg_dump backup · crop deletion via Storage API
```

---

## 3. Data model

### 3.1 Configuration (synced from `config/config.yaml`, D1/D17)

```sql
create table lots (
  lot_id      text primary key,               -- parkinglot.lot_id
  name        text not null,
  capacity    int  not null check (capacity > 0),
  timezone    text not null default 'America/New_York',
  settings    jsonb not null default '{}',     -- heartbeat/retention knobs from config; matching defaults in code
  config_synced_at timestamptz
);
create table lot_capacity_history (
  lot_id text references lots, capacity int not null, valid_from timestamptz not null,
  primary key (lot_id, valid_from)
);
create table cameras (
  camera_id text primary key,                 -- globally unique (multi-lot ready)
  lot_id    text not null references lots,
  direction text not null check (direction in ('in','out')),
  device_id text not null,
  active    boolean not null default true
);
```

`scripts/sync-config.ts` runs as the Vercel **pre-build** step. It validates the YAML, then upserts these three tables using the secret key. `lot_capacity` (used by the existing chat role) becomes a view over `lots`.

### 3.2 Raw ingest: fresh `events` table on contract v2 (D16)

```sql
alter table events rename to events_v0;          -- old data kept untouched, ignored, dropped later

create table events (
  event_id                      uuid primary key,
  schema_version                int  not null,
  event_type                    text not null check (event_type = 'plate_track_finalized'),
  camera_id                     text not null,
  device_id                     text not null,
  captured_at_utc               timestamptz not null,     -- event time used by the engine
  timestamp_utc                 timestamptz not null,     -- finalize time (diagnostic)
  source                        text,
  track_id                      int,
  frame_first int, frame_last int, representative_frame_index int,
  num_frames_tracked int, num_frames_with_text int, num_frames_used_for_consensus int,
  plate_text                    text not null,
  plate_confidence              real,
  plate_confidence_per_char     jsonb,
  plate_detection_confidence    real,
  plate_bounding_box            jsonb,
  reads                         jsonb,                    -- compacted to top-5 alternates after 7 days
  reads_compacted_at            timestamptz,
  image_path                    text,                     -- '<event_id>.jpg' in the private bucket
  received_at                   timestamptz not null default now()
);
create index on events (camera_id, captured_at_utc);
create index events_captured_brin on events using brin (captured_at_utc);
-- extra producer keys (e.g. rejected / rejection_reason) are ignored: the uploader sends only known columns
```

### 3.3 Derived and operational tables

| Table | Grain | Key columns |
|---|---|---|
| `plate_reads` | 1 per event | `read_id = event_id`, `lot_id`, `camera_id`, `direction`, `event_at`, `plate_raw`, `plate_norm`, `plate_key`, `plate_alternates jsonb`, `format_match`, `plate_confidence`, `char_conf real[]`, `quality`, `image_path`, `pass_id` |
| `passes` | 1 per physical pass | `pass_id`, `lot_id`, `direction`, `event_at`, `plate_norm`, `plate_key`, `read_count`, `possible_fragment` |
| `parking_sessions` | 1 per stay | `session_id`, `lot_id`, `plate_norm`, `plate_key`, `entry_pass_id`, `exit_pass_id`, `entry_at`, `exit_at`, `dwell`, `status` (`open`, `pending_review`, `closed`, `closed_inferred`, `closed_admin`, `expired`, `orphan_exit`), `match_method`, `match_score`, `closed_reason`, `is_bounce`, `suspect_stale`, `overnight`, `multi_day`, `vehicle_id` |
| `match_overrides` | admin decisions | `exit_pass_id`, `entry_pass_id` (null means no match), `actor`, `note`, `created_at`. Replayed by every recompute. |
| `occupancy_calibrations` | reconciliations | `lot_id`, `at`, `visual_count`, `estimate_before`, `band_before`, `open_sessions_before`, `residual`, `sessions_closed`, `actor`, `note` |
| `occupancy_live` | 1 per lot | `occupancy` (S1), `open_sessions` (S2), `band_low`, `band_high`, `last_in_at`, `last_out_at`, `updated_at`, `clamped_raw`, `reconcile_recommended` |
| `occupancy_timeline` | step function | `valid_from`, `valid_to`, `occupancy`, `band_low`, `band_high`, `open_sessions`, `cause` |
| `vehicles` | 1 per canonical plate | `plate_norm` (pseudonym after 30 days), `first_seen`, `last_seen`, `visit_count`, `avg_dwell`, `notes` |
| `device_heartbeats` | **latest per device** | `device_id` PK, `camera_id`, `sent_at_utc`, `received_at`, `clock_offset_ms`, `status`, `camera_connected`, `fps`, `last_event_at_utc`, `pending_uploads`, `uptime_s`, `app_version`, `message`, `online` (computed by cron) |
| `alerts` (in-app) | 1 per firing | `rule_key`, `severity`, `alert_key` UNIQUE, `payload`, `fired_at`, `ack_by`, `ack_at`, `resolved_at` |
| `ingest_errors` | quarantine | unknown camera, bad `schema_version`, clock skew |
| `occupancy_15m`, `daily_stats` | rollups | occupancy avg/max/min, entries, exits, bounces, overnight count, unique vehicles, dwell quantiles, coverage minutes |
| `occupancy_baseline` | lot × weekday × 15-min slot | p10/p50/p90 over the trailing 8 weeks |
| `audit_log` | append-only | `actor`, `action`, `target`, `at` |
| `rate_limits` | per user and window | used by the chat route on Vercel |
| `forecasts` (P2) | lot × target time | `yhat`, `lo`, `hi` |

**Indexes:**
- `plate_reads(lot_id, event_at)`.
- GIN trigram indexes on `plate_reads.plate_key` and `parking_sessions.plate_norm`.
- A partial index on open sessions.
- BRIN indexes on time columns.

**Extensions:** `pg_trgm`, `fuzzystrmatch`, `pg_cron`, `pgtap`.

**Not used:** TimescaleDB (deprecated on Supabase), partitioning, pgmq, pg_net.

---

## 4. Processing pipeline

### 4.1 Insert trigger (fast path)

```
events AFTER INSERT → ingest_event(NEW):
    pg_advisory_xact_lock(hashtext(lot_id))
    validate: schema_version = 2; camera known; captured_at_utc not > now()+5 min
        → else ingest_errors + in-app alert, return
    event_at := NEW.captured_at_utc
    insert plate_reads (normalize, alternates, format prior, quality)
    dedup → passes
    if event_at < watermark(lot) − 2 min: mark window for resessionize; return
    sessionize(pass)                                  (doc 03 §4)
    recompute occupancy_live (S1/S2/band), reconcile_recommended
    append occupancy_timeline step
    in-app rules: approaching full / full
    safe_broadcast('lot:'||lot_id, 'update', {occupancy…, pass summary…})   -- one message per pass
```

`safe_broadcast` wraps `realtime.send` in `BEGIN…EXCEPTION`, because the send fails until the first client of the day connects ([docs](https://supabase.com/docs/guides/realtime/broadcast)).

### 4.2 Heartbeat RPC (D23)

```
report_heartbeat(hb jsonb)  -- security definer, executable only by device keys
    validate schema_version = 1, device known
    upsert device_heartbeats (device_id) set …, received_at = now(),
           clock_offset_ms = extract(epoch from now() - (hb->>'sent_at_utc')::timestamptz)*1000
    if status/camera_connected/online changed → safe_broadcast('lot:'||lot_id, 'device', {...})
```

### 4.3 Scheduled jobs (`pg_cron`)

| Job | Schedule | Work |
|---|---|---|
| `resessionize_trailing` | every 2 min | Recompute the trailing 2 h plus windows marked late. Replays `match_overrides` and reconciliation closures. |
| `flag_sessions` | every 10 min | Set `suspect_stale` (> 24 h), `overnight` (present at 03:00 local, D20) and `multi_day`. Flags only. |
| `heartbeat_watch` | every 1 min | Mark a device `online = false` after `offline_after_s` (180 s) → in-app banner and broadcast. Auto-resolve when beats resume. |
| `reconcile_check` | every 5 min | Recompute `reconcile_recommended`. |
| `rollup_15m` / `rollup_daily` / `baseline_refresh` | 5 min / 00:15 / 01:00 local | Rollups and baseline. |
| `compact_reads` | 02:30 local | `reads[]` older than 7 days → top-5 alternates. |
| `retention` | 03:30 local | Pseudonymize plaintext older than 30 days (HMAC). Mark sessions still open after 30 days as `expired`. Queue crops older than 14 days for deletion. Prune `cron.job_run_details`. |
| `db_size_check` | hourly | Warn at 70 % of 500 MB. |

### 4.4 Outside the database

| Where | Job |
|---|---|
| Vercel build | `sync-config.ts` (config → `lots`, `cameras`, capacity history) |
| GitHub Actions, nightly | `pg_dump` backup (14-day retention); delete queued crops via the Storage API |

There is no keep-alive job: heartbeats keep the Free project active (D23).

---

## 5. API surface

### 5.1 RPC functions (`stable`, `security invoker`, explicit `GRANT EXECUTE`)

| Function | Role |
|---|---|
| `get_live_snapshot(lot_id)` returns occupancy, band, capacity, state, open sessions, last in/out, **per-device online/status from heartbeats**, today's KPIs, `reconcile_recommended`, and active alerts | staff, admin |
| `get_occupancy_series`, `get_typical_day`, `get_flow_series`, `get_heatmap`, `get_calendar`, `get_dwell_distribution`, `get_kpis` | staff, admin |
| `list_sessions`, `list_reads`, `search_plates` (audited), `get_vehicle_profile` (audited) | staff, admin |
| `get_review_queue(lot_id)` | staff (read-only), admin |
| `resolve_match(exit_pass_id, entry_pass_id\|null, note)` | **admin only** (D22) |
| `correct_plate(read_id, plate, note)`, `ack_alert(alert_id)` | **admin only** |
| `reconcile_preview(lot_id, visual_count)` / `reconcile_commit(...)` | **admin only** |
| `get_calibration_history`, `get_data_quality`, `get_coverage` | staff, admin |
| `get_system_status()` returns DB size, cron failures, last backup, last config sync | admin |
| `report_heartbeat(hb)` | device keys only |
| `rate_limit_hit(key, window_s, max)` | server only |

### 5.2 Next.js route handlers (Vercel Hobby, Node runtime)

- `GET /api/images/[readId]`: checks the role, writes an audit entry, and redirects to a signed URL valid for 5 minutes.
- `GET /api/export/[kind].csv`: streamed and audited.
- `GET /api/health`: runs `select 1` and reports the latest heartbeat age.
- `POST /api/chat` uses **OpenAI** (D18):
  - `openai` SDK with function calling;
  - one tool, `execute_sql`, run in-process by postgres.js as `gatf_readonly` through the Supavisor pooler (`:6543`, `prepare: false`);
  - the system prompt holds a static description of the views;
  - the model comes from `ai.model` and the key from `OPENAI_API_KEY`;
  - all existing guards stay: read-only role, view-only grants, `statement_timeout`, row and character caps, the loop-iteration cap with a 60 s deadline (within the 300 s function limit), history sanitization, a coverage-first rule, and SQL provenance in the response;
  - rate limiting via `rate_limit_hit`.

### 5.3 Views for the chat role (replacing `scripts/lot_views.sql`)

`lot_reads_local`, `lot_sessions_local`, `lot_occupancy_timeline`, `lot_hourly`, `lot_daily`, `lot_data_coverage` (per camera per day, including heartbeat-based uptime minutes; still the mandatory first query), and `lot_capacity`. Plates show plaintext for up to 30 days and the pseudonym after that. Prefer aggregates, because results go to OpenAI (doc 12 §5).

---

## 6. Realtime design

| Channel (private) | Event | Payload |
|---|---|---|
| `lot:<lot_id>` | `update` | `{occupancy, band_low, band_high, capacity, open_sessions, state, ts, reconcile_recommended, pass?: {pass_id, direction, event_at, plate_norm, quality, match_method, session_id, dwell}}` |
| `lot:<lot_id>` | `device` | `{device_id, camera_id, online, status, camera_connected}`, sent **on change only** |
| `lot:<lot_id>` | `alert` | in-app alert row |

- RLS on `realtime.messages` checks `realtime.topic()` and `app_metadata.role in ('admin','staff')`. Public access is off.
- Clients refetch the snapshot on every `SUBSCRIBED`.
- Idle tabs (more than 30 min) unsubscribe.
- If Realtime errors, clients fall back to polling every 15 s.

---

## 7. Security (detail in doc 08)

- **Auth (D21):** Supabase Auth with email and password. Public sign-up is disabled.
  - A **bootstrap admin** is created on first deploy from the admin email in `config.yaml` (`auth.bootstrap_admin_email`) and the password in the `BOOTSTRAP_ADMIN_PASSWORD` env var, flagged `must_change_password`. **No email is sent** (§7.1).
  - The admin creates staff accounts in `/admin/users` (server-side admin API, temporary password). No outbound email is needed.
- **No outbound email (§7.1).** Accounts are created server-side with the Auth admin API (`email_confirm: true`), so Supabase sends no confirmation or invite email. There is no self-service "forgot password"; the admin resets passwords in `/admin/users`. Supabase's built-in email service is never used; it is rate-limited and meant only for development anyway.
- **Roles:** `app_metadata.role` is set server-side and checked by `authorize()` in RLS. Staff is read-only; only admins write (D22).
- **Devices:** each Jetson has its own secret key, used for inserting `events`, uploading to Storage, and calling `report_heartbeat`.
- **Data API grants:** explicit grants in every migration (the change takes effect 2026-10-30).
- **JWT and keys:** move to publishable/secret keys and asymmetric JWT signing.
- **Audit:** the audit log lives in a table.

---

## 8. Alerts (in-app only)

These are rows in `alerts`, broadcast on the lot channel and shown as a banner (critical) or in the bell inbox. **Only admins acknowledge or resolve them.** The rule catalog is in doc 06 §4. External delivery can be added later without schema changes.

---

## 9. Observability

- **Device health** comes from heartbeats: online/offline, status, camera connection, fps, pending uploads, clock offset, version.
- **Freshness chips** show the time since the last read per camera.
- **Health page:** DB size vs 500 MB, storage vs 1 GB, cron failures, last backup, last config sync.

---

## 10. Platform pitfalls checklist

1. 2026-10-30 Data API grant change.
2. Legacy Supabase API keys retire by end of 2026.
3. Next.js security release on 2026-10-14 (the repo pins 16.2.12).
4. Supabase Free: no backups, 500 MB, 2 M Realtime messages a month, 1-day logs. Pausing is covered by heartbeats.
5. Vercel Hobby: no localhost sidecar, no shared memory, IPv4 only (use Supavisor), 300 s functions. Hobby is described as non-commercial, so plan Pro for production.
6. Use Broadcast, not `postgres_changes`. Wrap `realtime.send`. Refetch on reconnect.
7. Use `"use cache"` only for closed historical ranges.
8. Keep signed URL TTLs at 5 min or less.

---

## 11. Producer-side changes (owner, not done now)

| Change | Status |
|---|---|
| Emit **event contract v2** (`schema_version`, `camera_id`, `device_id`, `captured_at_utc`; no credentials in `source`) | Agreed (D9, D16) |
| **Heartbeat v1** every 60 s via `rpc("report_heartbeat")` | Agreed (D23) |
| Keep rejected tracks local (don't upload) | Agreed (D24) |
| Uploader sends only contract fields (drops `rejected`/`rejection_reason`) | Small change |
| Per-device Supabase secret key from `.env` | Recommended |
