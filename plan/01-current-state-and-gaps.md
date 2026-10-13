# 01 — Current State & Gaps

> Updated 2026-10-12 with stakeholder decisions D1–D28 ([doc 12](12-decisions-and-constraints.md)). **Fresh start (D16):** the existing `events` table is renamed `events_v0` and ignored, and the new pipeline uses event contract v2 ([doc 13](13-data-contracts.md)). What exists in the repo today (as of commit `19f4dbb`, 2026-10-12), and what has to change before a plate-based occupancy dashboard can be built on top of it. This is the foundation the rest of the plan builds on.

---

## 1. What already exists

| Area | File(s) | What it does | Reusable? |
|---|---|---|---|
| Edge capture (plate-only) | `scripts/plate_ocr_reader.py` | fast-alpr YOLOv9 plate detector + ByteTrack (`bytetrack_plates.yaml`) + per-track confidence-weighted character vote → one `event.json` + `plate.jpg` per finalized track. Rejected tracks go to a separate dir with `rejected` / `rejection_reason`. | **Yes — this is the producer.** |
| Edge capture (legacy) | `scripts/yolo_plate_reader.py`, `scripts/occupancy_demo.py` | Vehicle YOLO + line-crossing → `entry`/`exit` events with an in-process `occupancy_count` counter. | Superseded by the 2-camera plate design. Keep for reference only. |
| Upload | `scripts/supabase_sync.py`, `scripts/upload_events.py` | Background uploader thread + idempotent catch-up sweeper. Image → private bucket at `<event_id>.jpg`; row → `events` via **upsert on `event_id`**. | **Yes.** Idempotent upsert is exactly right for late/duplicate delivery. |
| Video archive | `scripts/video/*` | GStreamer remux recorder to SSD, SQLite index of segments (`camera_id`, `start_utc`, `end_utc`). | Yes — enables "jump to video" from an event later (P3). |
| DB schema | `scripts/supabase_schema.sql`, `scripts/supabase_migration_plate_tracks.sql` | Single wide `events` table covering both legacy and plate events. | Replaced by a fresh v2 `events` table (D16); the old table becomes `events_v0`. |
| Query layer | `scripts/lot_views.sql`, `scripts/readonly_role.sql` | Views for the NL chat: `lot_events_local`, `lot_occupancy_timeline`, `lot_hourly`, `lot_data_coverage`, `lot_capacity`; `gatf_readonly` role with SELECT on views only. | **Design pattern is excellent** (timezone-safe views, coverage-first anti-fabrication). Views must be rewritten for the session model. |
| Frontend | `frontend/` (Next.js 16.2, React 19.2, Tailwind 4, supabase-js 2.112) | `/` — server-rendered occupancy number + last-50 events table. `/chat` — Claude NL→SQL over postgres-mcp (read-only, coverage-checked, provenance recorded). `/login` — shared-passphrase HMAC cookie. | Chat + auth pattern reusable. `/` page is a placeholder to be replaced. |

### Producer event shape (authoritative: `output_template/.../event.json` + `plate_ocr_reader.py::trigger_event`)

```
event_id (uuid)            event_type = "plate_track_finalized"
timestamp_utc              camera_id  = "inbound_cam_01" | "outbound_cam_01"
source                     track_id
frame_first / frame_last   num_frames_tracked / _with_text / _used_for_consensus
plate_text                 plate_confidence, plate_confidence_per_char[]
plate_detection_confidence plate_bounding_box {x1,y1,x2,y2}
representative_frame_index reads[] {frame_index, text, confidence, clean}
image_filename             rejected, rejection_reason   (from code, not in template)
```

**Direction is encoded only by `camera_id`.** `event_type` is the same for both cameras. Everything downstream must derive `direction ∈ {in, out}` from a camera registry, not from `event_type`.

---

## 2. Gaps & defects found (must-fix before / during build)

