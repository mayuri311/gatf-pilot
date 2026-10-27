#!/usr/bin/env python3
"""
Pure helpers for the edge -> DB wire contracts (plan/13-data-contracts.md,
occupancy_analyzer/docs/CONTRACT.md §1): event v2 and heartbeat v1.

Deliberately imports nothing heavy (no cv2 / fast_alpr / ultralytics /
supabase) so the payload shapes can be unit tested on any machine - see
scripts/tests/test_contract_v2.py. plate_ocr_reader.py, heartbeat.py,
supabase_sync.py and upload_events.py all build or filter their payloads
through here, so there's one definition of "what goes on the wire".
"""

import os
import re
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

EVENT_SCHEMA_VERSION = 2
HEARTBEAT_SCHEMA_VERSION = 1
EVENT_TYPE = "plate_track_finalized"
# Producer version string reported in every heartbeat. Bump on producer changes.
APP_VERSION = "0.4.0"

UPLOADED_MARKER = ".uploaded"

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "config.yaml"
DEFAULT_HEARTBEAT_INTERVAL_S = 60

# Columns public.events accepts (CONTRACT.md §1.1). Anything else in event.json
# (rejected, rejection_reason, image_filename, ...) must be dropped by the
# sender, or PostgREST rejects the whole insert with PGRST204.
EVENT_COLUMNS = (
    "event_id", "schema_version", "event_type", "camera_id", "device_id",
    "captured_at_utc", "timestamp_utc", "source", "track_id",
    "frame_first", "frame_last", "representative_frame_index",
    "num_frames_tracked", "num_frames_with_text", "num_frames_used_for_consensus",
    "plate_text", "plate_confidence", "plate_confidence_per_char",
    "plate_detection_confidence", "plate_bounding_box", "reads",
    "image_path",
)

# Heartbeat status thresholds (doc 13 §2: "keep the logic trivial").
NO_FRAMES_ERROR_S = 10          # no frame for longer than this -> error
LOW_FPS_RATIO = 0.5             # fps below half of nominal -> degraded
MAX_PENDING_UPLOADS = 50        # upload backlog above this -> degraded

# Schemes that mean "a live stream", as opposed to a video file on disk.
LIVE_SCHEMES = {"rtsp", "rtsps", "rtmp", "http", "https", "udp", "tcp", "srt"}

# A plate read is only trusted if it is pure A-Z0-9. The OCR model emits "_" as
# its blank/pad token, so reads like "1_1", "5__33" or "41_7" are partial
# decodes leaking the pad character - not plates. Excluding them from the vote
# both kills those false positives and sharpens consensus on real plates, whose
# clean reads then dominate the modal-length grouping.
CLEAN_READ_RE = re.compile(r"^[A-Z0-9]+$")


def normalize_read(text):
    return (text or "").strip().upper()


def is_clean_read(text):
    return bool(CLEAN_READ_RE.match(normalize_read(text)))


# --- time helpers ------------------------------------------------------------

def utc_now():
    return datetime.now(timezone.utc)


def parse_utc(value):
    """ISO-8601 string -> aware UTC datetime. A naive value is taken as UTC,
    and a trailing 'Z' is accepted (fromisoformat only learned it in 3.11)."""
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if s.endswith(("Z", "z")):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_utc(dt):
    """Aware datetime -> '2026-08-14T14:24:42.509093+00:00' (always with the
    offset and microseconds, matching the existing timestamp_utc format)."""
    if dt is None:
        return None
    return parse_utc(dt).isoformat(timespec="microseconds")


def captured_at_for(frame_index, grabbed_at_utc, source_start_utc=None, fps=None):
    """Capture time of one frame.

    Video file with a known start time: start + frame_index / fps, so a
    replayed file gets the times it was really recorded at, independent of how
    fast this machine processes it. Otherwise (live stream, or no start time /
    usable fps): the wall-clock time the frame was grabbed.
    """
    if source_start_utc is not None and fps and fps > 0:
        return parse_utc(source_start_utc) + timedelta(seconds=frame_index / fps)
    return parse_utc(grabbed_at_utc)


# --- source helpers ----------------------------------------------------------

def is_live_source(source):
    """Webcam index or a streaming URL -> True; a path to a video file -> False."""
    if isinstance(source, int):
        return True
    s = str(source)
    if s.isdigit():
        return True
    return urlsplit(s).scheme.lower() in LIVE_SCHEMES


def redact_source(source):
    """Strip credentials from a stream URL before it is logged or stored:
    rtsp://user:pass@host:554/path -> rtsp://host:554/path. File paths and
    webcam indexes pass through unchanged (as a string)."""
    if source is None:
        return None
    s = str(source)
    parts = urlsplit(s)
    if not parts.scheme or "@" not in parts.netloc:
        return s
    # rsplit: a password may itself contain '@'; the host never does
    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


