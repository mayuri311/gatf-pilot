"""Cut a short verification clip around every plate event, from the recorded segments.

The plate readers write event folders to ``<mount>/gatf/events/<camera_id>/`` (and
``<camera_id>_rejected/``); the recorders write 10 s segments indexed in
``segments.db``. This process joins the two by camera_id + wall clock:

    window = [first_seen_utc - pre_s, last_seen_utc + post_s]

and remuxes the overlapping segments into one MP4. **No re-encoding** -- GStreamer's
``concat`` joins the segments, then ffmpeg trims with ``-c copy``, so the cut snaps to
the keyframe at or before the window start (the pre-roll pad absorbs that).

An event is clipped once its post-roll is on disk: a closed segment for that camera
ends at or after the window end. If that hasn't happened ``max_wait_s`` after the
window end (camera dropped, recorder down), whatever footage exists is cut and the
clip is marked ``partial``; with no footage at all, ``status: no_footage`` is
recorded so the event isn't retried forever.

Outputs (clips live outside ``video/`` so the recorder's retention never prunes them):
    <mount>/gatf/clips/<camera_id>/<YYYY-MM-DD>/<event_folder>.mp4
    <event_folder>/clip.json          # written last: its presence means "done"
    <mount>/gatf/state/clipper.json   # backlog, for sysmetrics.py

Like the recorder, this shares no state with the Supabase pipeline: it only reads
event.json and never touches the upload marker.

Usage
    python3 -m scripts.video.clipper                 # loop
    python3 -m scripts.video.clipper --once          # one pass, then exit
    python3 -m scripts.video.clipper --test-drive-root /tmp/fakedrive --once
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config as config_mod
from . import drive as drive_mod

log = logging.getLogger("clipper")

CLIP_MARKER = "clip.json"
DEFAULT_PRE_S = 10.0
DEFAULT_POST_S = 10.0
DEFAULT_MAX_WAIT_S = 90.0


def events_root(gatf: Path) -> Path:
    return gatf / "events"


def clips_root(gatf: Path) -> Path:
    return gatf / "clips"


def state_dir(gatf: Path) -> Path:
    return gatf / "state"


def _parse(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def event_window(payload: dict, pre_s: float, post_s: float) -> tuple[datetime, datetime]:
    """Clip window for one event.json. Events written before first/last_seen_utc
    existed fall back to the representative capture time."""
    first = payload.get("first_seen_utc") or payload["captured_at_utc"]
    last = payload.get("last_seen_utc") or payload["captured_at_utc"]
    return _parse(first) - timedelta(seconds=pre_s), _parse(last) + timedelta(seconds=post_s)


def pending_events(root: Path) -> list[Path]:
    """Event folders (accepted and rejected) with an event.json but no clip yet."""
    out = []
    if not root.is_dir():
        return out
    for camera_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for event_dir in sorted(p for p in camera_dir.iterdir() if p.is_dir()):
            if (event_dir / "event.json").exists() and not (event_dir / CLIP_MARKER).exists():
                out.append(event_dir)
    return out


def connect_ro(db: Path) -> sqlite3.Connection:
    """Read-only: the recorders own the index; WAL lets us read alongside them."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def overlapping_segments(conn, camera_id: str, start: datetime, end: datetime) -> list[dict]:
    rows = conn.execute(
        "SELECT filename, start_utc, end_utc FROM segments"
        " WHERE camera_id = ? AND deleted_utc IS NULL ORDER BY start_utc",
        (camera_id,),
    ).fetchall()
    out = []
    for r in rows:
        s, e = _parse(r["start_utc"]), _parse(r["end_utc"])
        if e > start and s < end:
            out.append({"filename": r["filename"], "start": s, "end": e})
    return out


def latest_end(conn, camera_id: str) -> datetime | None:
    row = conn.execute(
        "SELECT max(end_utc) AS m FROM segments WHERE camera_id = ?", (camera_id,)
    ).fetchone()
    return _parse(row["m"]) if row and row["m"] else None


