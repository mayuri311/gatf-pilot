# 14 — Implementation Layout, Offline Testing & Simulator

> How the plan will be built in a **new, self-contained `occupancy_analyzer/` folder**, how the whole system can be tested **offline on a laptop**, and the spec for the **camera simulator** that generates inbound and outbound JSON.
>
> **Status: design only. No code has been written.** Existing code (`frontend/`, `scripts/`) is left untouched.

---

## 1. Folder layout: `occupancy_analyzer/`

New code lives only in this folder. The existing `frontend/` (old dashboard and Anthropic chat) and `scripts/` (producer, uploader) stay as they are. Pieces worth reusing are **copied in and adapted**, not edited in place:
- the chat guardrails from `frontend/src/app/api/chat/route.ts`;
- the HMAC session helpers.

```
occupancy_analyzer/
├── README.md                      how to run everything locally / offline
├── supabase/                      Supabase CLI project (backend = Postgres)
│   ├── config.toml                local stack config (ports, auth: signup disabled)
│   ├── migrations/                numbered SQL: schema, triggers, sessionizer, RPCs, views, grants, cron
│   ├── seed.sql                   local-only seed (lot + cameras for offline runs)
│   └── tests/                     pgTAP: similarity, de-dup, 20 scenarios (doc 10 §2), RLS/roles
├── web/                           Next.js 16 dashboard (Vercel root directory)
│   ├── scripts/sync-config.ts     pre-build: config.yaml → lots/cameras
│   ├── scripts/bootstrap-admin.ts idempotent default-admin seed (no email sent)
│   └── src/…                      layout from doc 05 §7
├── simulator/                     Python package: camera simulator + replay + evaluation (§3)
│   ├── pyproject.toml             uv-managed; numpy, pillow, pyyaml, supabase, python-dotenv
│   ├── occsim/
│   │   ├── cli.py                 `occsim generate | replay | evaluate | scenario`
│   │   ├── world.py               arrivals, dwell, capacity, overnight, plate pool (ground truth)
│   │   ├── plates.py              PA/NJ/NY/vanity formats, confusion-pair noise
│   │   ├── camera.py              turns true passes into event v2 JSON (reads[], confidences, misses, fragments)
│   │   ├── heartbeat.py           heartbeat v1 stream, outages
│   │   ├── writer.py              producer-identical folder layout + placeholder plate.jpg
│   │   ├── replay.py              push to local/hosted Supabase in time order at N× speed
│   │   ├── evaluate.py            compare DB sessions/occupancy vs ground truth
│   │   └── scenarios/             the 20 golden scenarios from doc 10 §2 as YAML
│   └── tests/                     pytest for the simulator itself
└── tools/
    ├── backup.sh                  pg_dump (GitHub Actions + local)
    └── crop_retention.py          Storage API deletion job
```

**Config.** `config/config.yaml` stays at the repo root, where it has already been applied. Both `web/` (at build time) and `simulator/` (camera ids, capacity, heartbeat interval) read it.

**Vercel.** Root Directory = `occupancy_analyzer/web`, with "include files outside root" enabled so the build can read `../../config/config.yaml`.

---

## 2. Testing offline (no internet, no cloud)

Everything runs on the laptop. **Docker is already running here, along with Node 22, Python 3.14 and uv. The Supabase CLI still needs installing** (`brew install supabase/tap/supabase`, or `npx supabase`).

```
             ┌────────────────────────┐   files (event v2 + plate.jpg, heartbeats.jsonl, ground truth)
 occsim ───► │ sim_out/ (pure offline)│──────────────────────────────────────────────┐
 generate    └────────────────────────┘                                              │
                                                                                     ▼
 occsim replay ──(time-ordered, N× speed)──► LOCAL Supabase (`supabase start`, Docker): Postgres +
                                             Realtime + Storage + Auth on localhost:54321/54322
                                                        │  triggers / pg_cron do the real work
                                                        ▼
                                             web/ `next dev` on localhost:3000  ◄── you watch it live
                                                        │
 occsim evaluate ◄──────── reads sessions / occupancy ──┘  → precision/recall, occupancy MAE, residuals
```

### Three levels of offline testing

| Level | What runs | What you get | Needs |
|---|---|---|---|
| **L0: files only** | `occsim generate` | Producer-identical inbound/outbound folders plus ground truth. Lets you inspect the JSON, feed the existing `upload_events.py`, or diff against the contract. | Python only |
| **L1: engine only** | `supabase start`, then `supabase test db` and `occsim replay --fast` | The sessionizer, occupancy, flags, reconciliation and late-data handling run on real Postgres. `occsim evaluate` prints a metrics report. | Docker + Supabase CLI |
| **L2: full stack** | L1, plus `npm run dev` in `web/` and `occsim replay --speed 60` | **Watch the live dashboard update** while a simulated day plays at 60× speed. Log in as the bootstrap admin, reconcile, resolve reviews, unplug a "camera" (heartbeat outage scenario). | L1 + Node |

