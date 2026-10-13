#!/usr/bin/env python3
"""
Catch-up uploader for locally-logged plate events (plate_ocr_reader.py's
events/ folder) to Supabase: plate.jpg goes to the private Storage bucket as
<event_id>.jpg, event.json becomes a row in the `events` table (event
contract v2 - plan/13-data-contracts.md §1). Upload logic lives in
supabase_sync.py, shared with plate_ocr_reader.py's real-time background
uploader.

Run this whenever you want to sweep up anything that wasn't synced live -
the camera pipeline uploads in real time via a background thread when
SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set, but network failures there
only get logged, not retried; this script is the retry path (safe to re-run,
already-uploaded event folders carry a local .uploaded marker and are
skipped).

Only v2 events with a camera_id are uploaded. Event folders written before
v2 (no schema_version / camera_id / device_id / captured_at_utc) are skipped
with a log line - unless you say which camera they came from with
--camera-id (and optionally --device-id, else looked up in config.yaml),
in which case the missing fields are backfilled for the upload only, with a
warning per folder. captured_at_utc is then backfilled from timestamp_utc
(the finalize time, a few seconds after the car actually passed).

Setup:
    1. Repo-root .env holds SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
       SUPABASE_BUCKET (see occupancy_analyzer/docs/CONTRACT.md §0)
    2. pip install --no-deps -r inductiverobo.txt

Usage (from the repo root):
    python scripts/upload_events.py [--events-dir events]
    python scripts/upload_events.py --events-dir old_events --camera-id inbound_cam_01

To view an uploaded image later (the bucket is private, so URLs expire):
    supabase.storage.from_(SUPABASE_BUCKET).create_signed_url(image_path, 3600)
"""

import argparse
import sys
from pathlib import Path

# make `scripts.*` importable both as `python scripts/upload_events.py` and
# as `python -m scripts.upload_events`
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv

load_dotenv()

from scripts.contract_v2 import DEFAULT_CONFIG_PATH, load_config, resolve_device_id
from scripts.supabase_sync import upload_event


def run(events_dir, defaults=None):
    events_dir = Path(events_dir)

    uploaded = skipped = failed = 0
    for event_dir in sorted(events_dir.iterdir()):
        if not event_dir.is_dir():
            continue
        try:
            if upload_event(event_dir, defaults=defaults):
                uploaded += 1
                print(f"uploaded {event_dir.name}")
            else:
                skipped += 1
        except Exception as e:
            failed += 1
            print(f"FAILED {event_dir.name}: {e}")

    print(f"\n{uploaded} uploaded, {skipped} skipped (already uploaded, or not "
          f"uploadable - see log), {failed} failed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--events-dir", default="events")
    ap.add_argument("--camera-id", default=None,
                    help="camera_id to backfill into pre-v2 event.json files that "
                         "lack one (never overrides an existing value)")
    ap.add_argument("--device-id", default=None,
                    help="device_id to backfill likewise (default: config.yaml "
                         "cameras[] entry for --camera-id, else hostname)")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG_PATH),
                    help="config.yaml used to look up --device-id")
    args = ap.parse_args()

    defaults = None
    if args.camera_id or args.device_id:
        device_id = args.device_id
        if args.camera_id and not device_id:
            device_id = resolve_device_id(load_config(args.config), args.camera_id)
        defaults = {"camera_id": args.camera_id, "device_id": device_id}
        print(f"[warn] backfill enabled for pre-v2 events: {defaults}")
    run(args.events_dir, defaults)
