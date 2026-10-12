"""Pre-flight checks before committing to a long recording session.

Catches the failure modes that only show up hours later otherwise:
  * a GStreamer plugin missing from the JetPack image
  * the drive not attached, not mounted, or not the drive you think it is
  * not enough free space for the session you are about to start
  * a camera GOP longer than segment_seconds

The last one is the subtle one. splitmuxsink can only cut on an IDR frame, so if the
camera emits keyframes every 60s and you asked for 10s segments, you silently get
60s segments. Fix it on the camera side (Axis: `?videokeyframeinterval=N`, or
Stream profile settings) rather than in the pipeline.

Usage:
    python -m scripts.video.preflight --camera gatf-lot-01
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from . import config as config_mod
from . import drive as drive_mod

REQUIRED_ELEMENTS = ["rtspsrc", "rtph264depay", "h264parse", "mp4mux", "splitmuxsink", "qtdemux"]

OK, WARN, FAIL = "  OK  ", " WARN ", " FAIL "


class Report:
    def __init__(self) -> None:
        self.failed = False
        self.warned = False

    def line(self, status: str, label: str, detail: str = "") -> None:
        if status == FAIL:
            self.failed = True
        elif status == WARN:
            self.warned = True
        print(f"[{status}] {label:<28} {detail}")


def check_tooling(report: Report) -> None:
    if shutil.which("gst-inspect-1.0") is None:
        report.line(FAIL, "gst-inspect-1.0", "not found — apt install gstreamer1.0-tools")
        missing = []
    else:
        missing = [
        name
            for name in REQUIRED_ELEMENTS
            if subprocess.run(
                ["gst-inspect-1.0", name], capture_output=True, timeout=30
            ).returncode != 0
        ]
    if missing:
        report.line(
            FAIL, "gstreamer elements",
            f"missing: {', '.join(missing)} — apt install gstreamer1.0-plugins-good "
            f"gstreamer1.0-plugins-bad",
        )
    elif shutil.which("gst-inspect-1.0"):
        report.line(OK, "gstreamer elements", f"all {len(REQUIRED_ELEMENTS)} present")

    try:
        import gi  # noqa: F401

        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)
        report.line(OK, "python gstreamer bindings", Gst.version_string())
    except Exception as exc:  # noqa: BLE001
        report.line(FAIL, "python gstreamer bindings", f"{exc} — apt install python3-gi")

    if shutil.which("ffprobe") is None:
        report.line(WARN, "ffprobe", "not found — stream probing and reconcile() degrade")
    else:
        report.line(OK, "ffprobe", shutil.which("ffprobe"))


def check_drive(report: Report, cfg: config_mod.RecorderConfig) -> Path | None:
    try:
        mount, gatf = drive_mod.resolve(cfg.drive_uuid)
    except drive_mod.DriveError as exc:
        report.line(FAIL, "drive", str(exc))
        return None

    report.line(OK, "drive", f"{mount} (uuid {cfg.drive_uuid})")
    fstype = drive_mod.fstype_at_path(mount)
    if fstype.lower() in ("exfat", "vfat", "msdos"):
        report.line(
            WARN, "filesystem", f"{fstype} has no journal — an unclean unplug is more "
            f"damaging. ext4 is preferable if the drive only ever mounts on the Orin.",
        )
    else:
        report.line(OK, "filesystem", fstype or "unknown")

    probe = gatf / ".write-test"
    try:
        probe.write_text("ok")
        probe.unlink()
        report.line(OK, "writable", str(gatf))
    except OSError as exc:
        report.line(FAIL, "writable", f"{gatf}: {exc}")

    free_gb = drive_mod.free_bytes(mount) / 1e9
    status = FAIL if free_gb < cfg.min_free_gb else OK
    report.line(status, "free space", f"{free_gb:.1f} GB (min_free_gb={cfg.min_free_gb})")
    return gatf


def _ffprobe_stream(url: str) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-rtsp_transport", "tcp",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,bit_rate",
            "-of", "default=nw=1", url,
        ],
        capture_output=True, text=True, timeout=45,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "failed")
    return dict(
        line.split("=", 1) for line in out.stdout.strip().splitlines() if "=" in line
    )


def _measure_gop(url: str, seconds: int = 20) -> tuple[float | None, int]:
    """Return (max interval between IDR frames in seconds, keyframes seen)."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-rtsp_transport", "tcp",
            "-select_streams", "v:0", "-read_intervals", f"%+{seconds}",
            "-show_entries", "frame=key_frame,pts_time",
            "-of", "csv=p=0", url,
        ],
        capture_output=True, text=True, timeout=seconds + 45,
    )
    key_times: list[float] = []
    for line in out.stdout.strip().splitlines():
        parts = line.split(",")
        if len(parts) < 2 or parts[0].strip() != "1":
            continue
        try:
            key_times.append(float(parts[1]))
        except ValueError:
            continue
    if len(key_times) < 2:
        return None, len(key_times)
    gaps = [b - a for a, b in zip(key_times, key_times[1:])]
    return max(gaps), len(key_times)