**Fully offline caveats:**
- **"Ask the lot" (OpenAI) needs internet.** Offline, set `ai.enabled: false`, or point it at a mock (`AI_MOCK=1` returns canned tool calls for tests).
- Everything else, including Realtime, Storage, Auth and pg_cron, works locally in the Supabase Docker stack.

### Moving from offline to the cloud

The same `occsim replay` can target the hosted Supabase project (`--target hosted`, reading `.env`) for a staging soak test. Later the real Jetsons replace the simulator: the event contract is identical, so nothing downstream changes.

---

## 3. Simulator spec (`occsim`)

### 3.1 Goals

1. Generate **inbound and outbound camera output** that is byte-compatible with event contract v2 and heartbeat v1 (doc 13). It can be consumed by the existing uploader **or** by `occsim replay`.
2. Keep a **ground truth** (which car was really where, and when) so accuracy can be measured.
3. **Inject realistic imperfections** taken from the real producer: OCR confusions, missed reads, fragmentation, late uploads, clock skew, camera outages.
4. Be **deterministic** (`--seed`), so a bug can be reproduced exactly.
5. **Generic images.** Every event gets the same tiny placeholder `plate.jpg`: a grey 96×48 JPEG with "SIM" text, about 1 KB. The uploader requires the file to exist; its content doesn't matter.

### 3.2 CLI

```bash
# Pure offline: 3 simulated weekdays → files
occsim generate --start 2026-10-13 --days 3 --seed 42 --out sim_out/ \
                --profile weekday --capacity-from config/config.yaml

# Noise knobs (defaults shown)
  --miss-rate-in 0.02 --miss-rate-out 0.03      # vehicle passes, camera emits nothing
  --confusion-rate 0.08                          # chance a consensus char is a confusable swap
  --drop-edge-char-rate 0.02                     # '94PVE' style truncation
  --fragment-rate 0.03                           # one pass → 2 events 2–8 s apart
  --late-upload-rate 0.01 --late-upload-max 3h   # event released later than captured
  --clock-skew-ms 0                              # per-device constant skew
  --overnight-rate 0.02                          # "not allowed but happens"
  --outage inbound_cam_01@2026-10-14T10:00/20m   # heartbeats + events stop (repeatable)

# Golden scenarios (doc 10 §2) → small, exact fixtures
occsim scenario list
occsim scenario run ocr_near_miss --out sim_out/ocr_near_miss/

# Push to local Supabase in capture-time order (respecting late-upload release times)
occsim replay sim_out/ --target local --speed 60     # 1 sim-hour per real minute
occsim replay sim_out/ --target local --fast         # as fast as possible (engine tests)

# Score the engine against ground truth
occsim evaluate sim_out/ --target local --report sim_out/report.md
```

### 3.3 World model (ground truth)

| Element | Model | Defaults (tunable) |
|---|---|---|
| Arrivals | Non-homogeneous Poisson, hourly rate profile | Weekday: morning peak 07–09, lunch churn 11:30–13:30, evening drain 16–18. Weekend at 40 % volume. ~200–400 arrivals/day for capacity 100. |
| Dwell | Mixture distribution | 30 % short (5–30 min), 35 % medium (1–3 h), 33 % commuter (7.5–9.5 h), **2 % overnight / multi-day** (12–40 h) |
| Capacity | From `config.yaml` | If the lot is full on arrival, the car **bounces**: it enters and leaves within 1–5 min. |
| Plate pool | Jurisdiction mix | 75 % PA `ABC1234`, 10 % NJ `A12BCD`, 8 % NY `ABC1234`, 4 % MD `1AB2345`, 3 % vanity (4–7 chars) |
| Regulars | Repeat visitors | 40 % of arrivals come from a fixed pool of "regulars", the rest are new plates |
| Lot gate | No barrier | Occasionally two cars pass 1–3 s apart (close-following) |

Ground-truth outputs:
- `ground_truth/visits.csv`: plate, true entry, true exit, bounce or overnight flags;
- `ground_truth/occupancy.csv`: true occupancy at each change;
- `manifest.json`: seed, all parameters, counts of each injected imperfection.

### 3.4 Camera model: true pass → event v2

For each true pass at a camera:
1. **Miss?** With the miss rate, emit nothing. This is logged in the manifest as a missed read, the "rejected tracks stay local" equivalent (D24).
2. **Track length.** `num_frames_tracked` is drawn from 60–200 frames at 30 fps. Frame indices continue from a per-camera running frame counter.
3. **Per-frame `reads[]`.**
   - Leading and trailing frames are empty strings (the plate is entering or leaving the frame).
   - Middle frames give the true plate most of the time.
   - The rest give noisy variants using the confusion pairs from the real data: `0/O/D/Q, 1/I/L, 2/Z, 5/S, 8/B, 6/G, P/F/R, V/W/N/M/U`, plus dropped edge characters.
   - Per-frame confidence depends on position (low at the edges).
   - Each read has `clean` = matches `^[A-Z0-9]+$`.
