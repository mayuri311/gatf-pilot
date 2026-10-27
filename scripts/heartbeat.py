#!/usr/bin/env python3
"""
Heartbeat v1 sender for the edge producer (plan/13-data-contracts.md §2).

HeartbeatSender runs a daemon thread inside the camera process. The frame
loop only calls cheap in-memory hooks - note_frame() per frame,
note_event() per finalized plate, set_stream_state() on (re)connects - and
the thread turns that into one heartbeat every interval_s seconds. The
payload itself is built by the pure contract_v2.build_heartbeat(), so the
status rules are unit tested without a camera.

A failed send is only logged, never raised: a dead network must not take the
frame loop down with it. The next beat simply tries again, and the server
derives "offline" from beats that never arrive.

Edge-system metrics: when sysmetrics.py is running it keeps a
state/metrics_latest.json snapshot; pass its path as metrics_path and each beat
carries that snapshot (plus this camera's stream bitrate) under `metrics`.
A missing or stale snapshot (older than METRICS_MAX_AGE_S) is simply left out.

Where beats go:
  - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set -> rpc('report_heartbeat',
    {'hb': ...}) via supabase_sync.send_heartbeat()
  - otherwise (offline mode) -> one JSON line per beat appended to
    <events_dir>/../heartbeats.jsonl
"""

import json
import threading
import time
from pathlib import Path

from scripts.contract_v2 import (
    APP_VERSION, build_heartbeat, count_pending_uploads,
    supabase_credentials_configured, utc_now,
)

# The first beat goes out shortly after start instead of a whole interval
# later, so a freshly (re)started device shows up as online right away.
FIRST_BEAT_AFTER_S = 5

# A metrics snapshot older than this is a dead collector, not current data.
METRICS_MAX_AGE_S = 30


def offline_heartbeat_path(events_dir):
    return Path(events_dir).resolve().parent / "heartbeats.jsonl"


def make_jsonl_writer(path):
    path = Path(path)

    def _write(hb):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(hb) + "\n")
    return _write


def load_metrics_summary(path, camera_id, max_age_s=METRICS_MAX_AGE_S, now=None):
    """The heartbeat `metrics` dict from sysmetrics.py's latest snapshot: the
    shared system figures plus this camera's own stream bitrate. None if the
    file is missing, unreadable or stale - a heartbeat must never fail on it."""
    try:
        snap = json.loads(Path(path).read_text())
        age = (now or time.time()) - float(snap["sampled_at_epoch"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if age > max_age_s:
        return None
    summary = dict(snap.get("system") or {})
    cam = (snap.get("cameras") or {}).get(camera_id) or {}
    summary["camera_mbps"] = cam.get("mbps")
    summary["sampled_at_utc"] = snap.get("sampled_at_utc")
    return summary


def make_send_fn(events_dir):
    """Supabase RPC if credentials are configured, else the offline jsonl file.
    Returns (send_fn, human-readable destination)."""
    if supabase_credentials_configured():
        # lazy: offline mode (and the unit tests) never need the supabase client
        from scripts.supabase_sync import send_heartbeat
        return send_heartbeat, "supabase rpc report_heartbeat"
    path = offline_heartbeat_path(events_dir)
    return make_jsonl_writer(path), str(path)


class HeartbeatSender:
    def __init__(self, device_id, camera_id, events_dir, interval_s=60,
                 send_fn=None, nominal_fps=None, app_version=APP_VERSION,
                 clock=time.monotonic, metrics_path=None):
        self.device_id = device_id
        self.camera_id = camera_id
        self.events_dir = Path(events_dir)
        self.interval_s = interval_s
        self.nominal_fps = nominal_fps
        self.app_version = app_version
        if send_fn is None:
            send_fn, self.destination = make_send_fn(events_dir)
        else:
            self.destination = getattr(send_fn, "__name__", "custom")
        self.send_fn = send_fn
        self._clock = clock
        self.metrics_path = metrics_path

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._started_at = clock()
        self._window_start = self._started_at
        self._frames_in_window = 0
        self._last_frame_at = None          # monotonic
        self._last_event_at_utc = None      # datetime
        self._stream_open = False
        self._message = None

    # --- hooks called from the frame loop (cheap, never block on I/O) -------

    def note_frame(self):
        with self._lock:
            self._frames_in_window += 1
            self._last_frame_at = self._clock()

    def note_event(self, at_utc=None):
        with self._lock:
            self._last_event_at_utc = at_utc or utc_now()

    def set_stream_state(self, is_open, message=None):
        """is_open: the capture is open. message: short note such as
        'rtsp reconnecting', reported until the next call clears it."""
        with self._lock:
            self._stream_open = bool(is_open)
            self._message = message

    def set_nominal_fps(self, fps):
        with self._lock:
            self.nominal_fps = fps

    # --- payload + sending ---------------------------------------------------

    def build(self):
        """Snapshot the counters into one heartbeat and start a new fps window."""
        now = self._clock()
        with self._lock:
            elapsed = max(now - self._window_start, 1e-6)
            fps = self._frames_in_window / elapsed
            self._frames_in_window = 0
            self._window_start = now
            # before the first frame, count from process start so the first
            # NO_FRAMES_ERROR_S of startup don't already read as "error"
            since_frame = now - (self._last_frame_at if self._last_frame_at is not None
                                 else self._started_at)
            last_event_at = self._last_event_at_utc
            stream_open = self._stream_open
            message = self._message
            nominal_fps = self.nominal_fps
        return build_heartbeat(
            device_id=self.device_id,
            camera_id=self.camera_id,
            sent_at=utc_now(),
            fps=fps,
            nominal_fps=nominal_fps,
            last_event_at=last_event_at,
            pending_uploads=count_pending_uploads(self.events_dir),
            uptime_s=now - self._started_at,
            seconds_since_last_frame=since_frame,
            stream_open=stream_open,
            message=message,
            app_version=self.app_version,
            metrics=(load_metrics_summary(self.metrics_path, self.camera_id)
                     if self.metrics_path else None),
        )

    def send_once(self):
        """Build and send one beat. Returns the payload, or None if it failed -
        any error is logged and swallowed."""
        try:
            hb = self.build()
            self.send_fn(hb)
            return hb
        except Exception as e:
            print(f"[heartbeat failed] {e}")
            return None

    def start(self):
        print(f"[heartbeat] every {self.interval_s}s -> {self.destination}")
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def _worker(self):
        wait = min(FIRST_BEAT_AFTER_S, self.interval_s)
        while not self._stop.wait(wait):
            self.send_once()
            wait = self.interval_s