# --- config helpers ----------------------------------------------------------

def load_config(path=None):
    """Repo-root config/config.yaml (v2) as a dict; {} if it doesn't exist, so
    the producer still runs on a box without the repo config."""
    path = Path(path or DEFAULT_CONFIG_PATH)
    if not path.exists():
        return {}
    import yaml  # lazy: only needed when a config file is actually present
    with open(path) as f:
        return yaml.safe_load(f) or {}


def config_cameras(config):
    return [c for c in (config or {}).get("cameras") or [] if isinstance(c, dict)]


def resolve_camera_id(config, camera_id=None, device_id=None, hostname=None):
    """Explicit --camera-id wins. Otherwise the camera whose device_id matches
    --device-id (or this machine's hostname), if exactly one does. Returns
    None when it can't be resolved - the caller decides that's fatal."""
    if camera_id:
        return camera_id
    want = device_id or hostname or socket.gethostname()
    matches = [c["camera_id"] for c in config_cameras(config)
               if c.get("device_id") == want and c.get("camera_id")]
    return matches[0] if len(matches) == 1 else None


def resolve_device_id(config, camera_id, device_id=None, hostname=None):
    """Explicit --device-id wins, then config cameras[].device_id for this
    camera_id, then the hostname."""
    if device_id:
        return device_id
    for c in config_cameras(config):
        if c.get("camera_id") == camera_id and c.get("device_id"):
            return c["device_id"]
    return hostname or socket.gethostname()


def heartbeat_interval_s(config):
    try:
        value = int(((config or {}).get("heartbeat") or {}).get("interval_s") or 0)
    except (TypeError, ValueError):
        value = 0
    return value if value > 0 else DEFAULT_HEARTBEAT_INTERVAL_S


# --- event v2 ----------------------------------------------------------------

def build_event_payload(*, event_id, finalized_at, camera_id, device_id, source,
                        track_id, readings, consensus, image_filename,
                        rejected=False, rejection_reason=None):
    """The event.json payload for one finalized track (event contract v2).

    `readings` are the track's buffered per-frame reads (frame_index, text,
    confidence, captured_at_utc, ...) in frame order; `consensus` is
    plate_ocr_reader.best_reading(readings). captured_at_utc comes from the
    representative frame - the backend uses it as the event time - while
    timestamp_utc stays the finalize time, kept for diagnostics.
    """
    representative = consensus["representative"]
    captured_at = representative.get("captured_at_utc") or finalized_at
    return {
        "schema_version": EVENT_SCHEMA_VERSION,
        "event_id": str(event_id),
        "event_type": EVENT_TYPE,
        "camera_id": camera_id,
        "device_id": device_id,
        "captured_at_utc": iso_utc(captured_at),
        "timestamp_utc": iso_utc(finalized_at),
        "source": redact_source(source),
        "track_id": track_id,
        "frame_first": readings[0]["frame_index"],
        "frame_last": readings[-1]["frame_index"],
        "num_frames_tracked": len(readings),
        "num_frames_with_text": sum(1 for r in readings if r["text"]),
        "num_frames_used_for_consensus": consensus["num_frames_used_for_consensus"],
        "plate_text": consensus["plate_text"],
        "plate_confidence": consensus["plate_confidence"],
        "plate_confidence_per_char": consensus["plate_confidence_per_char"],
        "plate_detection_confidence": representative["detection_confidence"],
        # relative to the full camera frame at the representative frame, not a vehicle crop
        "plate_bounding_box": representative["bounding_box"],
        "representative_frame_index": representative["frame_index"],
        # Per-read audit trail: `clean` marks which reads were eligible to vote, so a
        # surprising consensus can be traced back without re-running the video.
        "reads": [
            {
                "frame_index": r["frame_index"],
                "text": r["text"],
                "confidence": r["confidence"],
                "clean": is_clean_read(r["text"]),
            }
            for r in readings
        ],
        "image_filename": image_filename,
        # local audit only - the uploader drops these, and rejected tracks never
        # leave rejected_dir anyway
        "rejected": bool(rejected),
        "rejection_reason": rejection_reason,
        # local-only too: when the plate was first/last seen, so video/clipper.py
        # can cut the verification clip around the whole pass
        "first_seen_utc": iso_utc(readings[0].get("captured_at_utc")),
        "last_seen_utc": iso_utc(readings[-1].get("captured_at_utc")),
    }


def event_upload_problem(payload):
    """Why this event.json must NOT be uploaded, or None if it may be."""
    if payload.get("schema_version") != EVENT_SCHEMA_VERSION:
        return f"schema_version={payload.get('schema_version')!r} (need {EVENT_SCHEMA_VERSION})"
    if payload.get("event_type") != EVENT_TYPE:
        return f"event_type={payload.get('event_type')!r} (need {EVENT_TYPE!r})"
    if not payload.get("camera_id"):
        return "missing camera_id"
    if not payload.get("event_id"):
        return "missing event_id"
    if payload.get("rejected"):
        return f"rejected track ({payload.get('rejection_reason')})"
    return None