4. **Consensus.** The simulator runs the **same algorithm as `plate_ocr_reader.best_reading`**: modal length, then a confidence-weighted vote per character. That gives `plate_text`, `plate_confidence` and `plate_confidence_per_char`. A consensus error therefore happens only when the noise really outvotes the truth, just as with the real camera.
5. **Timestamps.**
   - `captured_at_utc` = true pass time + device clock skew.
   - `timestamp_utc` = captured time + (remaining frames + `track_buffer` 60) / 30 s.
   - `release_at` (simulator-only, stored in the manifest, **not** in the event) = when the replay should upload it, normally `timestamp_utc`, or hours later for late uploads.
6. **Fragmentation.** With the fragment rate, a second event is emitted 2–8 s later on the same camera. It covers a partial plate drawn from the tail frames (e.g. `'94PVE'`), with a new `track_id` and `event_id`.
7. **Other fields.**
   - `plate_bounding_box`: a plausible box from a fixed lane ROI.
   - `plate_detection_confidence`: 0.5–0.95.
   - `source`: `"sim://inbound_cam_01"`.
   - `device_id`: from config.
   - `schema_version`: 2.

### 3.5 Heartbeats

- Every 60 s per device, written to `sim_out/<camera>/heartbeats.jsonl` using heartbeat v1.
- `status` is `ok`, or `degraded` when the backlog is high. `fps` is 29–30.
- `last_event_at_utc` and `pending_uploads` follow the late-upload queue.
- During an `--outage`, no heartbeats or events are emitted. When the outage ends, there is a burst of backlog uploads.
- Replay sends each heartbeat to `report_heartbeat` at its scheduled time.

### 3.6 Output layout (same as the real producer, plus extras)

```
sim_out/
├── manifest.json                       seed, params, injected-imperfection counts, release schedule
├── ground_truth/visits.csv  occupancy.csv
├── inbound_cam_01/
│   ├── events/20261013T071203512000Z_plate_track17/{event.json, plate.jpg}
│   └── heartbeats.jsonl
└── outbound_cam_01/
    ├── events/…
    └── heartbeats.jsonl
```

Each `events/` folder is exactly what `scripts/upload_events.py --events-dir sim_out/inbound_cam_01/events` expects, so it can also exercise the **existing** uploader unchanged.

### 3.7 Evaluation report (`occsim evaluate`)

| Metric | How |
|---|---|
| Match precision / recall | DB session pairs vs ground-truth visits (by true plate) |
| False auto-match rate | Wrong pairs among `exact` + `fuzzy` |
| Occupancy MAE / max error | DB `occupancy_timeline` (S1) vs `ground_truth/occupancy.csv`, sampled every minute |
| Band coverage | % of minutes where the true occupancy fell inside `[band_low, band_high]` (target ≈ 95 %) |
| Drift before reconciliation | Simulated admin reconciliations (`--reconcile-every 24h`) → residual history |
| Dwell error | Median absolute error of dwell on matched sessions |
| Flags | Overnight, multi-day and bounce counts vs truth |
| Device health | Offline windows detected vs injected outages (latency to the banner) |

These are the **Phase 1 exit criteria** (doc 09): auto-match precision ≥ 99.5 %, occupancy MAE ≤ 3 % of capacity, identical results when replayed in shuffled order.

### 3.8 Golden scenarios

The 20 scenarios in doc 10 §2 are tiny YAML scripts (`scenarios/*.yaml`) that `occsim scenario run` turns into exact event sequences. pgTAP loads the same fixtures, so the simulator and the SQL tests share one source of truth. Example:

```yaml
name: ocr_near_miss
expect: { sessions: 1, match_method: fuzzy, final_occupancy: 0 }
steps:
  - { at: "08:00:00", camera: inbound_cam_01,  plate: Z94PVE }
  - { at: "10:15:00", camera: outbound_cam_01, plate: Z94PVE, observe_as: Z94PWE }
```

---

## 4. Pending before implementation starts

| # | Item | Owner | Notes |
|---|---|---|---|
| P1 | **Go-ahead to write code** in `occupancy_analyzer/`, new files only, with existing `frontend/` and `scripts/` untouched | You | This plan is ready. The suggested first slice is **simulator → Supabase migrations + pgTAP → web MVP**. |
| P2 | Install the **Supabase CLI** (`brew install supabase/tap/supabase`) | You / me | Needed for L1/L2 offline testing. Docker is already running. Docker 20.10 is older; upgrade Docker Desktop if `supabase start` complains. |
| P3 | Remove `config/` from `.gitignore` | You | Needed for the Vercel build (D27). Not needed for offline testing. |
| P4 | Set `BOOTSTRAP_ADMIN_PASSWORD` (local `.env` for offline, Vercel env for cloud) | You | The default admin `mayuri.murugs@gmail.com` is created from it. |
| P5 | Confirm migrations may later run against the **hosted** project `rfqdabtufcmkokuwflwo` (renames `events` → `events_v0`) | You | Offline work doesn't touch it. Only relevant at the first cloud deploy. |
| P6 | Producer update to event v2 + heartbeat v1 | You | **Not blocking.** The simulator stands in for the cameras until then. |
| P7 | Old `frontend/` app: keep running, or retire once `occupancy_analyzer/web` is live? | You | Default: leave it untouched and retire it after the MVP. |
