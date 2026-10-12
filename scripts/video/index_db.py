"""On-drive SQLite index of recorded video segments.

The index lives on the external SSD itself (``<mount>/gatf/index/segments.db``) so
that the drive is self-describing: plug it into any machine and the database tells
you every segment on it, which camera it came from, and the global wall-clock window
it covers. Nothing here talks to Supabase or the network.

Durability notes: WAL + ``synchronous=FULL``. One commit per finished segment is a
few hundred bytes every ``segment_seconds``, so the cost is irrelevant next to the
video writes, and it means an unclean unplug cannot lose an already-closed segment.
"""

from __future__ import annotations

import csv
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# Column order is deliberate: the four fields the operator actually asked for come
# first so `head segments.csv` answers the question without horizontal scrolling.
CSV_COLUMNS = [
    "filename",
    "camera_id",
    "start_utc",
    "end_utc",
    "duration_s",
    "size_bytes",
    "drive_uuid",
    "session_id",
    "fragment_id",
    "start_running_ns",
    "end_running_ns",
    "complete",
    "deleted_utc",
]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS drive (
    drive_uuid      TEXT PRIMARY KEY,
    label           TEXT,
    filesystem      TEXT,
    created_utc     TEXT NOT NULL,
    schema_version  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recording_sessions (
    session_id      TEXT PRIMARY KEY,
    camera_id       TEXT NOT NULL,
    rtsp_redacted   TEXT NOT NULL,
    started_utc     TEXT NOT NULL,
    ended_utc       TEXT,
    clock_source    TEXT,
    gst_version     TEXT,
    host            TEXT
);

CREATE TABLE IF NOT EXISTS segments (
    filename            TEXT PRIMARY KEY,
    camera_id           TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    drive_uuid          TEXT NOT NULL,
    start_utc           TEXT NOT NULL,
    end_utc             TEXT NOT NULL,
    duration_s          REAL NOT NULL,
    start_running_ns    INTEGER NOT NULL,
    end_running_ns      INTEGER NOT NULL,
    size_bytes          INTEGER NOT NULL,
    fragment_id         INTEGER NOT NULL,
    complete            INTEGER NOT NULL DEFAULT 1,
    deleted_utc         TEXT
);

CREATE INDEX IF NOT EXISTS idx_segments_time ON segments(camera_id, start_utc);
CREATE INDEX IF NOT EXISTS idx_segments_live ON segments(deleted_utc, start_utc);
"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: Path) -> sqlite3.Connection:
    """Open (creating if needed) the segment index and apply the schema."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    return conn


def register_drive(conn: sqlite3.Connection, drive_uuid: str, label: str, filesystem: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO drive (drive_uuid, label, filesystem, created_utc, schema_version)"
        " VALUES (?, ?, ?, ?, ?)",
        (drive_uuid, label, filesystem, utc_now_iso(), SCHEMA_VERSION),
    )


def start_session(
    conn: sqlite3.Connection,
    session_id: str,
    camera_id: str,
    rtsp_redacted: str,
    clock_source: str,
    gst_version: str,
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO recording_sessions"
        " (session_id, camera_id, rtsp_redacted, started_utc, ended_utc, clock_source, gst_version, host)"
        " VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
        (
            session_id,
            camera_id,
            rtsp_redacted,
            utc_now_iso(),
            clock_source,
            gst_version,
            os.uname().nodename,
        ),
    )


def end_session(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute(
        "UPDATE recording_sessions SET ended_utc = ? WHERE session_id = ? AND ended_utc IS NULL",
        (utc_now_iso(), session_id),
    )


def insert_segment(conn: sqlite3.Connection, row: dict) -> None:
    """Record a finished segment. Keyed on filename so re-indexing is idempotent."""
    conn.execute(
        "INSERT OR REPLACE INTO segments"
        " (filename, camera_id, session_id, drive_uuid, start_utc, end_utc, duration_s,"
        "  start_running_ns, end_running_ns, size_bytes, fragment_id, complete, deleted_utc)"
        " VALUES (:filename, :camera_id, :session_id, :drive_uuid, :start_utc, :end_utc, :duration_s,"
        "  :start_running_ns, :end_running_ns, :size_bytes, :fragment_id, :complete, :deleted_utc)",
        {"complete": 1, "deleted_utc": None, **row},
    )


def oldest_live_segments(conn: sqlite3.Connection, limit: int = 50) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM segments WHERE deleted_utc IS NULL ORDER BY start_utc ASC LIMIT ?",
            (limit,),
        )
    )


def tombstone_segment(conn: sqlite3.Connection, filename: str) -> None:
    """Mark a segment as pruned. The row is kept so the capture history survives retention."""
    conn.execute(
        "UPDATE segments SET deleted_utc = ? WHERE filename = ?", (utc_now_iso(), filename)
    )


def export_csv(conn: sqlite3.Connection, csv_path: Path) -> int:
    """Write the CSV mirror atomically (temp file + rename) so a yank can't tear it."""
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = csv_path.with_suffix(csv_path.suffix + ".tmp")
    rows = list(conn.execute("SELECT * FROM segments ORDER BY camera_id, start_utc"))
    with open(tmp, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row[k] for k in CSV_COLUMNS})
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, csv_path)
    return len(rows)


def checkpoint(conn: sqlite3.Connection) -> str:
    """Fold the WAL back into the .db so the single file is complete and portable."""
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return conn.execute("PRAGMA integrity_check").fetchone()[0]


def _probe_duration(path: Path) -> float | None:
    """Best-effort duration via ffprobe; None means the file is unreadable/truncated."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1", str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def reconcile(
    conn: sqlite3.Connection, video_root: Path, gatf_root: Path, drive_uuid: str = ""
) -> dict:
    """Crash recovery: reconcile the index against what is actually on the drive.

    Files with no row are adopted (duration probed with ffprobe; unreadable ones are
    marked complete=0). Rows whose file has vanished without a tombstone are flagged
    complete=0 rather than deleted, so the gap stays visible.
    """
    known = {r["filename"] for r in conn.execute("SELECT filename FROM segments")}
    on_disk: set[str] = set()
    adopted, orphaned = 0, 0

    for path in sorted(video_root.rglob("*.mp4")):
        rel = str(path.relative_to(gatf_root))
        on_disk.add(rel)
        if rel in known:
            continue
        # camera_id is the first path component under video/, by construction.
        camera_id = path.relative_to(video_root).parts[0]
        duration = _probe_duration(path)
        stat = path.stat()
        # No reliable start time for an orphan; fall back to mtime minus duration.
        end_dt = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        start_dt = end_dt if duration is None else datetime.fromtimestamp(
            stat.st_mtime - duration, tz=timezone.utc
        )
        insert_segment(conn, {
            "filename": rel,
            "camera_id": camera_id,
            "session_id": "recovered",
            "drive_uuid": drive_uuid,
            "start_utc": start_dt.isoformat(),
            "end_utc": end_dt.isoformat(),
            "duration_s": duration or 0.0,
            "start_running_ns": 0,
            "end_running_ns": 0,
            "size_bytes": stat.st_size,
            "fragment_id": -1,
            "complete": 1 if duration is not None else 0,
        })
        adopted += 1

    for rel in known - on_disk:
        row = conn.execute(
            "SELECT deleted_utc FROM segments WHERE filename = ?", (rel,)
        ).fetchone()
        if row and row["deleted_utc"] is None:
            conn.execute("UPDATE segments SET complete = 0 WHERE filename = ?", (rel,))
            orphaned += 1

    return {"adopted": adopted, "missing": orphaned, "on_disk": len(on_disk)}