def covered_seconds(segments: list[dict], start: datetime, end: datetime) -> float:
    total = 0.0
    for seg in segments:
        lo, hi = max(seg["start"], start), min(seg["end"], end)
        total += max((hi - lo).total_seconds(), 0.0)
    return total


def _run(cmd: list[str], what: str) -> None:
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
    except subprocess.CalledProcessError as exc:
        # NVIDIA's ffmpeg also logs h264_cuvid probe failures here; harmless, rc is what counts
        raise RuntimeError(f"{what} failed (rc={exc.returncode}): {exc.stderr.strip()[-500:]}") from exc


def cut_clip(gatf: Path, segments: list[dict], start: datetime, end: datetime, out: Path) -> None:
    """Join + trim with stream copy. Writes to temp names, then renames.

    JetPack's ffmpeg (8.0.1-nvidia1) is a stripped build with no concat demuxer, so the
    join is GStreamer's ``concat`` element (qtdemux -> h264parse -> mp4mux, no decode),
    and ffmpeg only does the single-file trim, which that build does support.
    """
    first_start = segments[0]["start"]
    offset = max((start - first_start).total_seconds(), 0.0)
    duration = (end - max(start, first_start)).total_seconds()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part.mp4")
    joined = out.with_name(out.stem + ".join.mp4")
    paths = [str((gatf / seg["filename"]).resolve()) for seg in segments]
    try:
        if len(paths) == 1:
            source = paths[0]
        else:
            cmd = ["gst-launch-1.0", "-q", "concat", "name=c", "!", "h264parse", "!",
                   "mp4mux", "!", "filesink", f"location={joined}"]
            for path in paths:
                cmd += ["filesrc", f"location={path}", "!", "qtdemux", "!", "h264parse", "!", "c."]
            _run(cmd, "gstreamer join")
            source = str(joined)
        # -ss before -i: seek on the input, which with -c copy lands on a keyframe
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
              "-ss", f"{offset:.3f}", "-i", source, "-t", f"{duration:.3f}",
              "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", str(tmp)],
             "ffmpeg trim")
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)
        joined.unlink(missing_ok=True)


def write_marker(event_dir: Path, info: dict) -> None:
    tmp = event_dir / (CLIP_MARKER + ".tmp")
    tmp.write_text(json.dumps(info, indent=2) + "\n")
    os.replace(tmp, event_dir / CLIP_MARKER)


def process_event(gatf: Path, conn, event_dir: Path, pre_s: float, post_s: float,
                  max_wait_s: float, now: datetime | None = None) -> str:
    """Clip one event if it's ready. Returns 'clipped', 'partial', 'no_footage',
    'waiting' or 'error'."""
    now = now or datetime.now(timezone.utc)
    try:
        payload = json.loads((event_dir / "event.json").read_text())
        camera_id = payload["camera_id"]
        start, end = event_window(payload, pre_s, post_s)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.error("%s: unreadable event.json (%s) - skipping", event_dir.name, exc)
        write_marker(event_dir, {"status": "error", "error": f"unreadable event.json: {exc}"})
        return "error"

    newest = latest_end(conn, camera_id)
    timed_out = (now - end).total_seconds() > max_wait_s
    if (newest is None or newest < end) and not timed_out:
        return "waiting"

    segments = overlapping_segments(conn, camera_id, start, end)
    base = {
        "camera_id": camera_id,
        "event_id": payload.get("event_id"),
        "window_start_utc": start.isoformat(),
        "window_end_utc": end.isoformat(),
        "segments": [s["filename"] for s in segments],
        "created_utc": now.isoformat(),
    }
    if not segments:
        log.warning("%s: no footage for %s in %s .. %s", event_dir.name, camera_id,
                    start.isoformat(), end.isoformat())
        write_marker(event_dir, {**base, "status": "no_footage", "clip_path": None})
        return "no_footage"

    covered = covered_seconds(segments, start, end)
    want = (end - start).total_seconds()
    partial = covered < want - 1.0  # allow ~1 s of boundary slop
    out = clips_root(gatf) / camera_id / start.strftime("%Y-%m-%d") / f"{event_dir.name}.mp4"
    try:
        cut_clip(gatf, segments, start, end, out)
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
        log.error("%s: %s", event_dir.name, exc)
        if timed_out:  # give up for good rather than retrying every pass
            write_marker(event_dir, {**base, "status": "error", "error": str(exc), "clip_path": None})
        return "error"

    status = "partial" if partial else "clipped"
    write_marker(event_dir, {
        **base,
        "status": status,
        "clip_path": str(out.relative_to(gatf)),
        "covered_s": round(covered, 2),
        "window_s": round(want, 2),
        "size_bytes": out.stat().st_size,
    })
    log.info("%s -> %s (%s, %.1f of %.1f s)", event_dir.name, out.relative_to(gatf),
             status, covered, want)
    return status


