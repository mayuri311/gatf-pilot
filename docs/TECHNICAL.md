# GATF parking occupancy system: technical documentation

Written 2026-11-17 from the code on branch `jetson-systemd` (based on `origin/main` at `dd1fdaf`) and from the project's bill of materials. Nothing here was checked on the installed hardware. Where a fact comes from, and how sure it is, is stated throughout.

Related: [HANDOFF.md](HANDOFF.md) (checklist and known issues), [../deploy/jetson/README.md](../deploy/jetson/README.md) (boot service, lane check), [../occupancy_analyzer/docs/CONTRACT.md](../occupancy_analyzer/docs/CONTRACT.md) (data formats, the source of truth), [../plan/](../plan/README.md) (design decisions D1–D28).

## Contents

1. System at a glance
2. Hardware
3. Network
4. Software on the Jetson
5. Files on the SSD
6. Data sent to the cloud
7. Cloud: database, engine, dashboard, scheduled jobs
8. Configuration and secrets
9. Operations
10. Testing
11. Tunable values
12. Repository map

---

## 1. System at a glance

```
entry camera ─┐                       ┌─ recorder ×2 ──► SSD video ring ─► clipper ─► SSD clips
              ├─ PoE switch ─ Jetson ─┤
exit camera  ─┘                       └─ plate reader ×2 ─► SSD spool ─► uploader ─┐
                                         heartbeats (every 120 s) ────────────────┤ LTE router
                                                                                   ▼
                                    Supabase: events ─► engine (sessions, occupancy) ─► dashboard (Vercel)
```

- **Direction comes only from the camera.** A read from `inbound_cam_01` is an entry; from `outbound_cam_01`, an exit. There is no line-crossing logic and no vehicle detection in the live system.
- **The Jetson only reads plates.** All pairing and counting happens in the database.
- **Everything is saved on the SSD before it is sent.** A dead cellular link delays data but does not lose it.

---

## 2. Hardware

### 2.1 What the bill of materials says

Source: the project's BOM summary. **None of this was verified on site for this document.** Model numbers and dimensions are as written there.

| Item | As specified | Notes from the BOM |
|---|---|---|
| Cameras | 2 × Axis LE-series bullet, IP67, 3.1–9 mm varifocal lens, each on its own pole mount | The unit in hand is a **P1475-LE**, not the P1465-LE originally specified. The lens figures were to be rechecked. Whether both cameras are the same model is not stated. |
| Camera aim | About 130 px plate width, at about 3.1 m mount height and 6.8 m standoff | Design target, calculated for the P1465-LE. Not re-confirmed for the P1475-LE. |
| Enclosure | Altelix 17 × 14 × 9 in vented polycarbonate, DIN rail, cooling fan, 120 VAC outlets | Replaced an earlier NEMA 4X aluminum plan. Vented, so not sealed. |
| Router | Teltonika RUT241 LTE, on an AT&T IoT plan | `config/config.yaml` mentions a 1 GB/month cap. |
| Switch | Netgear GS305PP PoE+ | Powers both cameras. |
| Computer | NVIDIA Jetson Orin Nano 8GB | Runs all edge software. |
| Storage | 1 TB USB SSD, two drives, rotated | The current owner has decided **not** to rotate. Code and config accept only one drive ID at a time. |
| Power | OEM power adapters on an internal power strip | **No UPS or battery**, by design (temperature and access). Any power cut stops the system. |
| Surge protection | Axis TU8001 Ethernet surge protectors at the cable entry, tied to a single-point copper ground bar | |
| Antenna | Poynting OMNI-402 2×2 MIMO, or a LINOVISION budget alternative, on external SMA bulkheads | Which one was installed is not recorded. |

DIN layout per the BOM: one row holds the router and the switch; the other holds the Jetson and the SSD.

### 2.2 What the code shows about the hardware

These come from comments and measurements in the code, made on the development unit. They may not match the installed unit.

