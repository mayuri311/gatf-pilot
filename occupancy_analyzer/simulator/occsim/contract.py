"""Small JSON-schema-like validators for event v2 and heartbeat v1 (doc 13,
occupancy_analyzer/docs/CONTRACT.md §1). Return a list of error strings
(empty = valid)."""

from __future__ import annotations

import re
import uuid
from datetime import datetime

from .config import SimConfig

PLATE_RE = re.compile(r"^[A-Z0-9]+$")

# Columns of public.events (CONTRACT §1.1) minus image_path, plus the local
# image_filename that the uploader converts into image_path.
EVENT_DB_COLUMNS = (
    "event_id", "schema_version", "event_type", "camera_id", "device_id", "captured_at_utc",
    "timestamp_utc", "source", "track_id", "frame_first", "frame_last", "representative_frame_index",
    "num_frames_tracked", "num_frames_with_text", "num_frames_used_for_consensus", "plate_text",
    "plate_confidence", "plate_confidence_per_char", "plate_detection_confidence",
    "plate_bounding_box", "reads", "image_path",
)
EVENT_FILE_KEYS = set(EVENT_DB_COLUMNS) - {"image_path"} | {"image_filename"}
EVENT_REQUIRED = EVENT_FILE_KEYS - {"source"}

HEARTBEAT_KEYS = {
    "schema_version", "type", "device_id", "camera_id", "sent_at_utc", "status", "camera_connected",
    "fps", "last_event_at_utc", "pending_uploads", "uptime_s", "app_version", "message",
}


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_prob(v) -> bool:
    return _is_num(v) and 0.0 <= v <= 1.0


def _iso_with_offset(v) -> datetime | None:
    if not isinstance(v, str):
        return None
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else None


def _camera_ok(cfg: SimConfig | None, camera_id, device_id, errs: list[str]) -> None:
    if cfg is None:
        return
    cams = {c.camera_id: c for c in cfg.cameras}
    if camera_id not in cams:
        errs.append(f"camera_id {camera_id!r} not in config cameras {sorted(cams)}")
    elif cams[camera_id].device_id != device_id:
        errs.append(f"device_id {device_id!r} != config device {cams[camera_id].device_id!r} for {camera_id}")


