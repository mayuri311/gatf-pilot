#!/usr/bin/env python3
"""
Shared Supabase upload logic - used by both upload_events.py (manual/cron
batch catch-up) and yolo_plate_reader.py's real-time background uploader, so
there's one implementation of "upload this event folder" instead of two.

Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET from the
environment; whichever script imports this is responsible for having called
load_dotenv() first if it wants values from a local .env file.
"""

import json
import os
import queue
import threading
from pathlib import Path

from supabase import create_client

UPLOADED_MARKER = ".uploaded"

_client = None


def credentials_configured():
    return bool(os.environ.get("SUPABASE_URL")) and bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))


def get_client():
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        )
    return _client


def upload_event(event_dir):
    """Uploads one local event folder (event.json + its image) to Supabase.
    Idempotent: a folder already carrying UPLOADED_MARKER is skipped (returns
    False) rather than re-uploaded."""
    event_dir = Path(event_dir)
    if (event_dir / UPLOADED_MARKER).exists():
        return False

    event_json_path = event_dir / "event.json"
    if not event_json_path.exists():
        return False

    bucket = os.environ.get("SUPABASE_BUCKET", "event-snapshots")
    payload = json.loads(event_json_path.read_text())
    image_path = event_dir / payload["image_filename"]
    storage_path = f"{payload['event_id']}.jpg"

    supabase = get_client()
    # upsert, because the image goes up before the row insert: if that insert
    # fails the folder keeps no UPLOADED_MARKER and gets retried, by which point
    # the object already exists and a plain upload would 409 on the duplicate.
    with open(image_path, "rb") as f:
        supabase.storage.from_(bucket).upload(
            storage_path, f.read(), {"content-type": "image/jpeg", "upsert": "true"}
        )

    row = {k: v for k, v in payload.items() if k != "image_filename"}
    row["image_path"] = storage_path
    # likewise upsert (conflict target is the event_id primary key) so a retry
    # after a partial failure re-settles the row instead of erroring on it.
    supabase.table("events").upsert(row).execute()

    (event_dir / UPLOADED_MARKER).touch()
    return True


class EventUploader:
    """Background thread draining a queue of local event folders to Supabase,
    so a slow/unreliable network connection (e.g. LTE on a Jetson) never
    blocks the frame/inference loop. submit() only ever does an in-memory
    queue.put() - the network call happens later, off the main thread.

    If credentials aren't configured, submit() is a no-op: events still get
    written locally by trigger_event(), just not synced in real time - run
    upload_events.py later, or set the env vars and restart to sync live.

    A failed upload is only logged, never retried automatically here - the
    event folder simply keeps its missing UPLOADED_MARKER, which is already
    upload_events.py's signal to pick it up on its next run. That's the
    retry path, not a second queue.
    """

    def __init__(self):
        self.queue = queue.Queue()
        self.enabled = credentials_configured()
        if self.enabled:
            threading.Thread(target=self._worker, daemon=True).start()
        else:
            print("[upload] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set - "
                  "events are saved locally only. Run upload_events.py later, "
                  "or set them in .env to sync in real time.")

    def submit(self, event_dir):
        if self.enabled:
            self.queue.put(event_dir)

    def _worker(self):
        while True:
            event_dir = self.queue.get()
            try:
                upload_event(event_dir)
            except Exception as e:
                print(f"[upload failed, will retry via upload_events.py] {event_dir}: {e}")
            finally:
                self.queue.task_done()