| Fact | Source |
|---|---|
| The Jetson has 6 CPU cores; each plate reader is limited to 2 inference threads | `scripts/plate_ocr_reader.py` (`DEFAULT_ORT_THREADS`) |
| The Orin Nano has no hardware video encoder, so video is never re-encoded | `scripts/video/README.md` |
| Plate detector speed: 121 ms per frame on CPU, 16.9 ms on GPU (TensorRT FP16), on recorded 1080p footage | `scripts/trt_backend.py` |
| Two readers together reach about 6.5–7 frames per second each | `scripts/plate_ocr_reader.py` |
| JetPack's ffmpeg is version 8.0.1-nvidia1, a reduced build without the concat demuxer | `scripts/video/clipper.py` |
| The network interface facing the cameras defaults to `enP8p1s0` | `scripts/run_pipeline.sh` (`GATF_CAMERA_IFACE`) |
| The SSD is expected at `/mnt/validation`, formatted ext4 | `scripts/run_pipeline.sh`, `scripts/video/README.md` |
| Cameras are reached at RTSP path `/axis-media/media.amp` | `scripts/video/config.py` |
| The plate reader can use a reduced-rate stream (for example 10 fps) while the recorder keeps the full stream | `scripts/video/config.py` (`inference_query`) |
| The camera's keyframe interval must be shorter than the segment length, or segments overrun | `scripts/video/README.md` |
| **The cameras were physically swapped at installation**: the camera at the entrance is currently configured as `outbound_cam_01` | Reported by the installer; see HANDOFF.md issue 1 |

### 2.3 Not known: record these on site

| Unknown | How to find it |
|---|---|
| Camera model, firmware, IP address, and lane, for each camera | Camera web page; `scripts/video/recorder.config.json` on the Jetson; lane check in `deploy/jetson/README.md` |
| Camera stream settings: resolution, frame rate, bitrate, keyframe interval | Camera web page; `python3 -m scripts.video.preflight --camera <id>` measures the keyframe interval |
| Actual mount height, standoff, and plate width in pixels | Measure on site; open a saved plate photo and check its width |
| JetPack / L4T version | `cat /etc/nv_tegra_release` |
| Jetson user, hostname, repository path | `whoami; hostname; pwd` |
| Jetson boot storage (SD card or NVMe) and free space | `lsblk; df -h /` |
| SSD model, filesystem, UUID, label | `lsblk -o NAME,MODEL,UUID,LABEL,FSTYPE,MOUNTPOINT` |
| Whether the Jetson powers on by itself when power returns | Pull power for 10 s and restore it |
| How the Jetson, switch and router are cabled, and addresses on each | `ip -br addr; ip route` on the Jetson; router's web page |
| Router settings, SIM number, signal strength, data used | Router's web page |
| Which antenna is installed | Look |
| Enclosure temperature in summer and winter | `temp_c` in the metrics files (section 5) over time |
| Grounding as built | Inspect |

---

## 3. Network

What the code requires:

- The Jetson must reach both cameras over the interface named in `GATF_CAMERA_IFACE` (default `enP8p1s0`). Preflight pings each camera through that interface and fails if there is no link.
- Preflight warns if a camera's address does not route through that interface, and suggests adding a `/32` route. This suggests the cameras may be on a different subnet from the Jetson's default route, but the installed addressing is not recorded in the repository.
- The Jetson needs outbound HTTPS to the Supabase project. Nothing connects inbound.
- The clock must be synchronized (NTP). Event times and clip windows use the Jetson's clock.

Not recorded anywhere in the repository: IP addresses, subnets, DHCP or static assignment, router firewall settings. Record them (section 2.3).

Remote access: none is set up. The router is behind the carrier's NAT. `deploy/jetson/README.md` describes Tailscale.

---

## 4. Software on the Jetson

### 4.1 Processes

`scripts/run_pipeline.sh` starts and supervises all of them. With both cameras there are eight:

| Process | Count | Command | Job |
|---|---|---|---|
| Recorder | 1 per camera | `python -m scripts.video.recorder --camera <id>` | Writes the camera's video to the SSD in short MP4 segments without re-encoding (GStreamer). Keeps an index in SQLite. Deletes the oldest segments when free space drops below `min_free_gb`. |
| Plate reader | 1 per camera | `python scripts/plate_ocr_reader.py --camera-id <id> --source-env RTSP_<ID> --headless --no-upload …` | Finds plates, tracks them, reads them, votes, and writes one record folder per plate. Sends heartbeats. |
| Clipper | 1 | `python -m scripts.video.clipper` | For each record, cuts a clip from 10 s before the plate appeared to 10 s after it left, from the recorded segments. |
| Uploader | 1 | `python scripts/spool_uploader.py --spool <gatf>/events` (run at low priority) | Uploads record folders, oldest first. Waits when CPU is above 85%. Backs off from 5 s to 5 min on failures. |
| Metrics | 1 | `python scripts/sysmetrics.py --gatf <gatf>` | Samples CPU, GPU, RAM, temperature, network and SSD every 5 s. |
| Retention | 1 | `python -m scripts.video.ssd_retention` (low priority) | Once an hour, deletes old clips, uploaded records, rejected reads and metrics files (section 5). |

Supervision: a process that exits is restarted with a delay that doubles up to 64 s. On SIGTERM the script stops things in order: readers, a 25 s wait, recorders, a final clip pass, up to 60 s of upload drain, then metrics.

### 4.2 How a plate is read (`scripts/plate_ocr_reader.py`)

1. **Frames.** A grabber thread always hands the detector the newest frame and discards the rest, so processing never falls behind real time. Each frame is stamped with the UTC time it was grabbed.
2. **Detection and OCR.** The `fast-alpr` library runs a YOLOv9 plate detector (`yolo-v9-t-384-license-plate-end2end`) and an OCR model (`cct-xs-v2-global-model`). The detector runs on the GPU through TensorRT when available, otherwise on the CPU. OCR runs on the CPU.
3. **Tracking.** ByteTrack follows each plate box across frames, with settings tuned for small, fast boxes (`scripts/bytetrack_plates.yaml`). A track ends when the plate has been unmatched for 60 frames.
4. **Per-track buffer.** Each frame's text and confidence are kept until the track ends. A plate crop is kept only for frames that could still become the saved photo: the most confident read of each distinct text, and the best detection (`TrackBuffer`). Memory therefore no longer grows with crops while a plate stays in view.
5. **Consensus.** When a track ends, its reads are grouped by the most common length. Each character position is decided by a confidence-weighted vote. Only reads made purely of A–Z and 0–9 vote.
6. **Validation.** The result is accepted if it is alphanumeric and at least 5 characters. Anything else goes to a `_rejected` folder, which is never uploaded.
7. **Output.** A folder containing `event.json` (contract v2) and `plate.jpg` (the plate crop from the frame that best matches the result).
8. **Stream loss.** If no frame arrives for 15 s, the stream is reopened with a 2–30 s backoff. Heartbeats report the outage meanwhile.

### 4.3 Boot service

`deploy/jetson/gatf-pipeline.service`, installed by `deploy/jetson/install.sh`. **Written but not yet run on the Jetson.** It starts `run_pipeline.sh` at boot, retries every 30 s on failure, and allows 300 s for the ordered shutdown. Details and reasoning are in `deploy/jetson/README.md` and in comments in the unit file.

### 4.4 Python environment

- A virtual environment at `<repo>/.venv`, created with `--system-site-packages` so it can use JetPack's GStreamer and TensorRT bindings.
- Packages: `.venv/bin/pip install --no-deps -r scripts/inductiverobo.txt`. `--no-deps` is required; the file is a full pinned list, and resolving dependencies would install a conflicting OpenCV build.
- System packages (apt): GStreamer bindings and tools, `ffmpeg`, `sqlite3`, `udisks2`. The list is in `scripts/video/README.md`.
- TensorRT engines are built once and cached in `~/.cache/gatf-trt`. They are rebuilt if the model or the TensorRT version changes, which takes a few minutes.

