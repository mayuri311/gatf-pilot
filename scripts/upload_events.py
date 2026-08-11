#!/usr/bin/env python3
"""
Catch-up uploader for locally-logged events (from yolo_plate_reader.py's
events/ folder) to Supabase: vehicle.jpg goes to a private Storage bucket,
event.json becomes a row in the `events` Postgres table (see
supabase_schema.sql). Upload logic lives in supabase_sync.py, shared with
yolo_plate_reader.py's real-time background uploader.

Run this whenever you want to sweep up anything that wasn't synced live -
the camera pipeline uploads in real time via a background thread when
SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set, but network failures there
only get logged, not retried; this script is the retry path (safe to re-run,
already-uploaded event folders carry a local .uploaded marker and are
skipped).

Setup:
    1. Create a Supabase project, then in its dashboard:
       - SQL Editor: paste and run supabase_schema.sql
       - Storage: create a bucket (Public bucket OFF) - name it whatever you
         put in SUPABASE_BUCKET below
       - Settings -> API: copy the Project URL and the service_role key
    2. cp .env.example .env, fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET
    3. pip install --no-deps -r inductiverobo.txt  (after supabase + python-dotenv are added to it)

Usage:
    python upload_events.py [--events-dir events]

To view an uploaded image later (the bucket is private, so URLs expire):
    supabase.storage.from_(SUPABASE_BUCKET).create_signed_url(image_path, 3600)
"""

import argparse
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from supabase_sync import upload_event


def run(events_dir):
    events_dir = Path(events_dir)

    uploaded = skipped = failed = 0
    for event_dir in sorted(events_dir.iterdir()):
        if not event_dir.is_dir():
            continue
        try:
            if upload_event(event_dir):
                uploaded += 1
                print(f"uploaded {event_dir.name}")
            else:
                skipped += 1
        except Exception as e:
            failed += 1
            print(f"FAILED {event_dir.name}: {e}")

    print(f"\n{uploaded} uploaded, {skipped} already uploaded, {failed} failed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--events-dir", default="events")
    args = ap.parse_args()
    run(args.events_dir)
