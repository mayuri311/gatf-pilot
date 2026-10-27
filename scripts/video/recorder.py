"""Continuous fixed-duration RTSP segment recorder -> external SSD.

Remuxes the camera's native H.264 elementary stream into sequential MP4 segments
with GStreamer's splitmuxsink. **Nothing is ever decoded or re-encoded** -- the Orin
Nano has no hardware encoder, so the pipeline is strictly:

    rtspsrc ! rtph264depay ! h264parse ! (mp4mux inside splitmuxsink)

Every closed segment is committed to a SQLite index living on the drive itself, with
the global wall-clock start/end and the camera id. This process is deliberately
independent of the Supabase pipeline: it shares no imports, no config and no state
with supabase_sync.py / yolo_plate_reader.py.

Usage
    python -m scripts.video.recorder --init-drive
    python -m scripts.video.recorder --camera gatf-lot-01
    python -m scripts.video.recorder --camera gatf-lot-01 --duration 900
    python -m scripts.video.recorder --test-file camera_captures/capture_x.mp4 \
        --test-drive-root /tmp/fakedrive --segment-seconds 10
    python -m scripts.video.recorder --reconcile
    python -m scripts.video.recorder --export-csv
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config as config_mod
from . import drive as drive_mod
from . import index_db

# GStreamer is imported lazily so the index-only subcommands (--status, --export-csv,
# --reconcile) work on any machine with a plain Python -- including a laptop you plug
# the drive into to inspect it. Only recording needs python3-gi.
Gst = None
GLib = None


def _ensure_gst() -> None:
    global Gst, GLib
    if Gst is not None:
        return
    try:
        import gi

        gi.require_version("Gst", "1.0")
        from gi.repository import GLib as _GLib, Gst as _Gst
    except (ImportError, ValueError) as exc:
        raise RuntimeError(
            f"GStreamer Python bindings unavailable ({exc}). On JetPack:\n"
            f"  sudo apt install python3-gi gir1.2-gstreamer-1.0 "
            f"gir1.2-gst-plugins-base-1.0 gstreamer1.0-plugins-good gstreamer1.0-plugins-bad"
        ) from exc
    Gst, GLib = _Gst, _GLib
    Gst.init(None)

log = logging.getLogger("recorder")

NS_PER_S = 1_000_000_000
# One pid file per camera, so eject.sh can stop every recorder that is running.
PID_FILENAME = "recorder-{camera_id}.pid"

# Matches the UTC convention the event pipeline already uses (yolo_plate_reader.py),
# deliberately NOT capture.sh's local-time format, so segment names and event dir
# names sort and correlate directly.
TS_FORMAT = "%Y%m%dT%H%M%S%f"


def _fmt_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime(TS_FORMAT) + "Z"


def _structure_from_string(text: str) -> Gst.Structure:
    """Gst.Structure parsing differs across GStreamer/PyGObject versions."""
    if hasattr(Gst.Structure, "new_from_string"):
        return Gst.Structure.new_from_string(text)
    result = Gst.Structure.from_string(text)
    return result[0] if isinstance(result, tuple) else result


def enforce_retention(cfg, gatf_root: Path, conn) -> bool:
    """Free up space by pruning the oldest segments. Returns False to stop recording.

    Kept out of SegmentRecorder so it can be exercised without GStreamer. Rows are
    tombstoned rather than deleted, so the record of what was captured survives the
    pruning of the footage itself.
    """
    min_free = cfg.min_free_gb * 1e9
    if drive_mod.free_bytes(gatf_root) >= min_free:
        return True

    free_gb = drive_mod.free_bytes(gatf_root) / 1e9
    if cfg.retention == "stop":
        log.error(
            "free space %.1f GB is below min_free_gb=%.1f and retention='stop' — stopping",
            free_gb, cfg.min_free_gb,
        )
        return False

    log.warning("free space %.1f GB below threshold — pruning oldest segments", free_gb)
    pruned = 0
    for row in index_db.oldest_live_segments(conn, limit=200):
        if drive_mod.free_bytes(gatf_root) >= min_free:
            break
        target = gatf_root / row["filename"]
        if target == Path(row["filename"]):
            continue  # defensive: an absolute filename would escape the drive tree
        try:
            target.unlink(missing_ok=True)
        except OSError as exc:
            log.error("could not delete %s: %s", target, exc)
            continue
        index_db.tombstone_segment(conn, row["filename"])
        log.info("pruned %s", row["filename"])
        pruned += 1

    if drive_mod.free_bytes(gatf_root) < min_free:
        log.error("still below the free-space threshold after pruning %d segments", pruned)
    return True


class SegmentRecorder:
    def __init__(
        self,
        cfg: config_mod.RecorderConfig,
        camera: config_mod.Camera,
        gatf_root: Path,
        conn,
        test_file: Path | None = None,
        duration_s: float | None = None,
    ) -> None:
        self.cfg = cfg
        self.camera = camera
        self.gatf_root = gatf_root
        self.video_root = drive_mod.video_root(gatf_root)
        self.conn = conn
        self.test_file = test_file
        self.duration_s = duration_s

        _ensure_gst()
        self.loop = GLib.MainLoop()
        self.pipeline: Gst.Pipeline | None = None
        self.session_id = ""
        self.shutting_down = False
        self.exit_code = 0

        # running-time -> wall clock anchor, set on the first fragment of a session.
        self.epoch_utc: datetime | None = None
        # location -> partial row, filled at fragment-opened, committed at -closed.
        self.open_fragments: dict[str, dict] = {}

        self.backoff_s = 1.0
        self.segments_written = 0
        self.bytes_written = 0

    # ------------------------------------------------------------------ pipeline

    def _build_pipeline(self) -> Gst.Pipeline:
        pipeline = Gst.Pipeline.new("segment-recorder")

        if self.test_file:
            src = Gst.ElementFactory.make("filesrc", "src")
            src.set_property("location", str(self.test_file))
            demux = Gst.ElementFactory.make("qtdemux", "demux")
            pipeline.add(src)
            pipeline.add(demux)
            src.link(demux)
            dynamic_src = demux
            depay = None
        else:
            src = Gst.ElementFactory.make("rtspsrc", "src")
            src.set_property("location", self.camera.rtsp_url)
            src.set_property("protocols", 4)  # GST_RTSP_LOWER_TRANS_TCP
            src.set_property("latency", self.cfg.rtsp_latency_ms)
            src.set_property("do-retransmission", False)
            if self.cfg.ntp_sync:
                # Align buffer timestamps to the camera's RTCP sender-report clock so
                # the indexed wall-clock windows track the camera, not our own clock.
                src.set_property("ntp-sync", True)
                src.set_property("ntp-time-source", 3)  # GST_RTP_NTP_TIME_SOURCE_CLOCK_TIME
                src.set_property("buffer-mode", 4)      # synced
            depay = Gst.ElementFactory.make("rtph264depay", "depay")
            pipeline.add(src)
            pipeline.add(depay)
            dynamic_src = src

        parse = Gst.ElementFactory.make("h264parse", "parse")
        parse.set_property("config-interval", -1)  # repeat SPS/PPS so segments stand alone
        caps = Gst.ElementFactory.make("capsfilter", "caps")
        caps.set_property(
            "caps", Gst.Caps.from_string("video/x-h264,stream-format=avc,alignment=au")
        )
        sink = Gst.ElementFactory.make("splitmuxsink", "sink")

        for element, name in ((parse, "h264parse"), (caps, "capsfilter"), (sink, "splitmuxsink")):
            if element is None:
                raise RuntimeError(
                    f"GStreamer element {name!r} is unavailable. On JetPack install: "
                    f"gstreamer1.0-plugins-good gstreamer1.0-plugins-bad"
                )

        sink.set_property("max-size-time", int(self.cfg.segment_seconds) * NS_PER_S)
        if self.cfg.max_size_bytes:
            sink.set_property("max-size-bytes", self.cfg.max_size_bytes)
        sink.set_property("location", str(self.video_root / "unused-%05d.mp4"))

        if self.cfg.fragmented_mp4:
            # Fragmented MP4 so a segment cut short by an unclean unplug still plays
            # up to the cut instead of being a headless file with no moov atom.
            # muxer-factory/muxer-properties are only honoured when async-finalize=True.
            sink.set_property("async-finalize", True)
            sink.set_property("muxer-factory", "mp4mux")
            sink.set_property(
                "muxer-properties",
                _structure_from_string("properties,fragment-duration=1000"),
            )

        sink.connect("format-location-full", self._on_format_location)

        pipeline.add(parse)
        pipeline.add(caps)
        pipeline.add(sink)
        parse.link(caps)
        caps.link(sink)

        if depay is not None:
            depay.link(parse)
            target = depay
        else:
            target = parse

        dynamic_src.connect("pad-added", self._on_pad_added, target)

        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_bus_message)
        return pipeline

    def _on_pad_added(self, _element, pad: Gst.Pad, target: Gst.Element) -> None:
        """rtspsrc/qtdemux expose pads only once the stream is described."""
        caps = pad.get_current_caps() or pad.query_caps(None)
        name = caps.to_string()
        is_video_h264 = (
            "encoding-name=(string)H264" in name or name.startswith("video/x-h264")
        )
        if not is_video_h264:
            log.debug("ignoring non-H.264 pad: %s", name.split(",")[0])
            return
        sink_pad = target.get_static_pad("sink")
        if sink_pad.is_linked():
            return
        if pad.link(sink_pad) != Gst.PadLinkReturn.OK:
            log.error("failed to link source pad to %s", target.get_name())

    # ----------------------------------------------------------------- callbacks

    def _on_format_location(self, _sink, fragment_id: int, _first_sample) -> str:
        """Choose the path for the fragment about to be opened."""
        now = datetime.now(timezone.utc)
        day_dir = self.video_root / self.camera.camera_id / now.strftime("%Y-%m-%d")
        day_dir.mkdir(parents=True, exist_ok=True)
        path = day_dir / f"{self.camera.camera_id}_{_fmt_ts(now)}.mp4"
        log.info("opening fragment %d -> %s", fragment_id, path.name)
        return str(path)

    def _on_bus_message(self, _bus, message: Gst.Message) -> None:
        t = message.type
        if t == Gst.MessageType.ELEMENT:
            self._on_element_message(message)
        elif t == Gst.MessageType.EOS:
            log.info("EOS received")
            # a test file ending is the end of the run, not a dropped stream to reopen
            if self.shutting_down or self.test_file:
                self.loop.quit()
            else:
                self._schedule_restart("stream ended")
        elif t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            log.error("pipeline error: %s (%s)", err.message, debug)
            if self.test_file:
                self.exit_code = 1
                self.loop.quit()
            else:
                self._schedule_restart(err.message)
        elif t == Gst.MessageType.WARNING:
            warn, _ = message.parse_warning()
            log.warning("pipeline warning: %s", warn.message)

    def _on_element_message(self, message: Gst.Message) -> None:
        structure = message.get_structure()
        if structure is None:
            return
        name = structure.get_name()
        if name == "splitmuxsink-fragment-opened":
            self._fragment_opened(structure)
        elif name == "splitmuxsink-fragment-closed":
            self._fragment_closed(structure)

    def _running_to_utc(self, running_ns: int) -> datetime:
        """Map pipeline running-time onto global wall clock.

        Anchored once per session on the first fragment, rather than reading the
        clock at message-delivery time -- that keeps consecutive segments exactly
        contiguous instead of accumulating bus-latency jitter at every boundary.
        """
        if self.epoch_utc is None:
            self.epoch_utc = datetime.now(timezone.utc) - timedelta(
                seconds=running_ns / NS_PER_S
            )
        return self.epoch_utc + timedelta(seconds=running_ns / NS_PER_S)

    def _fragment_opened(self, structure: Gst.Structure) -> None:
        location = structure.get_string("location")
        running_ns = structure.get_uint64("running-time")[1]
        self.open_fragments[location] = {
            "start_running_ns": running_ns,
            "start_utc": self._running_to_utc(running_ns),
        }
        self.backoff_s = 1.0  # data is flowing again

    def _fragment_closed(self, structure: Gst.Structure) -> None:
        location = structure.get_string("location")
        running_ns = structure.get_uint64("running-time")[1]
        opened = self.open_fragments.pop(location, None)
        path = Path(location)

        if opened is None:
            log.warning("fragment closed without a matching open: %s", path.name)
            return
        if not path.exists():
            log.error("fragment closed but file is missing: %s", location)
            return

        end_utc = self._running_to_utc(running_ns)
        size = path.stat().st_size
        try:
            rel = str(path.relative_to(self.gatf_root))
        except ValueError:
            rel = str(path)

        index_db.insert_segment(
            self.conn,
            {
                "filename": rel,
                "camera_id": self.camera.camera_id,
                "session_id": self.session_id,
                "drive_uuid": self.cfg.drive_uuid,
                "start_utc": opened["start_utc"].isoformat(),
                "end_utc": end_utc.isoformat(),
                "duration_s": (running_ns - opened["start_running_ns"]) / NS_PER_S,
                "start_running_ns": opened["start_running_ns"],
                "end_running_ns": running_ns,
                "size_bytes": size,
                "fragment_id": self.segments_written,
                "complete": 1,
            },
        )
        self.segments_written += 1
        self.bytes_written += size
        log.info(
            "segment %d closed: %s (%.1fs, %.1f MB)",
            self.segments_written, path.name,
            (running_ns - opened["start_running_ns"]) / NS_PER_S, size / 1e6,
        )
        self._enforce_retention()

    # ----------------------------------------------------------------- retention

    def _enforce_retention(self) -> None:
        if not enforce_retention(self.cfg, self.gatf_root, self.conn):
            self.request_stop()

    # ------------------------------------------------------------------- control

    def _schedule_restart(self, reason: str) -> None:
        if self.shutting_down:
            return
        delay = self.backoff_s
        log.warning("reconnecting in %.0fs after: %s", delay, reason)
        self._teardown_pipeline()
        self.backoff_s = min(self.backoff_s * 2, self.cfg.reconnect_max_backoff_s)
        GLib.timeout_add_seconds(int(delay), self._restart)

    def _restart(self) -> bool:
        if self.shutting_down:
            return False
        try:
            self._start_pipeline()
        except Exception as exc:  # noqa: BLE001 - must never kill the recorder
            log.error("restart failed: %s", exc)
            self._schedule_restart("restart failed")
        return False  # one-shot timeout

    def _teardown_pipeline(self) -> None:
        if self.pipeline is not None:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
        if self.session_id:
            index_db.end_session(self.conn, self.session_id)
        self.epoch_utc = None
        self.open_fragments.clear()

    def _start_pipeline(self) -> None:
        # A fresh session row per connection attempt, so gaps caused by camera
        # reboots or network drops stay visible in the index instead of being
        # papered over into one continuous-looking run.
        self.session_id = str(uuid.uuid4())
        index_db.start_session(
            self.conn,
            session_id=self.session_id,
            camera_id=self.camera.camera_id,
            rtsp_redacted=str(self.test_file) if self.test_file else self.camera.rtsp_redacted,
            clock_source="rtcp-ntp" if (self.cfg.ntp_sync and not self.test_file) else "pipeline",
            gst_version=Gst.version_string(),
        )
        self.pipeline = self._build_pipeline()
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("pipeline failed to enter PLAYING")
        log.info(
            "recording %s -> %s (%ds segments)",
            self.camera.rtsp_redacted if not self.test_file else self.test_file.name,
            self.video_root / self.camera.camera_id,
            self.cfg.segment_seconds,
        )

    def request_stop(self) -> bool:
        """Graceful stop: send EOS so mp4mux writes the final moov atom.

        Killing the process instead truncates the in-flight segment, so this path
        matters -- it is what eject.sh relies on.
        """
        if self.shutting_down:
            return False
        self.shutting_down = True
        log.info("stopping: sending EOS and waiting for the final segment to close")
        if self.pipeline is not None:
            self.pipeline.send_event(Gst.Event.new_eos())
            GLib.timeout_add_seconds(15, self._force_quit)
        else:
            self.loop.quit()
        return False

    def _force_quit(self) -> bool:
        log.warning("EOS timed out; forcing shutdown (last segment may be truncated)")
        self.loop.quit()
        return False

    def run(self) -> int:
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                GLib.unix_signal_add(GLib.PRIORITY_HIGH, sig, self.request_stop)
            except AttributeError:  # non-unix GLib build
                signal.signal(sig, lambda *_: GLib.idle_add(self.request_stop))

        if self.duration_s:
            GLib.timeout_add_seconds(int(self.duration_s), self.request_stop)

        self._start_pipeline()
        try:
            self.loop.run()
        finally:
            self._teardown_pipeline()
            index_db.export_csv(self.conn, drive_mod.csv_path(self.gatf_root))
            status = index_db.checkpoint(self.conn)
            log.info(
                "stopped: %d segments, %.2f GB, integrity_check=%s",
                self.segments_written, self.bytes_written / 1e9, status,
            )
        return self.exit_code


# --------------------------------------------------------------------------- CLI


def _setup_logging(log_path: Path | None, verbose: bool) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_path))
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        handlers=handlers,
    )


def _resolve_root(args, cfg: config_mod.RecorderConfig) -> tuple[Path, Path]:
    """Resolve the drive by UUID, or use a plain directory in test mode."""
    if args.test_drive_root:
        mount = Path(args.test_drive_root)
        gatf = drive_mod.init_drive(mount, cfg.drive_uuid, label="test")
        return mount, gatf
    return drive_mod.resolve(cfg.drive_uuid)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--camera", help="camera_id from the config")
    parser.add_argument("--segment-seconds", type=int, help="override config")
    parser.add_argument("--duration", type=float, help="stop after N seconds (test runs)")
    parser.add_argument("--test-file", type=Path, help="record from a local mp4 instead of RTSP")
    parser.add_argument("--test-drive-root", help="use this directory instead of resolving the UUID")
    parser.add_argument("--init-drive", action="store_true", help="create the tree + manifest, then exit")
    parser.add_argument("--label", default="", help="drive label, used with --init-drive")
    parser.add_argument("--reconcile", action="store_true", help="rebuild the index from disk, then exit")
    parser.add_argument("--export-csv", action="store_true", help="refresh segments.csv, then exit")
    parser.add_argument("--status", action="store_true", help="print index summary, then exit")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    # only recording opens a stream (credentials resolved below, for that camera only)
    cfg = config_mod.load(args.config, credentials=False)
    if args.segment_seconds:
        cfg.segment_seconds = args.segment_seconds

    # --init-drive is the one path that must not verify the manifest (it creates it).
    if args.init_drive:
        _setup_logging(None, args.verbose)
        mount = (
            Path(args.test_drive_root)
            if args.test_drive_root
            else drive_mod.mountpoint_for_uuid(cfg.drive_uuid)
        )
        gatf = drive_mod.init_drive(mount, cfg.drive_uuid, args.label)
        conn = index_db.connect(drive_mod.db_path(gatf))
        index_db.register_drive(
            conn, cfg.drive_uuid, args.label, drive_mod.fstype_at_path(mount)
        )
        conn.close()
        print(f"Initialised {gatf}")
        print(f"  free space: {drive_mod.free_bytes(mount) / 1e9:.1f} GB")
        return 0

    mount, gatf = _resolve_root(args, cfg)
    conn = index_db.connect(drive_mod.db_path(gatf))

    if args.reconcile:
        _setup_logging(None, args.verbose)
        result = index_db.reconcile(conn, drive_mod.video_root(gatf), gatf, cfg.drive_uuid)
        index_db.export_csv(conn, drive_mod.csv_path(gatf))
        print(f"reconcile: {result}")
        print(f"integrity_check: {index_db.checkpoint(conn)}")
        return 0

    if args.export_csv:
        count = index_db.export_csv(conn, drive_mod.csv_path(gatf))
        print(f"wrote {count} rows to {drive_mod.csv_path(gatf)}")
        return 0

    if args.status:
        row = conn.execute(
            "SELECT count(*) n, min(start_utc) first, max(end_utc) last,"
            " round(sum(size_bytes)/1e9, 2) gb FROM segments WHERE deleted_utc IS NULL"
        ).fetchone()
        print(f"drive        {mount} ({cfg.drive_uuid})")
        print(f"segments     {row['n']}  ({row['gb'] or 0} GB)")
        print(f"covering     {row['first']} .. {row['last']}")
        print(f"free space   {drive_mod.free_bytes(mount) / 1e9:.1f} GB")
        return 0

    if not args.camera:
        parser.error("--camera is required (or use --init-drive/--reconcile/--export-csv/--status)")

    camera = cfg.camera(args.camera)
    if not args.test_file:
        config_mod.with_credentials(camera)
    _setup_logging(
        drive_mod.log_dir(gatf) / f"recorder-{camera.camera_id}.log", args.verbose
    )
    index_db.register_drive(conn, cfg.drive_uuid, args.label, drive_mod.fstype_at_path(mount))

    # PID file so eject.sh can stop us gracefully rather than yanking a live writer.
    pid_file = drive_mod.log_dir(gatf) / PID_FILENAME.format(camera_id=camera.camera_id)
    pid_file.write_text(str(os.getpid()))

    recorder = SegmentRecorder(
        cfg=cfg,
        camera=camera,
        gatf_root=gatf,
        conn=conn,
        test_file=args.test_file,
        duration_s=args.duration,
    )
    try:
        return recorder.run()
    finally:
        pid_file.unlink(missing_ok=True)
        conn.close()


if __name__ == "__main__":
    # Config/drive/GStreamer problems are operator errors, not crashes — the message
    # is the useful part, so print it plainly instead of a traceback.
    try:
        sys.exit(main())
    except (config_mod.ConfigError, drive_mod.DriveError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