---

## 5. Files on the SSD

Everything is under `<mount>/gatf/` (default `/mnt/validation/gatf/`).

| Path | Contents | Deleted automatically? |
|---|---|---|
| `drive.json` | Drive ID and label | No |
| `index/segments.db` | SQLite index of every video segment | Rows are never removed (deleted segments are marked) |
| `video/<camera>/<date>/…mp4` | Continuous video | Yes: oldest first when free space is below `min_free_gb` (20 GB in the example config) |
| `clips/<camera>/<date>/…mp4` | One clip per plate record | After 14 days |
| `events/<camera>/<folder>/` | `event.json`, `plate.jpg`, `clip.json`, and `.uploaded` once sent | After 14 days, **only if uploaded** |
| `events/<camera>_rejected/<folder>/` | Rejected reads, never uploaded | After 30 days |
| `events/<camera>_failed/<folder>/` | Folders the uploader gave up on, with `upload_error.json` | **Never**; a person decides |
| `metrics/metrics-YYYY-MM-DD.jsonl` | One line every 5 s | After 30 days |
| `state/` | `uploader.json`, `clipper.json`, `metrics_latest.json` | Overwritten |
| `logs/` | One log per process, `pipeline.pid` | Rotated (14 days) once the boot service is installed |

Clean-up is done by `scripts/video/ssd_retention.py` (ages are flags on it). Preview with `python3 -m scripts.video.ssd_retention --once --dry-run`.

Privacy note: plate text in uploaded records stays on the SSD for 14 days and in rejected reads for 30. The cloud scrambles plate text after 30 days.

---

## 6. Data sent to the cloud

Full definitions: `occupancy_analyzer/docs/CONTRACT.md`. Samples: `plan/samples/`.

- **Event v2.** One per accepted plate.
  - The plate photo goes to the private storage bucket `event-snapshots` as `<event_id>.jpg`.
  - The record is then written to the `events` table.
  - Both writes are upserts, so a retry after a partial failure is safe.
  - Stream passwords are removed from the `source` field before anything is stored.
- **Heartbeat v1.** One per camera every `heartbeat.interval_s` (120 s in `config/config.yaml`), through the `report_heartbeat` function. It carries status, frame rate, upload backlog and, when the metrics process is running, a system snapshot.
- **Heartbeat status rules:**
  - `error`: no frame for more than 10 s.
  - `degraded`: frame rate below half of nominal, or more than 50 records waiting.
  - `ok`: otherwise.

Not sent: video, clips, rejected reads.

---

## 7. Cloud

### 7.1 Database (Supabase, Postgres)

Schema and logic are in `occupancy_analyzer/supabase/migrations/`, applied in file-name order.

| Table | Role |
|---|---|
| `lots`, `lot_capacity_history`, `cameras` | Settings, synced from `config/config.yaml` on each dashboard build |
| `events` | Raw input from the Jetson |
| `plate_reads` | One row per event, with normalized plate, direction and quality |
| `passes` | Reads merged per car (same camera, within 30 s, similar plate) |
| `parking_sessions` | Entry paired with exit; status and flags |
| `occupancy_timeline` | One row per change in occupancy |
| `match_overrides` | Admin decisions from the Review queue |
| `occupancy_calibrations` | Admin reconciles |
| `device_heartbeats` | Latest check-in per device |
| `ingest_errors` | Events that failed validation (unknown camera, wrong version, clock skew, engine error) |
| `alert_acks`, `audit_log` | Acknowledged alerts; who did what |
| `private.app_secrets` | The plate-scrambling key (`plate_hmac_key`) |

Access: every table is locked by row-level security with no policies. The dashboard reaches data only through role-checked functions. The Jetson uses the service-role key.

