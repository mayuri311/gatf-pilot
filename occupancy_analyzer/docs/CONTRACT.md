# occupancy_analyzer — Integration Contract (source of truth for all components)

All components (DB, web, simulator, producer) MUST follow this file. Plan docs: `../plan/` (esp. 03, 04, 13, 14).

## 0. Environment

| Item | Local (offline) | Hosted |
|---|---|---|
| Supabase API | `http://127.0.0.1:54321` | `https://rfqdabtufcmkokuwflwo.supabase.co` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | pooler |
| Read-only chat role | `postgresql://gatf_readonly:gatf_readonly_local@127.0.0.1:54322/postgres` | `READONLY_DATABASE_URL` |
| Storage bucket | `event-snapshots` (private) | same |
| Config | repo-root `config/config.yaml` (v2) | same |
| Lot id | `gatf_main` | |
| Cameras | `inbound_cam_01` (in, device `jetson-in-01`), `outbound_cam_01` (out, device `jetson-out-01`) | |

Env vars (web `.env.local` / Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable), `SUPABASE_SERVICE_ROLE_KEY` (secret, server only), `READONLY_DATABASE_URL`, `OPENAI_API_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`, `AI_MOCK` (optional `1`).
Producer/simulator env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`.

## 1. Wire contracts (edge → DB)

### 1.1 Event v2 → `public.events` (PostgREST upsert on `event_id`)
Columns accepted (anything else must be dropped by the sender):
`event_id uuid, schema_version int (=2), event_type text (='plate_track_finalized'), camera_id text, device_id text, captured_at_utc timestamptz, timestamp_utc timestamptz, source text, track_id int, frame_first int, frame_last int, representative_frame_index int, num_frames_tracked int, num_frames_with_text int, num_frames_used_for_consensus int, plate_text text, plate_confidence real, plate_confidence_per_char jsonb (array), plate_detection_confidence real, plate_bounding_box jsonb ({x1,y1,x2,y2}), reads jsonb (array of {frame_index,text,confidence,clean}), image_path text ('<event_id>.jpg')`.
Sender uploads the crop first to bucket `event-snapshots` at `<event_id>.jpg` (upsert), then upserts the row with `image_path`.
Sample: `../plan/samples/event.v2.json`.

### 1.2 Heartbeat v1 → `rpc('report_heartbeat', {hb: <json>})`
Sample: `../plan/samples/heartbeat.v1.json`. Fields: `schema_version(=1), type('heartbeat'), device_id, camera_id, sent_at_utc, status('ok'|'degraded'|'error'), camera_connected bool, fps number, last_event_at_utc|null, pending_uploads int, uptime_s int, app_version text, message text|null`. Every 60 s. Returns `{ok:true}`.

## 2. Derived tables (read by evaluate / internal; web uses RPCs only)

- `plate_reads(read_id uuid pk, lot_id, camera_id, direction 'in'|'out', event_at timestamptz, plate_raw, plate_norm, plate_alternates jsonb [{text,weight}], plate_confidence, quality 'high'|'medium'|'low', image_path, pass_id uuid)`
- `passes(pass_id uuid pk, lot_id, direction, event_at, plate_norm, plate_alternates, plate_confidence, quality, read_count int, possible_fragment bool, primary_read_id uuid)`
- `parking_sessions(session_id uuid pk, lot_id, plate_norm, entry_pass_id uuid null, exit_pass_id uuid null, entry_at timestamptz null, exit_at timestamptz null, status text, match_method text null, match_score real null, closed_reason text null, is_bounce bool)`
  - `status ∈ open | pending_review | closed | closed_inferred | closed_admin | expired | orphan_exit`
  - `match_method ∈ exact | fuzzy | fuzzy_pending | manual`
  - session_id = entry pass id; for orphan exits = exit pass id.
- `occupancy_timeline(lot_id, valid_from timestamptz, occupancy int, raw_occupancy int, band_low int, band_high int, open_sessions int, cause text, cause_pass_id uuid null)` — one row per change; value holds until next row.
- `occupancy_calibrations(calibration_id bigserial, lot_id, at, visual_count, estimate_before, open_sessions_before, residual, closed_session_ids uuid[], actor uuid, actor_email text, note text)`
- `device_heartbeats(device_id pk, camera_id, lot_id, sent_at_utc, received_at, clock_offset_ms, status, camera_connected, fps, last_event_at_utc, pending_uploads, uptime_s, app_version, message)`

## 3. RPCs used by the web (all `security definer`, role-checked, `GRANT EXECUTE TO authenticated`)

Role = `auth.jwt()->'app_metadata'->>'role'` ∈ `admin|staff`. Others → error `42501`.
All timestamps ISO-8601 UTC strings; UI formats in `America/New_York`. All return `jsonb` unless stated.

| RPC | Params | Returns (jsonb) | Role |
|---|---|---|---|
| `get_live_snapshot` | `p_lot text default 'gatf_main'` | see §3.1 | staff |
| `get_occupancy_series` | `p_lot, p_from timestamptz, p_to timestamptz, p_bucket_minutes int` | `[{ts, occ_avg, occ_max, occ_min, band_low, band_high, capacity}]` | staff |
| `get_typical_day` | `p_lot, p_dow int (0=Sun..6), p_weeks int default 8` | `[{slot:'HH:MM', p10, p50, p90}]` (15-min slots, local time) | staff |
| `get_flow_series` | `p_lot, p_from, p_to, p_bucket_minutes` | `[{ts, arrivals, departures, net, bounces}]` | staff |
| `get_heatmap` | `p_lot, p_from, p_to, p_metric text ('occupancy'|'arrivals')` | `[{dow 0-6, hour 0-23, value}]` (local) | staff |
| `get_daily_stats` | `p_lot, p_from, p_to` | `[{day:'YYYY-MM-DD', peak_occ, peak_pct, peak_at, entries, exits, bounces, overnight, unique_vehicles, avg_dwell_min, median_dwell_min, p90_dwell_min, hours_effectively_full}]` | staff |
| `get_dwell_distribution` | `p_lot, p_from, p_to` | `{buckets:[{label,count}], median_min, p90_min, avg_min, total}` | staff |
| `get_kpis` | `p_lot, p_from, p_to` | `{entries, exits, bounces, bounce_rate, unique_vehicles, avg_dwell_min, median_dwell_min, turnover, peak_occ, peak_pct, peak_at, utilization, hours_effectively_full, overnight, match_rate, prev:{same keys for previous equal-length period}}` | staff |
| `list_sessions` | `p_lot, p_from, p_to, p_status text[] null, p_plate text null, p_flags text[] null, p_limit int default 50, p_offset int default 0` | `{total, rows:[session_row]}` | staff |
| `list_reads` | `p_lot, p_from, p_to, p_camera text null, p_plate text null, p_quality text null, p_limit, p_offset` | `{total, rows:[read_row]}` | staff |
| `search_plates` | `p_q text` | `{exact:[{plate_norm,last_seen,visits}], similar:[{plate_norm,last_seen,visits,similarity}]}` (audited) | staff |
| `get_vehicle_profile` | `p_plate text` | `{plate_norm, first_seen, last_seen, visits, avg_dwell_min, usual_arrival_hour, overnight_count, aliases:[text], sessions:[session_row]}` (audited) | staff |
| `get_session` | `p_session uuid` | `{session_row + entry_read:read_row, exit_read:read_row, candidates?:[...]}` | staff |
| `get_review_queue` | `p_lot` | `[{session_id, exit_pass_id, exit_read:read_row, status, candidates:[{session_id, entry_pass_id, plate_norm, entry_at, score, read:read_row}]}]` | staff |
| `resolve_match` | `p_exit_pass uuid, p_entry_pass uuid null, p_note text null` | `{ok:true}` | **admin** |
| `correct_plate` | `p_read uuid, p_plate text, p_note text null` | `{ok:true}` | **admin** |
| `reconcile_preview` | `p_lot, p_visual_count int` | `{estimate, band_low, band_high, open_sessions, visual_count, to_close_count, proposed:[session_row + {reason}]}` | **admin** |
| `reconcile_commit` | `p_lot, p_visual_count int, p_close uuid[], p_note text null` | `{residual, closed}` | **admin** |
| `get_calibration_history` | `p_lot` | `[{at, visual_count, estimate_before, residual, closed_count, actor_email, note}]` | staff |
| `get_alerts` | `p_lot` | `[{key, severity 'critical'|'warning'|'info', title, detail, since, acked:bool}]` (derived, computed live) | staff |
| `ack_alert` | `p_key text` | `{ok:true}` | **admin** |
| `get_data_quality` | `p_lot, p_from, p_to` | `{reads, passes, read_rate_high, exit_match_rate, exact_share, orphan_exits, fuzzy_pending, suspect_stale, fragments, drift (S2-S1), per_camera:[{camera_id, reads, avg_conf, low_quality}] , conf_by_hour:[{hour, avg_conf}]}` | staff |
| `get_devices` | `p_lot` | `[{device_id, camera_id, direction, online, status, camera_connected, fps, last_seen, last_event_at, pending_uploads, clock_offset_ms, uptime_s, app_version, message, last_read_at}]` | staff |
| `get_system_status` | — | `{db_size_bytes, db_limit_bytes:524288000, events, reads, sessions, oldest_event, last_config_sync, capacity}` | admin |
| `get_audit_log` | `p_limit int default 200` | `[{at, actor_email, action, target, detail}]` | admin |
| `log_audit` | `p_action text, p_target text, p_detail jsonb` | `{ok:true}` | staff |

### 3.1 `get_live_snapshot` shape
```json
{
  "lot": {"lot_id":"gatf_main","name":"GATF Parking Lot","capacity":100,"timezone":"America/New_York","effective_pct":0.85},
  "occupancy": 42, "band_low": 39, "band_high": 46, "open_sessions": 44, "pct": 0.42,
  "state": "available|filling|effectively_full|full",
  "updated_at": "…", "last_in_at": "…", "last_out_at": "…",
  "last_reconciled_at": "…|null", "reconcile_recommended": true, "reconcile_reasons": ["band ±4 > 2% of capacity"],
  "today": {"entries":187,"exits":145,"bounces":6,"avg_dwell_min":112,"overnight":3,"multi_day":1,"unique_vehicles":160},
  "devices": [/* get_devices rows */],
  "recent_passes": [/* pass_row, newest first, 25 */],
  "in_lot": [/* open session rows, oldest first, max 200 */],
  "alerts": [/* get_alerts rows */]
}
```

### 3.2 Row shapes
- `session_row`: `{session_id, plate_norm, entry_at, exit_at, dwell_min, status, match_method, match_score, closed_reason, is_bounce, suspect_stale, overnight, multi_day, entry_read_id, exit_read_id, entry_image, exit_image}`
- `read_row`: `{read_id, camera_id, direction, event_at, plate_norm, plate_raw, plate_confidence, plate_confidence_per_char, quality, alternates:[{text,weight}], reads:[...] (only in get_session), image_path, pass_id}`
- `pass_row`: `{pass_id, direction, event_at, plate_norm, plate_confidence, quality, read_id, image_path, session_id, match_method, dwell_min}`
- Flags computed live: `suspect_stale` = open & age > 24 h; `multi_day` = dwell/age > 24 h; `overnight` = session covers 03:00 local.

## 4. Realtime (Broadcast, private channel `lot:gatf_main`)
Events: `update` → `{occupancy, band_low, band_high, open_sessions, capacity, state, ts, pass?: pass_row}`; `device` → `{device_id, status, camera_connected}`.
Client must `supabase.realtime.setAuth()` and subscribe with `{config:{private:true}}`; on every `SUBSCRIBED` refetch `get_live_snapshot`; also poll snapshot every 30 s (device ages, derived alerts).

## 5. Images
Web route `GET /api/images/[readId]` → auth check → `log_audit('image_view')` → 302 to signed URL (300 s) for `image_path` in `event-snapshots`.

## 6. Auth
- Email + password. Public signup disabled. No emails sent.
- Bootstrap admin: email `auth.bootstrap_admin_email` from config.yaml, password `BOOTSTRAP_ADMIN_PASSWORD`; `app_metadata = {role:'admin', must_change_password:true}`; created via admin API with `email_confirm:true` (web script `scripts/bootstrap-admin.ts`, idempotent).
- Admin creates users in `/admin/users` (server action using service role): `app_metadata.role ∈ admin|staff`, `must_change_password:true`.
- After first login with `must_change_password` → `/account/password` forced.

## 7. Additions after integration (2026-10-13)

| RPC / field | Notes |
|---|---|
| `get_review_count(p_lot) → int` | Sidebar badge (staff). Cheap: no candidate scoring. |
| `get_read(p_read uuid) → read_row` | Includes `reads[]` (per-frame timeline, until compacted at 7 d) and `track`. Staff. |
| `session_row` extras | `entry_confidence`, `exit_confidence`, `exit_plate` |
| `read_row` extras | `corrected`, `num_frames_used` |
| `pass_row` extras | `read_count`, `status` |
| `reconcile_preview.open` | All open sessions in proposal order, each with `reason` |
| `get_typical_day[].days` | Number of days behind each slot (UI shows p10–p90 only with enough history) |
| `get_daily_stats[].avg_occ` | Time-weighted average occupancy |
| `get_system_status.ingest_errors_24h` | Quarantined events in the last 24 h |
| `occupancy_timeline.expected_ghosts`, `expected_missed_in`, `unseen` | Estimator terms (plan doc 03 §5.1). `occupancy` = bias-corrected estimate; `raw_occupancy` = flow count S1 (drift cross-check). |
| Image route | Reads `plate_reads.image_path` with the service role after its own auth check. |
