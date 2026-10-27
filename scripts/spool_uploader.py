#!/usr/bin/env python3
"""
Spool uploader: drains the on-SSD event spool to Supabase, as its own process.

The plate readers (run with --no-upload) only ever write event folders to
<spool>/<camera_id>/ - a slow or dead uplink can never back up into the frame
loop. This process runs alongside them and uploads every folder still missing
its .uploaded marker, oldest first, with the same supabase_sync.upload_event()
that upload_events.py and the in-process uploader use (idempotent upserts, so
a crash mid-upload is simply retried).

It yields to the cameras: before each upload it samples CPU, and while the
Jetson is busier than --max-cpu it waits instead (the backlog is safe on the
SSD and is reported in every heartbeat as pending_uploads). Network/API
failures back off exponentially (5 s -> 5 min) and reset on the next success.
Rejected tracks (<camera_id>_rejected/) are local-only by design and never
uploaded.

State for sysmetrics.py: <state-dir>/uploader.json (backlog, oldest pending
age, last success/error, bytes sent, whether it's currently CPU-gated).

Usage (from the repo root; run_pipeline.sh starts it under nice/ionice):
    python scripts/spool_uploader.py --spool /mnt/validation/gatf/events
    python scripts/spool_uploader.py --spool ... --once     # drain once, exit
"""

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from scripts.contract_v2 import UPLOADED_MARKER  # noqa: E402

BACKOFF_MIN_S = 5
BACKOFF_MAX_S = 300
CPU_GATE_WAIT_S = 10


def pending_folders(spool):
    """Accepted event folders without UPLOADED_MARKER, oldest first. Folder names
    start with the UTC finalize time, so a name sort is a time sort."""
    spool = Path(spool)
    if not spool.is_dir():
        return []
    out = []
    for camera_dir in spool.iterdir():
        if not camera_dir.is_dir() or camera_dir.name.endswith("_rejected"):
            continue
        for event_dir in camera_dir.iterdir():
            if (event_dir.is_dir() and (event_dir / "event.json").exists()
                    and not (event_dir / UPLOADED_MARKER).exists()):
                out.append(event_dir)
    return sorted(out, key=lambda d: d.name)


def folder_bytes(event_dir):
    return sum(f.stat().st_size for f in Path(event_dir).iterdir() if f.is_file())


def cpu_busy(max_cpu):
    """(busy, cpu_percent). Samples over 1 s so a single spike doesn't gate."""
    import psutil
    pct = psutil.cpu_percent(interval=1)
    return pct > max_cpu, pct


class SpoolUploader:
    def __init__(self, spool, state_dir, max_cpu=85.0, upload_fn=None, busy_fn=None,
                 sleep=time.sleep):
        self.spool = Path(spool)
        self.state_path = Path(state_dir) / "uploader.json"
        self.max_cpu = max_cpu
        if upload_fn is None:
            from scripts.supabase_sync import upload_event
            upload_fn = upload_event
        self.upload_fn = upload_fn
        self.busy_fn = busy_fn or (lambda: cpu_busy(self.max_cpu))
        self.sleep = sleep
        self.backoff_s = 0
        self.stopping = False
        # folders upload_event() declined (not contract v2): it leaves no marker,
        # so remember them rather than re-trying and re-logging every pass
        self.skipped = set()
        self.state = {"uploaded": 0, "failed": 0, "bytes_sent": 0, "gated": False,
                      "cpu_pct": None, "last_success_utc": None, "last_error": None,
                      "last_error_utc": None, "backoff_s": 0}

    def write_state(self, pending):
        oldest_age = None
        if pending:
            try:
                oldest_age = round(time.time() - (pending[0] / "event.json").stat().st_mtime)
            except OSError:
                pass
        self.state.update(backlog=len(pending), oldest_pending_age_s=oldest_age,
                          backoff_s=self.backoff_s,
                          updated_utc=datetime.now(timezone.utc).isoformat())
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state) + "\n")
        os.replace(tmp, self.state_path)

    def run_once(self):
        """One sweep. Returns True if the spool was drained, False if it stopped
        early (CPU gate, network failure, or stop requested)."""
        pending = [d for d in pending_folders(self.spool) if d not in self.skipped]
        self.write_state(pending)
        for i, event_dir in enumerate(pending):
            if self.stopping:
                return False
            busy, pct = self.busy_fn()
            self.state.update(gated=busy, cpu_pct=pct)
            if busy:
                self.write_state(pending[i:])
                return False
            try:
                size = folder_bytes(event_dir)
                if self.upload_fn(event_dir):
                    self.state["uploaded"] += 1
                    self.state["bytes_sent"] += size
                    self.state["last_success_utc"] = datetime.now(timezone.utc).isoformat()
                    print(f"[upload] {event_dir.parent.name}/{event_dir.name}")
                elif not (event_dir / UPLOADED_MARKER).exists():
                    self.skipped.add(event_dir)
                self.backoff_s = 0
            except Exception as e:  # network / API: back off, keep the folder
                self.state["failed"] += 1
                self.state["last_error"] = f"{type(e).__name__}: {e}"[:300]
                self.state["last_error_utc"] = datetime.now(timezone.utc).isoformat()
                self.backoff_s = min(max(self.backoff_s * 2, BACKOFF_MIN_S), BACKOFF_MAX_S)
                print(f"[upload failed, retry in {self.backoff_s}s] {event_dir.name}: {e}")
                self.write_state(pending[i:])
                return False
        self.write_state([d for d in pending_folders(self.spool) if d not in self.skipped])
        return True

    def run(self, poll_s=5):
        print(f"[uploader] draining {self.spool} (CPU gate {self.max_cpu:.0f}%)")
        while not self.stopping:
            drained = self.run_once()
            if self.stopping:
                break
            if self.backoff_s:
                wait = self.backoff_s
            elif not drained and self.state["gated"]:
                wait = CPU_GATE_WAIT_S
            else:
                wait = poll_s
            deadline = time.monotonic() + wait
            while not self.stopping and time.monotonic() < deadline:
                self.sleep(0.2)
        print(f"[uploader] stopped: {self.state['uploaded']} uploaded, "
              f"{self.state['failed']} failures")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spool", required=True,
                    help="spool root holding <camera_id>/ event folders "
                         "(e.g. /mnt/validation/gatf/events)")
    ap.add_argument("--state-dir", default=None,
                    help="where uploader.json goes (default: <spool>/../state)")
    ap.add_argument("--max-cpu", type=float, default=85.0,
                    help="don't start an upload while total CPU is above this %%")
    ap.add_argument("--poll", type=float, default=5.0)
    ap.add_argument("--once", action="store_true", help="drain once, then exit")
    args = ap.parse_args()

    from scripts.supabase_sync import credentials_configured
    if not credentials_configured():
        ap.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (repo-root .env)")

    state_dir = args.state_dir or Path(args.spool).resolve().parent / "state"
    uploader = SpoolUploader(args.spool, state_dir, max_cpu=args.max_cpu)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: setattr(uploader, "stopping", True))
    if args.once:
        uploader.run_once()
        s = uploader.state
        print(f"{s['uploaded']} uploaded, {s['failed']} failed, {s['backlog']} pending")
    else:
        uploader.run(args.poll)