### 7.2 Engine (`engine` schema)

- **On each new event**, a trigger validates it, looks up the camera to get the direction, stores the read, then calls `engine.rebuild_lot(lot, event_time)`.
- **Rebuild** rewinds all derived tables to that time and replays forward in time order. Late or out-of-order events are therefore handled the same way as on-time ones. Admin decisions are inputs to the replay and survive it.
- **Matching an exit** compares it only with open sessions.
  - The score is a confidence-weighted edit distance that knows common OCR confusions and uses the alternate readings.
  - It closes automatically when the score is at least 0.85 and beats the next candidate by 0.15.
  - Scores from 0.65 go to the Review queue.
  - Plates of 4 characters or fewer never auto-match.
- **Occupancy** is entries minus exits, with corrections for re-entries, starting from the last reconcile. The band is a 95% interval based on assumed miss rates (2% in, 3% out). Open sessions are tracked as a cross-check.
- **Because direction is copied onto each read when it arrives**, changing a camera's direction later does not fix reads already stored. That is why the swapped-camera fix wipes the data.

### 7.3 Scheduled jobs inside the database (pg_cron)

| Job | When | What |
|---|---|---|
| `oa_rebuild_trailing` | Every 5 min | Rebuilds the last 2 hours for each lot |
| `oa_retention` | 07:30 UTC daily | Trims per-frame reads after 7 days; scrambles plate text after 30 days. **The scrambling step is skipped without warning if `plate_hmac_key` is missing.** |
| `oa_refresh_survival` | Hourly, minute 7 | Refreshes length-of-stay statistics used by the estimator |
| `oa_prune_cron_log` | 08:00 UTC daily | Trims the scheduler's own log |

### 7.4 Scheduled job in GitHub Actions

`.github/workflows/oa-nightly.yml`, 08:30 UTC daily: database backup with `pg_dump`, saved as a job artifact for 14 days, then deletion of plate photos older than 14 days.

**Status on 2026-11-17: all 34 runs have failed at the "Install pg_dump 17" step.** No backup exists and no photo has been deleted. See HANDOFF.md issues 3 and 4 before repairing it.

Secrets it needs: `OA_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

### 7.5 Dashboard (`occupancy_analyzer/web`)

- Next.js 16 with React 19, deployed on Vercel with root directory `occupancy_analyzer/web`.
- Login is Supabase Auth with email and password. Roles are `admin` and `staff`. `src/proxy.ts` redirects signed-out visitors; pages and functions check the role again on the server.
- The build runs `scripts/sync-config.ts`, which copies capacity and cameras from `config/config.yaml` into the database. Changing capacity therefore needs a redeploy.
- Live updates use Supabase Realtime on channel `lot:<id>`.
- "Ask the lot" (`src/app/api/chat/route.ts`) uses the OpenAI API with one tool that runs read-only SQL as the `gatf_readonly` role. That role can read only the reporting views. Limits: 20 questions per user per 10 minutes, 8 tool calls and 60 s per question.
- Pages are listed in the admin guide.

The older dashboard in `frontend/` is not part of the live system (HANDOFF.md issue 14).

---

## 8. Configuration and secrets

| File | Where | In git? | Holds |
|---|---|---|---|
| `config/config.yaml` | Repository | Yes | Lot ID, name, capacity (100), timezone, camera IDs and directions, heartbeat interval, AI model, retention days. No secrets. |
| `.env` | Jetson, repository root | No | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `CAM_IN_USER`, `CAM_IN_PASS`, `CAM_OUT_USER`, `CAM_OUT_PASS` |
| `scripts/video/recorder.config.json` | Jetson | No | Drive UUID, segment length, free-space floor, and per camera: IP, credentials prefix, stream options. **The committed example is out of date.** |
| `scripts/bytetrack_plates.yaml` | Repository | Yes | Tracker settings, with the measurements behind them |
| Vercel environment | Vercel | No | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `READONLY_DATABASE_URL`, `OPENAI_API_KEY`, `BOOTSTRAP_ADMIN_PASSWORD` |
| GitHub Actions secrets | GitHub | No | `OA_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `private.app_secrets` | Database | No | `plate_hmac_key`. Never change it. |