def validate_event(ev: dict, cfg: SimConfig | None = None, *, strict: bool = True) -> list[str]:
    """strict=True additionally requires reads[] to hold every tracked frame
    (num_frames_tracked == len(reads)), as the simulator and producer write
    it. The doc sample shortens reads[], so validate it with strict=False."""
    errs: list[str] = []
    if not isinstance(ev, dict):
        return ["event is not an object"]
    missing = EVENT_REQUIRED - ev.keys()
    if missing:
        errs.append(f"missing keys: {sorted(missing)}")
    extra = ev.keys() - EVENT_FILE_KEYS - {"rejected", "rejection_reason"}
    if extra:
        errs.append(f"unexpected keys (not contract columns): {sorted(extra)}")
    if ev.get("schema_version") != 2:
        errs.append(f"schema_version must be 2, got {ev.get('schema_version')!r}")
    if ev.get("event_type") != "plate_track_finalized":
        errs.append(f"event_type must be 'plate_track_finalized', got {ev.get('event_type')!r}")
    try:
        uuid.UUID(str(ev.get("event_id")))
    except ValueError:
        errs.append(f"event_id not a uuid: {ev.get('event_id')!r}")
    for k in ("camera_id", "device_id"):
        if not isinstance(ev.get(k), str) or not ev.get(k):
            errs.append(f"{k} must be a non-empty string")
    _camera_ok(cfg, ev.get("camera_id"), ev.get("device_id"), errs)
    cap = _iso_with_offset(ev.get("captured_at_utc"))
    ts = _iso_with_offset(ev.get("timestamp_utc"))
    if cap is None:
        errs.append(f"captured_at_utc not ISO-8601 with offset: {ev.get('captured_at_utc')!r}")
    if ts is None:
        errs.append(f"timestamp_utc not ISO-8601 with offset: {ev.get('timestamp_utc')!r}")
    if cap and ts and ts < cap:
        errs.append("timestamp_utc (finalize) is before captured_at_utc")
    if "source" in ev and ev["source"] is not None:
        if not isinstance(ev["source"], str):
            errs.append("source must be a string")
        elif re.search(r"://[^/]*:[^/]*@", ev["source"]):
            errs.append("source contains credentials")
    for k in ("track_id", "frame_first", "frame_last", "representative_frame_index",
              "num_frames_tracked", "num_frames_with_text", "num_frames_used_for_consensus"):
        if not _is_int(ev.get(k)):
            errs.append(f"{k} must be an int, got {ev.get(k)!r}")
    if all(_is_int(ev.get(k)) for k in ("frame_first", "frame_last", "representative_frame_index")):
        if not ev["frame_first"] <= ev["representative_frame_index"] <= ev["frame_last"]:
            errs.append("representative_frame_index outside [frame_first, frame_last]")
    pt = ev.get("plate_text")
    if not isinstance(pt, str) or not PLATE_RE.match(pt):
        errs.append(f"plate_text must match [A-Z0-9]+, got {pt!r}")
    if not _is_prob(ev.get("plate_confidence")):
        errs.append(f"plate_confidence must be in [0,1], got {ev.get('plate_confidence')!r}")
    pcc = ev.get("plate_confidence_per_char")
    if not isinstance(pcc, list) or not all(_is_prob(c) for c in pcc):
        errs.append("plate_confidence_per_char must be a list of numbers in [0,1]")
    elif isinstance(pt, str) and len(pcc) != len(pt):
        errs.append(f"plate_confidence_per_char length {len(pcc)} != len(plate_text) {len(pt)}")
    if not _is_prob(ev.get("plate_detection_confidence")):
        errs.append("plate_detection_confidence must be in [0,1]")
    bb = ev.get("plate_bounding_box")
    if not isinstance(bb, dict) or set(bb) != {"x1", "y1", "x2", "y2"} or not all(_is_int(v) for v in bb.values()):
        errs.append(f"plate_bounding_box must be {{x1,y1,x2,y2}} ints, got {bb!r}")
    elif not (bb["x1"] < bb["x2"] and bb["y1"] < bb["y2"]):
        errs.append("plate_bounding_box has non-positive size")
    reads = ev.get("reads")
    if not isinstance(reads, list) or not reads:
        errs.append("reads must be a non-empty list")
    else:
        prev = None
        for i, r in enumerate(reads):
            if not isinstance(r, dict) or set(r) != {"frame_index", "text", "confidence", "clean"}:
                errs.append(f"reads[{i}] must have exactly frame_index,text,confidence,clean")
                break
            if not _is_int(r["frame_index"]) or not isinstance(r["text"], str) or not isinstance(r["clean"], bool):
                errs.append(f"reads[{i}] bad types")
                break
            if r["confidence"] is not None and not _is_prob(r["confidence"]):
                errs.append(f"reads[{i}].confidence out of range")
            if r["clean"] != bool(PLATE_RE.match(r["text"].strip().upper())):
                errs.append(f"reads[{i}].clean inconsistent with text {r['text']!r}")
            if prev is not None and r["frame_index"] <= prev:
                errs.append(f"reads[{i}].frame_index not increasing")
            prev = r["frame_index"]
        if _is_int(ev.get("frame_first")) and reads[0].get("frame_index") != ev["frame_first"]:
            errs.append("frame_first != reads[0].frame_index")
        if _is_int(ev.get("frame_last")) and reads[-1].get("frame_index") != ev["frame_last"]:
            errs.append("frame_last != reads[-1].frame_index")
        if strict:
            if ev.get("num_frames_tracked") != len(reads):
                errs.append("num_frames_tracked != len(reads)")
            if ev.get("num_frames_with_text") != sum(1 for r in reads if isinstance(r, dict) and r.get("text")):
                errs.append("num_frames_with_text != count of reads with text")
    nt, nwt, nc = (ev.get(k) for k in ("num_frames_tracked", "num_frames_with_text", "num_frames_used_for_consensus"))
    if all(_is_int(x) for x in (nt, nwt, nc)) and not (0 < nc <= nwt <= nt):
        errs.append("expected 0 < num_frames_used_for_consensus <= num_frames_with_text <= num_frames_tracked")
    if ev.get("image_filename") != "plate.jpg":
        errs.append(f"image_filename must be 'plate.jpg', got {ev.get('image_filename')!r}")
    return errs


def validate_heartbeat(hb: dict, cfg: SimConfig | None = None) -> list[str]:
    errs: list[str] = []
    if not isinstance(hb, dict):
        return ["heartbeat is not an object"]
    missing = HEARTBEAT_KEYS - hb.keys()
    if missing:
        errs.append(f"missing keys: {sorted(missing)}")
    extra = hb.keys() - HEARTBEAT_KEYS
    if extra:
        errs.append(f"unexpected keys: {sorted(extra)}")
    if hb.get("schema_version") != 1:
        errs.append("schema_version must be 1")
    if hb.get("type") != "heartbeat":
        errs.append("type must be 'heartbeat'")
    _camera_ok(cfg, hb.get("camera_id"), hb.get("device_id"), errs)
    if _iso_with_offset(hb.get("sent_at_utc")) is None:
        errs.append("sent_at_utc not ISO-8601 with offset")
    if hb.get("status") not in ("ok", "degraded", "error"):
        errs.append(f"status invalid: {hb.get('status')!r}")
    if not isinstance(hb.get("camera_connected"), bool):
        errs.append("camera_connected must be bool")
    if not _is_num(hb.get("fps")) or hb.get("fps") < 0:
        errs.append("fps must be a non-negative number")
    if hb.get("last_event_at_utc") is not None and _iso_with_offset(hb.get("last_event_at_utc")) is None:
        errs.append("last_event_at_utc must be null or ISO-8601 with offset")
    for k in ("pending_uploads", "uptime_s"):
        if not _is_int(hb.get(k)) or hb.get(k) < 0:
            errs.append(f"{k} must be a non-negative int")
    if not isinstance(hb.get("app_version"), str):
        errs.append("app_version must be a string")
    if hb.get("message") is not None and not isinstance(hb.get("message"), str):
        errs.append("message must be null or string")
    return errs


def db_row(event: dict) -> dict:
    """event.json -> public.events row: contract columns only, + image_path."""
    row = {k: v for k, v in event.items() if k in EVENT_DB_COLUMNS}
    row["image_path"] = f"{event['event_id']}.jpg"
    return row