def check_camera(report: Report, cfg: config_mod.RecorderConfig, camera: config_mod.Camera) -> None:
    report.line(OK, "camera", f"{camera.camera_id} -> {camera.rtsp_redacted}")
    if shutil.which("ffprobe") is None:
        report.line(WARN, "stream probe", "skipped (no ffprobe)")
        return

    try:
        info = _ffprobe_stream(camera.rtsp_url)
    except Exception as exc:  # noqa: BLE001
        report.line(FAIL, "stream probe", f"could not open stream: {exc}")
        return

    codec = info.get("codec_name", "?")
    status = OK if codec == "h264" else FAIL
    report.line(
        status, "codec",
        f"{codec} {info.get('profile', '')} — the pipeline remuxes H.264 only "
        f"(no encoder on the Orin Nano)" if codec != "h264" else f"{codec} {info.get('profile','')}",
    )
    report.line(
        OK, "resolution / fps",
        f"{info.get('width','?')}x{info.get('height','?')} @ {info.get('r_frame_rate','?')}",
    )

    bitrate = info.get("bit_rate")
    if bitrate and bitrate.isdigit():
        gb_per_hour = int(bitrate) * 3600 / 8 / 1e9
        report.line(OK, "estimated rate", f"{gb_per_hour:.2f} GB/hour")

    gop_s, keyframes = _measure_gop(camera.rtsp_url)
    if gop_s is None:
        report.line(
            WARN, "keyframe interval",
            f"only {keyframes} keyframe(s) seen in the probe window — GOP may exceed 20s",
        )
    elif gop_s > cfg.segment_seconds:
        report.line(
            FAIL, "keyframe interval",
            f"{gop_s:.1f}s > segment_seconds={cfg.segment_seconds}. splitmuxsink can only "
            f"cut on a keyframe, so segments will overrun. Shorten the camera GOP "
            f"(Axis: ?videokeyframeinterval=N) or raise segment_seconds.",
        )
    else:
        report.line(
            OK, "keyframe interval",
            f"{gop_s:.1f}s (segments will land within {gop_s:.1f}s of "
            f"{cfg.segment_seconds}s)",
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--camera", help="camera_id to probe; omit to check tooling + drive only")
    parser.add_argument("--config", type=Path, default=None)
    args = parser.parse_args(argv)

    report = Report()
    cfg = config_mod.load(args.config)

    print("── tooling ─────────────────────────────────────────────")
    check_tooling(report)
    print("── drive ───────────────────────────────────────────────")
    check_drive(report, cfg)
    if args.camera:
        print("── camera ──────────────────────────────────────────────")
        check_camera(report, cfg, cfg.camera(args.camera))

    print()
    if report.failed:
        print("PREFLIGHT FAILED — fix the items above before recording.")
        return 1
    print("PREFLIGHT PASSED" + (" (with warnings)" if report.warned else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