Which label points at which physical camera is decided by the keys in `recorder.config.json` (`inbound_cam_01`, `outbound_cam_01`). Each key's block holds that camera's address.

---

## 9. Operations

Commands assume the repository root on the Jetson. Service commands apply once the boot service is installed.

**Status and logs**

```bash
systemctl status gatf-pipeline
journalctl -u gatf-pipeline -f
ls /mnt/validation/gatf/logs/                      # one log per process
.venv/bin/python scripts/sysmetrics.py --watch     # live CPU, GPU, temperature, backlog
cat /mnt/validation/gatf/state/uploader.json       # backlog, last error
scripts/run_pipeline.sh --check                    # preflight only
```

**Start, stop, update**

```bash
sudo systemctl restart gatf-pipeline               # stop can take up to 5 min
git pull --ff-only && sudo systemctl restart gatf-pipeline
```

**Uploads are stuck** (backlog grows while the link is up). Look at `last_error` in `uploader.json`. Folders the uploader gave up on are in `events/<camera>_failed/`, each with `upload_error.json` giving the reason; `quarantined` in `uploader.json` counts them. To retry one after fixing it, move it back to `events/<camera>/`.

**Free space**

```bash
df -h /mnt/validation
du -sh /mnt/validation/gatf/{video,clips,events,metrics}
```

Uploaded record folders (those containing `.uploaded`) and old clips can be deleted by hand. Do not delete folders without `.uploaded`.

**Cellular data used.** The most reliable figure is the router's own data counter on its web page. The Jetson's metrics files also record uplink rates every 5 s (`uplink_tx_kbps`, `uplink_rx_kbps` under `system`). Those count everything on the Jetson's default-route interface. If the cameras share that interface, the figure includes camera video and is not usable; check `uplink_iface` and `camera_iface` in a metrics line.

**Stop automatic updates** (cellular data, and to keep NVIDIA packages stable):

```bash
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
sudo apt-mark hold 'nvidia-l4t-*'
```

Then apply security updates deliberately, on a schedule, when someone can watch.

**Camera work.** After replacing, re-aiming or re-addressing a camera, run the lane check in `deploy/jetson/README.md` and `python3 -m scripts.video.preflight --camera <id>`.

**Remove the SSD.** `scripts/video/eject.sh <drive_uuid>`, and wait for `SAFE TO UNPLUG`.

**Wipe a lot's data.** `occupancy_analyzer/tools/reset_lot_data.sql`. Read its header first. **It has not yet been run against any database**; try it on a local Supabase before production.

**Change capacity.** Edit `parkinglot.capacity` in `config/config.yaml`, commit, and redeploy the dashboard.

**Restore the database.** No procedure has been tested, because no backup has ever succeeded. Once backups work, test restoring one into a local Supabase and write the steps here.

---

## 10. Testing

| What | Command | Needs |
|---|---|---|
| Edge unit tests (contracts, uploader, clipper logic) | `uv run --with pytest --with pyyaml --with python-dotenv pytest scripts/tests -q` | Python only |
| Database engine tests (pgTAP) | `cd occupancy_analyzer && supabase start && supabase db reset && supabase test db` | Docker, Supabase CLI |
| Simulator tests | `cd occupancy_analyzer/simulator && uv run pytest` | `uv` |
| End-to-end with simulated cameras | `occupancy_analyzer/GETTING_STARTED.md`, mode A | Docker, Supabase CLI, Node 22, `uv` |
| Dashboard type check and lint | `cd occupancy_analyzer/web && npm run typecheck && npm run lint` | Node 22 |
| Jetson dry run | `scripts/run_pipeline.sh --dry-run 300` | The Jetson |

