# 13 — Data Contracts (event v2, heartbeat v1, config v2)

> What the edge devices send, and the proposed config file. The backend in doc 04 is built against these contracts. Complete sample files are in [`samples/`](samples/):
>
> - [`samples/event.v2.json`](samples/event.v2.json): one finalized plate track. Its `reads[]` is shortened to 10 entries for readability; real events include every frame.
> - [`samples/heartbeat.v1.json`](samples/heartbeat.v1.json): one heartbeat.
> - [`samples/config.yaml`](samples/config.yaml): the proposed replacement for `config/config.yaml`.

---

## 1. Plate event: `schema_version: 2`

**Minor adjustments to today's `event.json`.** Everything else stays exactly as `plate_ocr_reader.py::trigger_event` writes it now.

| Field | Change | Notes |
|---|---|---|
| `schema_version` | **Added** (`2`) | Lets the backend reject or handle older shapes explicitly. |
| `camera_id` | **Required** | `inbound_cam_01` / `outbound_cam_01`. Must match `config.yaml` `cameras[]`. **Direction comes from this field.** |
| `device_id` | **Added** | e.g. `jetson-in-01`. Must match `config.yaml` `cameras[].device_id`. |
| `captured_at_utc` | **Added** | Time the **representative frame** was captured. **The backend uses this as the event time.** Live RTSP: wall-clock time stored when that frame was grabbed. Video file: file start time + `representative_frame_index / fps`. |
| `timestamp_utc` | Unchanged | Finalize time (~`track_buffer` frames after the car leaves view). Kept for diagnostics. |
| `source` | Unchanged, but **no credentials** | `rtsp://user:pass@…` must be written as `rtsp://host/…`. |
| `reads[].clean` | Keep | Already written by the current code. |
| `rejected`, `rejection_reason` | Not needed | **Rejected tracks are not uploaded** (bare-minimum choice, D24). They stay in the local `rejected_dir`. The DB ignores these fields if present. |
| Everything else | Unchanged | `event_id` (uuid4), `event_type`, `track_id`, frame counters, `plate_text`, confidences, `plate_bounding_box`, `representative_frame_index`, `reads[]`, `image_filename`. |

### Field reference

| Field | Type | Required | Example |
|---|---|:-:|---|
| `schema_version` | int | ✔ | `2` |
| `event_id` | uuid string | ✔ | `"1c72cbed-…"` |
| `event_type` | string | ✔ | `"plate_track_finalized"` |
| `camera_id` | string | ✔ | `"inbound_cam_01"` |
| `device_id` | string | ✔ | `"jetson-in-01"` |
| `captured_at_utc` | ISO-8601 with offset | ✔ | `"2026-08-14T14:24:42.509093+00:00"` |
| `timestamp_utc` | ISO-8601 with offset | ✔ | `"2026-08-14T14:24:47.042426+00:00"` |
| `source` | string | – | `"rtsp://inbound-cam.local/axis-media/media.amp"` |
| `track_id` | int | ✔ | `73` |
| `frame_first`, `frame_last`, `representative_frame_index` | int | ✔ | `4791`, `4942`, `4866` |
| `num_frames_tracked`, `num_frames_with_text`, `num_frames_used_for_consensus` | int | ✔ | `152`, `138`, `120` |
| `plate_text` | `[A-Z0-9]+` | ✔ | `"Z94PVE"` |
| `plate_confidence` | 0–1 | ✔ | `0.9697` |
| `plate_confidence_per_char` | array of 0–1, same length as `plate_text` | ✔ | `[0.9537, …]` |
| `plate_detection_confidence` | 0–1 | ✔ | `0.8003` |
| `plate_bounding_box` | `{x1,y1,x2,y2}` px in the full frame | ✔ | `{904,790,996,840}` |
| `reads` | array of `{frame_index, text, confidence, clean}` | ✔ | every frame of the track |
| `image_filename` | string | ✔ | `"plate.jpg"` (the uploader stores it as `<event_id>.jpg`) |

### Upload (unchanged mechanism)

`supabase_sync.upload_event` uploads the crop to the private bucket, then **upserts** the row into `events` on `event_id`, so retries are harmless. The DB keeps the whole payload. `reads[]` is compacted after 7 days (doc 12 §4).