def write_state(gatf: Path, counts: dict, backlog: int) -> None:
    d = state_dir(gatf)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "clipper.json.tmp"
    tmp.write_text(json.dumps({
        "updated_utc": datetime.now(timezone.utc).isoformat(),
        "backlog": backlog,
        "totals": counts,
    }) + "\n")
    os.replace(tmp, d / "clipper.json")


def run_pass(gatf: Path, pre_s: float, post_s: float, max_wait_s: float, counts: dict) -> int:
    """One sweep over pending events. Returns how many are still waiting."""
    db = drive_mod.db_path(gatf)
    pending = pending_events(events_root(gatf))
    if not pending:
        write_state(gatf, counts, 0)
        return 0
    if not db.exists():
        log.warning("no segment index at %s yet - is the recorder running?", db)
        write_state(gatf, counts, len(pending))
        return len(pending)
    conn = connect_ro(db)
    waiting = 0
    try:
        for event_dir in pending:
            result = process_event(gatf, conn, event_dir, pre_s, post_s, max_wait_s)
            if result in ("waiting", "error"):
                waiting += 1
            else:
                counts[result] = counts.get(result, 0) + 1
    finally:
        conn.close()
    write_state(gatf, counts, waiting)
    return waiting


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--test-drive-root", help="use this directory instead of resolving the UUID")
    parser.add_argument("--pre", type=float, default=DEFAULT_PRE_S, help="seconds before first sighting")
    parser.add_argument("--post", type=float, default=DEFAULT_POST_S, help="seconds after last sighting")
    parser.add_argument("--max-wait", type=float, default=DEFAULT_MAX_WAIT_S,
                        help="seconds past the window end to wait for footage before cutting a partial clip")
    parser.add_argument("--poll", type=float, default=5.0)
    parser.add_argument("--once", action="store_true", help="one pass, then exit")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for tool, pkg in (("ffmpeg", "ffmpeg"), ("gst-launch-1.0", "gstreamer1.0-tools")):
        if shutil.which(tool) is None:
            raise RuntimeError(f"{tool} not found. On JetPack: sudo apt install {pkg}")

    cfg = config_mod.load(args.config, credentials=False)
    if args.test_drive_root:
        gatf = drive_mod.gatf_root(Path(args.test_drive_root))
    else:
        _, gatf = drive_mod.resolve(cfg.drive_uuid)

    counts: dict = {}
    if args.once:
        waiting = run_pass(gatf, args.pre, args.post, args.max_wait, counts)
        print(f"clipper: {counts or 'nothing clipped'}, {waiting} still waiting")
        return 0

    stop = {"flag": False}
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.update(flag=True))
    log.info("watching %s (pre %.0fs, post %.0fs)", events_root(gatf), args.pre, args.post)
    while not stop["flag"]:
        try:
            run_pass(gatf, args.pre, args.post, args.max_wait, counts)
        except sqlite3.Error as exc:  # a busy index must never kill the clipper
            log.warning("index read failed: %s", exc)
        deadline = time.monotonic() + args.poll
        while not stop["flag"] and time.monotonic() < deadline:
            time.sleep(0.2)
    log.info("stopped: %s", counts)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (config_mod.ConfigError, drive_mod.DriveError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