Nothing runs these automatically. None were run while writing this document.

The simulator (`occsim`) generates entry and exit camera output for 20 scenarios, including missed reads, look-alike plates, late uploads and reconciles. It can replay them into a database and score the result. Use it to test any engine change before it reaches production.

---

## 11. Tunable values

**Engine** (per lot; defaults in the migrations, read through `engine.setting`):

| Setting | Default | Meaning |
|---|---|---|
| `dedup_window_s` | 30 | Same camera, same plate within this window counts once |
| `dedup_sim` | 0.80 | Similarity needed to merge two reads |
| `t_auto` | 0.85 | Score to close a session automatically |
| `margin` | 0.15 | Lead needed over the second-best candidate |
| `t_review` | 0.65 | Score from which a match goes to the Review queue |
| `min_dwell_s` | 20 | Shortest stay treated as real |
| `reentry_min_s` | 300 | Gap before the same plate entering again is a new visit |
| `bounce_max_s` | 300 | Stays shorter than this are "bounces" |
| `expire_after_d` | 30 | Open sessions older than this expire |
| `effective_pct` | 0.85 | "Effectively full" threshold |
| `miss_rate_in` / `miss_rate_out` | 0.02 / 0.03 | Assumed missed-read rates behind the band |
| `heartbeat_offline_s` | 180 | Silence before a camera is "offline". Each dashboard build overwrites it with `heartbeat.offline_after_s` from `config/config.yaml` (360). |

**Edge:**

| Setting | Value | Where |
|---|---|---|
| Minimum plate length | 5 | `--min-plate-chars` |
| Detection confidence | 0.4 | `--conf` |
| Stream stall timeout | 15 s | `STALL_TIMEOUT_S` |
| Inference threads per reader | 2 | `--ort-threads` |
| Clip padding | 10 s before, 10 s after | `clipper.py --pre/--post` |
| Uploader CPU gate | 85% | `spool_uploader.py --max-cpu` |
| Uploader backoff | 5 s to 300 s | `spool_uploader.py` |
| Video free-space floor | 20 GB (example config) | `recorder.config.json` `min_free_gb` |
| Heartbeat interval | 120 s | `config/config.yaml` |

---

## 12. Repository map

| Path | Live? | What |
|---|---|---|
| `config/config.yaml` | Yes | Shared settings |
| `scripts/run_pipeline.sh` | Yes | Edge supervisor |
| `scripts/plate_ocr_reader.py`, `contract_v2.py`, `heartbeat.py`, `trt_backend.py`, `bytetrack_plates.yaml` | Yes | Plate reader |
| `scripts/spool_uploader.py`, `supabase_sync.py`, `upload_events.py` | Yes | Upload |
| `scripts/sysmetrics.py` | Yes | Metrics |
| `scripts/video/` | Yes | Recorder, clipper, drive handling, preflight, eject |
| `scripts/tests/` | Yes | Edge unit tests |
| `deploy/jetson/` | New, untested on the Jetson | Boot service and installer |
| `occupancy_analyzer/supabase/` | Yes | Database schema, engine, tests |
| `occupancy_analyzer/web/` | Yes | Dashboard |
| `occupancy_analyzer/simulator/` | Yes (test tool) | `occsim` |
| `occupancy_analyzer/tools/` | Yes | Backup, photo retention, data reset |
| `.github/workflows/oa-nightly.yml` | Yes, failing | Nightly backup and photo retention |
| `plan/` | Reference | Design documents and decisions |
| `frontend/`, `scripts/yolo_plate_reader.py`, `occupancy_demo.py`, `plate_reader.py`, `run_postgres_mcp.sh`, `capture.sh`, `lot_views.sql`, `readonly_role.sql`, `supabase_schema.sql`, `supabase_migration_plate_tracks.sql`, `zones.json`, `output_template/` | **No** | Earlier prototype. Not used by the live system. |