**Validation on insert** (doc 04 §4.1):
- an unknown `camera_id` is quarantined in `ingest_errors` and raises an in-app alert;
- an unsupported `schema_version` is quarantined;
- a `captured_at_utc` more than 5 min in the future or before the device's first heartbeat is accepted but flagged as clock skew.

---

## 2. Heartbeat: `schema_version: 1`, every 60 s

A small, flat message. One per device per minute, sent from the same process that runs the camera loop. If the loop hangs, heartbeats stop, and that is the signal.

```json
{
  "schema_version": 1,
  "type": "heartbeat",
  "device_id": "jetson-in-01",
  "camera_id": "inbound_cam_01",
  "sent_at_utc": "2026-10-12T14:25:00.000000+00:00",
  "status": "ok",
  "camera_connected": true,
  "fps": 29.7,
  "last_event_at_utc": "2026-10-12T14:24:47.042426+00:00",
  "pending_uploads": 0,
  "uptime_s": 86400,
  "app_version": "0.3.0",
  "message": null
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`, `degraded` (e.g. low fps, upload backlog) or `error` (camera stream lost). The device decides; keep the logic trivial. |
| `camera_connected` | Whether the RTSP stream is currently delivering frames. |
| `fps` | Frames processed per second over the last minute. |
| `last_event_at_utc` | Last finalized plate event, or `null`. |
| `pending_uploads` | Local event folders not yet uploaded. This is the backlog. |
| `uptime_s`, `app_version` | Process uptime, and the producer version string. |
| `message` | Optional short human-readable note, e.g. `"rtsp reconnecting"`. |

**Sending.** Call one RPC, `supabase.rpc("report_heartbeat", {"hb": payload})`.
- It **upserts the latest row per `device_id`** in `device_heartbeats`. There is no history table, to keep it simple.
- The server stamps `received_at` and derives `clock_offset_ms = received_at − sent_at_utc` (approximate; it includes network latency). The device doesn't need to compute it.

**Server behaviour.**
- A device is **offline** when no heartbeat arrives within `offline_after_s` (180 s, i.e. 3 missed beats). An in-app banner shows "Inbound camera offline since 14:28".
- `status != ok`, or `camera_connected = false`, shows a warning chip.
- A Realtime message goes out **only when status changes**, never every minute, which keeps within the Free-tier message budget.
- Heartbeats from both Jetsons also count as project activity, so the Supabase Free project doesn't pause from inactivity. That holds as long as the devices are on.

---

## 3. Config: `config/config.yaml` v2 (Vercel only)

The full proposal is [`samples/config.yaml`](samples/config.yaml).

**Changes from the current file:**

| Section | Change |
|---|---|
| `server.*` | **Removed.** No local API server; the only UI is the Next.js app on Vercel. |
| `ai.chat_store_path` | **Removed.** Chat history stays in the browser (as the current `/chat` page does). |
| `logging.*` | **Removed.** Vercel and Supabase logs are used instead. |
| `openai.api_key`, `supabase.service_role_key` | **Moved to env vars.** Vercel can only read secrets from project env vars, and the YAML gets committed. |
| `parkinglot` | Adds `lot_id`, `name` and `timezone` alongside `capacity`. |
| `cameras`, `heartbeat`, `retention`, `ai.provider/model`, `auth.bootstrap_admin_email` | **Added.** |

**How the config reaches the database.** The Vercel build runs a pre-build step, `scripts/sync-config.ts`, before `next build`:
1. Parse and validate the YAML.
2. Upsert `lots` and `cameras` with the secret key.
3. Append to `lot_capacity_history` if the capacity changed.

Editing capacity is therefore: edit the YAML, push, deploy. No separate CI job is needed.

**Vercel detail:** the new Next.js app lives in `occupancy_analyzer/web/` (doc 14), but the config is at the repo-root `config/config.yaml`. Set the Vercel project's Root Directory to `occupancy_analyzer/web`, and keep "Include files outside the Root Directory in the Build Step" enabled so the pre-build step can read `../../config/config.yaml` *[verify the setting name in the Vercel UI]*.

> **Applied 2026-10-12.** `config/config.yaml` now holds v2, with `ai.model: gpt-5.6-terra` and `auth.bootstrap_admin_email: mayuri.murugs@gmail.com`. The keys that were in the old file are in the repo-root `.env` (gitignored). `.gitignore` currently also ignores `config/`; remove that line so Vercel can read the file.