| # | Severity | Gap | Evidence | Plan |
|---|---|---|---|---|
| G1 | **Blocker** | `events` has **no `camera_id` column** (nor `rejected`, `rejection_reason`). `supabase_sync.upload_event` sends every key except `image_filename`, so PostgREST will reject inserts with `PGRST204` — the exact failure documented in `supabase_migration_plate_tracks.sql`. | `supabase_schema.sql` vs `event.json` | Fresh v2 `events` table matching event contract v2 (doc 04 §3.2, doc 13 §1). The uploader sends only contract fields. |
| G2 | **Blocker** | All views (`lot_hourly`, `lot_data_coverage`, …) count `event_type = 'entry'/'exit'` and read `occupancy_count`. Plate events have neither → every count is 0 and occupancy is NULL. The chat system prompt describes the old model too. | `lot_views.sql`, `api/chat/route.ts` SYSTEM_PROMPT | Rewrite views over `parking_sessions` + `occupancy_timeline` (doc 04 §5.3). Update chat prompt. |
| G3 | **High** | Dashboard `/` will **crash** on plate rows: `e.detection_confidence.toFixed(2)` on a NULL column throws. | `frontend/src/app/page.tsx` | Replaced entirely by the new dashboard. |
| G4 | **High (privacy)** | `proxy.ts` matcher only covers `/chat` and `/api/chat`. **`/` renders plate numbers using the service-role key with no auth.** | `src/proxy.ts` `config.matcher` | Supabase Auth (email + password, bootstrap admin, admin-created accounts, roles `admin`/`staff`); protect everything except `/login` (doc 08). |
| G5 | **High (correctness)** | `timestamp_utc` is wall-clock **at track finalization**, i.e. *after* the plate has been un-matched for `track_buffer` (60 frames ≈ 2 s at 30 fps). When `--source` is a recorded MP4 it is the **processing time, not the capture time** — replays/backfills get wrong timestamps. | `trigger_event`: `ts = datetime.now(timezone.utc)` | **Agreed (D9):** `captured_at_utc` is required in event contract v2 (doc 13) and is the engine's event time. |
| G6 | Medium | Tracker fragmentation can split one plate into 2 tracks → **duplicate events** for the same physical pass (documented in `bytetrack_plates.yaml` and `warn_possible_fragmentation`). | comments in code | Backend de-duplication window (doc 03 §3). |
| G7 | Medium | OCR near-misses are common (`Z94PVE` vs `Z94PWE` / `294PVE` / `Z94FWE` in one track). Exact-string entry/exit matching will leave sessions open. | `reads[]` in template | Fuzzy, confusion-aware matching (doc 03 §4). |
| G8 | Medium | Edge uploads can arrive **late and out of order** (LTE outages; `upload_events.py` catch-up). | `supabase_sync.py` docstring | Session engine must be order-independent & re-runnable for a time window (doc 03 §6). |
| G9 | Medium | No camera/edge **health** signal: "no events" is indistinguishable from "camera down" (the problem `lot_data_coverage` partially solves for days, not minutes). | — | **Agreed (D23):** heartbeat v1 every 60 s → `device_heartbeats`; offline after 180 s → in-app banner (doc 04 §4.2, doc 13 §2). |
| G10 | Low | Capacity is a single-row table seeded to 100 from `zones.json`, with no lot/camera registry. The stakeholders' source of truth is **`config/config.yaml` (`parkinglot.capacity`)** (D1). | `lot_capacity`, `config/config.yaml` | Config v2 → `lots`/`cameras` sync at Vercel build (doc 13 §3, doc 04 §3.1). |
| G11 | Medium | Rate limiter is in-memory per process. **On Vercel (D7), instances share nothing, so it is ineffective.** | `rate-limit.ts` | Move it to a Postgres table + RPC (doc 04 §5.1). |
| G13 | Medium (owner accepted, D25) | `config/config.yaml` holds the Supabase and OpenAI keys inline. Vercel can't read them from there, and the file needs to be committed for the build. | `config/config.yaml` | Config v2 keeps keys in env vars only (doc 13 §3, doc 08 §0). No rotation required. |
| G14 | **High (Vercel)** | The chat route depends on a `postgres-mcp` sidecar at `localhost:8000` (`scripts/run_postgres_mcp.sh`). **No such sidecar exists on Vercel.** | `lib/mcp-client.ts`, `api/chat/route.ts` | In-process read-only SQL tool via postgres.js as `gatf_readonly` through Supavisor, and switch the chat from Anthropic to **OpenAI** (D18; doc 04 §5.2). |
| G15 | Medium (Free tier) | `reads[]` is ~10.6 KB of each ~11.4 KB event. At 2 000 reads/day, 30-day retention would exceed the 500 MB Free DB limit. | template `event.json` | Compact `reads[]` after 7 days (doc 12 §4). |
| G12 | Low | Legacy columns (`occupancy_count`, `vehicle_class`, `bounding_box`, …) clutter `events`. | schema | Resolved by the fresh v2 table (D16). |

---

## 3. Key design implication

With two rear-facing cameras and **one plate per vehicle (rear only — 75 Pa.C.S. § 1332 + 67 Pa. Code § 47.2; note truck-tractors display the plate on the *front* and will be missed by rear-facing cameras)**, occupancy is no longer a line-crossing counter; it is a **set of open parking sessions**:

```
occupancy(t) = |{ sessions s : s.entry_at ≤ t  AND (s.exit_at IS NULL OR s.exit_at > t) }|
```

That makes the system fundamentally better than the old counter (it self-explains: *which* cars are in the lot, since when), but it also introduces the core hard problem of the backend: **reliably pairing an exit read with the right entry read** under OCR noise, missed reads, duplicates and late arrival. Doc 03 is dedicated to that.

Also worth recording: a counter-only estimate (`#in − #out`) is still computed in parallel as a cross-check — the two numbers diverging is itself a data-quality signal.
