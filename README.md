pip install --no-deps -r inductiverobo.txt to set up venv
python yolo_plate_reader.py --source "rtsp://user:pass@<camera-ip>/axis-media/media.amp"# gatf-pilot


## Producer v2 (edge camera software)

`scripts/plate_ocr_reader.py` emits event contract v2 and heartbeat v1 (`plan/13-data-contracts.md`). Run it from the repo root on each Jetson; `camera_id` must match `config/config.yaml` `cameras[]`, and `device_id` is looked up there (override with `--device-id`). Supabase credentials come from the repo-root `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`).

```bash
# entrance Jetson (jetson-in-01)
python scripts/plate_ocr_reader.py --camera-id inbound_cam_01 \
    --source "rtsp://user:pass@<inbound-cam-ip>/axis-media/media.amp" --headless
# exit Jetson (jetson-out-01)
python scripts/plate_ocr_reader.py --camera-id outbound_cam_01 \
    --source "rtsp://user:pass@<outbound-cam-ip>/axis-media/media.amp" --headless
# replay a recording with its real capture times, local only
python scripts/plate_ocr_reader.py --camera-id inbound_cam_01 \
    --source camera_captures/capture_20260813_205719.mp4 \
    --source-start-utc 2026-08-14T00:57:19Z --no-upload
# catch-up / retry uploads; --camera-id backfills pre-v2 event.json files
python scripts/upload_events.py --events-dir events --camera-id inbound_cam_01
# unit tests (no cv2/ML libs needed)
uv run --with pytest --with pyyaml --with python-dotenv pytest scripts/tests -q
```

- Accepted events upload in real time; rejected tracks stay in `<events-dir>_rejected` and are never uploaded.
- A heartbeat is sent every `heartbeat.interval_s` (60 s) via the `report_heartbeat` RPC. Without Supabase credentials it is appended to `heartbeats.jsonl` next to the events dir.
- Stream credentials are stripped from `source` before anything is stored or logged. A dropped RTSP stream is reopened automatically.

## One Jetson, both cameras (`scripts/run_pipeline.sh`)

One Jetson runs both Axis cameras off the PoE switch. `scripts/run_pipeline.sh` starts and supervises, per camera, the segment recorder (10 s MP4 segments to the SSD) and the plate reader (events to an SSD spool, `--no-upload`), plus one clipper (±10 s verification clip per event), one spool uploader (drains the spool to Supabase, yields when CPU > 85 %, backs off on network errors) and `sysmetrics.py` (CPU/GPU/RAM/temperature/bitrate/uplink/SSD, attached to heartbeats). Each camera process keeps its own `device_id` from `config/config.yaml`, because `device_heartbeats` is keyed by it.

```bash
scripts/run_pipeline.sh --check            # preflight: SSD, venv, ffmpeg, .env, eth link, camera pings
scripts/run_pipeline.sh --dry-run 300      # 5 min run, clean stop, summary
scripts/run_pipeline.sh                    # until Ctrl-C (graceful: readers -> post-roll -> recorders -> clips -> uploads)
.venv/bin/python scripts/sysmetrics.py --watch   # live metrics view
```

- Camera IPs live in `scripts/video/recorder.config.json` (gitignored; copy the `.example`).
- The repo-root `.env` needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `CAM_IN_USER`/`CAM_IN_PASS` and `CAM_OUT_USER`/`CAM_OUT_PASS`.
- On the SSD (`/mnt/validation/gatf/`): `video/` holds the continuous ring, pruned oldest-first under 20 GB free. `clips/` holds the event clips, which are never pruned. `events/` is the upload spool. `metrics/` holds the jsonl history. `logs/` holds one log per process.
- Dashboard metrics need `occupancy_analyzer/supabase/migrations/20261024000100_device_metrics.sql` applied.