def filter_event_columns(payload, image_path):
    """event.json payload -> the public.events row: only contract columns,
    plus image_path. Source is redacted again here as a backstop for event
    files written before the producer stripped credentials."""
    row = {k: payload[k] for k in EVENT_COLUMNS if k in payload and k != "image_path"}
    if "source" in row:
        row["source"] = redact_source(row["source"])
    row["image_path"] = image_path
    return row


def backfill_legacy_event(payload, camera_id=None, device_id=None):
    """Fill the v2 fields a pre-v2 plate event.json lacks, for catch-up uploads
    (upload_events.py --camera-id/--device-id). Returns (new_payload,
    [backfilled field names]); the input dict is not modified. Only plate
    track events are touched - legacy vehicle-crossing events from
    yolo_plate_reader.py are a different shape and stay un-uploadable."""
    if payload.get("event_type") != EVENT_TYPE:
        return payload, []
    out = dict(payload)
    filled = []
    if "schema_version" not in out:
        out["schema_version"] = EVENT_SCHEMA_VERSION
        filled.append("schema_version")
    if not out.get("camera_id") and camera_id:
        out["camera_id"] = camera_id
        filled.append("camera_id")
    if not out.get("device_id") and device_id:
        out["device_id"] = device_id
        filled.append("device_id")
    if not out.get("captured_at_utc") and out.get("timestamp_utc"):
        # finalize time is a few seconds after the car actually passed - the
        # best available guess for an old file
        out["captured_at_utc"] = out["timestamp_utc"]
        filled.append("captured_at_utc")
    return out, filled


# --- heartbeat v1 ------------------------------------------------------------

def count_pending_uploads(events_dir):
    """Event folders in events_dir not yet carrying UPLOADED_MARKER - the
    upload backlog reported in every heartbeat."""
    events_dir = Path(events_dir)
    if not events_dir.is_dir():
        return 0
    return sum(1 for d in events_dir.iterdir()
               if d.is_dir() and not (d / UPLOADED_MARKER).exists())


def heartbeat_status(fps, nominal_fps, pending_uploads, seconds_since_last_frame):
    """ok / degraded / error, per doc 13 §2 - trivial on purpose."""
    if seconds_since_last_frame is None or seconds_since_last_frame > NO_FRAMES_ERROR_S:
        return "error"
    if nominal_fps and fps < LOW_FPS_RATIO * nominal_fps:
        return "degraded"
    if pending_uploads > MAX_PENDING_UPLOADS:
        return "degraded"
    return "ok"


def build_heartbeat(*, device_id, camera_id, sent_at, fps, nominal_fps,
                    last_event_at, pending_uploads, uptime_s,
                    seconds_since_last_frame, stream_open=True, message=None,
                    app_version=APP_VERSION, metrics=None):
    """One heartbeat v1 payload (CONTRACT.md §1.2). camera_connected means the
    stream is open AND delivered a frame within NO_FRAMES_ERROR_S. metrics is an
    optional edge-system snapshot (sysmetrics.py) - an additive key, so
    schema_version stays 1 and older report_heartbeat versions just ignore it."""
    status = heartbeat_status(fps, nominal_fps, pending_uploads, seconds_since_last_frame)
    camera_connected = bool(stream_open) and status != "error"
    if message is None:
        if seconds_since_last_frame is None:
            message = "no frames received yet"
        elif status == "error":
            message = f"no frames for {int(seconds_since_last_frame)} s"
        elif status == "degraded" and pending_uploads > MAX_PENDING_UPLOADS:
            message = f"upload backlog {pending_uploads}"
        elif status == "degraded":
            message = f"low fps ({fps:.1f} of {nominal_fps:.1f})"
    hb = {
        "schema_version": HEARTBEAT_SCHEMA_VERSION,
        "type": "heartbeat",
        "device_id": device_id,
        "camera_id": camera_id,
        "sent_at_utc": iso_utc(sent_at),
        "status": status,
        "camera_connected": camera_connected,
        "fps": round(float(fps), 1),
        "last_event_at_utc": iso_utc(last_event_at),
        "pending_uploads": int(pending_uploads),
        "uptime_s": int(uptime_s),
        "app_version": app_version,
        "message": message,
    }
    if metrics:
        hb["metrics"] = metrics
    return hb


def supabase_credentials_configured():
    """Same check as supabase_sync.credentials_configured(), without importing
    the supabase client (so offline mode / tests don't need it)."""
    return bool(os.environ.get("SUPABASE_URL")) and bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
