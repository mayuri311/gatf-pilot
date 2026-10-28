"""
Unit tests for the on-device pieces around the plate reader: the clipper
(event -> verification clip), the spool uploader and sysmetrics' parsers.

No camera, GStreamer or Supabase needed; the one real-ffmpeg test skips itself
when ffmpeg isn't installed. Run from the repo root:
    .venv/bin/python -m pytest scripts/tests -q
"""

import json
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone

import pytest

from scripts import spool_uploader as su
from scripts import sysmetrics
from scripts.contract_v2 import UPLOADED_MARKER
from scripts.video import clipper, index_db

T0 = datetime(2026, 10, 24, 20, 0, 0, tzinfo=timezone.utc)
CAM = "inbound_cam_01"


def make_event(root, camera_dir, name, first, last, camera_id=CAM):
    d = root / camera_dir / name
    d.mkdir(parents=True)
    (d / "event.json").write_text(json.dumps({
        "camera_id": camera_id, "event_id": name,
        "captured_at_utc": first.isoformat(),
        "first_seen_utc": first.isoformat(), "last_seen_utc": last.isoformat(),
    }))
    return d


def add_segments(gatf, start, count, seconds=10, camera_id=CAM):
    conn = index_db.connect(gatf / "index" / "segments.db")
    for i in range(count):
        s = start + timedelta(seconds=i * seconds)
        index_db.insert_segment(conn, {
            "filename": f"video/{camera_id}/seg{i:03d}.mp4", "camera_id": camera_id,
            "session_id": "s1", "drive_uuid": "u", "start_utc": s.isoformat(),
            "end_utc": (s + timedelta(seconds=seconds)).isoformat(), "duration_s": seconds,
            "start_running_ns": 0, "end_running_ns": 0, "size_bytes": 1_000_000,
            "fragment_id": i, "complete": 1,
        })
    conn.close()


# --- clipper ------------------------------------------------------------------

def test_event_window_pads_first_and_last_sighting():
    start, end = clipper.event_window(
        {"first_seen_utc": T0.isoformat(), "last_seen_utc": (T0 + timedelta(seconds=4)).isoformat()},
        10, 10)
    assert start == T0 - timedelta(seconds=10)
    assert end == T0 + timedelta(seconds=14)


def test_event_window_falls_back_to_capture_time():
    start, end = clipper.event_window({"captured_at_utc": "2026-10-24T20:00:00Z"}, 5, 5)
    assert (end - start).total_seconds() == 10


def test_pending_events_skips_clipped(tmp_path):
    root = tmp_path / "events"
    a = make_event(root, CAM, "a", T0, T0)
    b = make_event(root, f"{CAM}_rejected", "b", T0, T0)
    (a / clipper.CLIP_MARKER).write_text("{}")
    assert clipper.pending_events(root) == [b]


def test_overlap_and_coverage(tmp_path):
    gatf = tmp_path / "gatf"
    add_segments(gatf, T0, 6)  # T0 .. T0+60 s
    conn = clipper.connect_ro(gatf / "index" / "segments.db")
    segs = clipper.overlapping_segments(conn, CAM, T0 + timedelta(seconds=15), T0 + timedelta(seconds=35))
    assert [s["filename"][-10:] for s in segs] == ["seg001.mp4", "seg002.mp4", "seg003.mp4"]
    assert clipper.covered_seconds(segs, T0 + timedelta(seconds=15), T0 + timedelta(seconds=35)) == 20
    assert clipper.overlapping_segments(conn, "outbound_cam_01", T0, T0 + timedelta(seconds=60)) == []
    conn.close()


def test_process_event_waits_for_post_roll(tmp_path):
    gatf = tmp_path / "gatf"
    add_segments(gatf, T0, 2)  # footage ends at T0+20, window ends at T0+40
    ev = make_event(gatf / "events", CAM, "e1", T0 + timedelta(seconds=25), T0 + timedelta(seconds=30))
    conn = clipper.connect_ro(gatf / "index" / "segments.db")
    now = T0 + timedelta(seconds=45)
    assert clipper.process_event(gatf, conn, ev, 10, 10, 90, now=now) == "waiting"
    assert not (ev / clipper.CLIP_MARKER).exists()
    conn.close()


def test_process_event_no_footage_after_timeout(tmp_path):
    gatf = tmp_path / "gatf"
    add_segments(gatf, T0, 2)
    ev = make_event(gatf / "events", CAM, "e1", T0 + timedelta(hours=1), T0 + timedelta(hours=1))
    conn = clipper.connect_ro(gatf / "index" / "segments.db")
    now = T0 + timedelta(hours=2)
    assert clipper.process_event(gatf, conn, ev, 10, 10, 90, now=now) == "no_footage"
    marker = json.loads((ev / clipper.CLIP_MARKER).read_text())
    assert marker["status"] == "no_footage" and marker["clip_path"] is None
    conn.close()


def _gst_ok(*elements):
    if shutil.which("gst-launch-1.0") is None:
        return False
    return all(subprocess.run(["gst-inspect-1.0", e], capture_output=True).returncode == 0
               for e in elements)


def _probe_h264(path):
    """(frames, starts_on_keyframe, span_s) by demuxing only - no decoder, since
    JetPack's ffprobe can't read stream info without its (absent) CUDA decoder."""
    gi = pytest.importorskip("gi")
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
    Gst.init(None)
    pipe = Gst.parse_launch(f'filesrc location="{path}" ! qtdemux ! h264parse ! '
                            "appsink name=s sync=false")
    sink = pipe.get_by_name("s")
    pipe.set_state(Gst.State.PLAYING)
    pts, first_key = [], None
    while (sample := sink.emit("pull-sample")) is not None:
        buf = sample.get_buffer()
        if first_key is None:
            first_key = not buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
        pts.append(buf.pts)
    pipe.set_state(Gst.State.NULL)
    return len(pts), first_key, (pts[-1] - pts[0]) / 1e9


@pytest.mark.skipif(shutil.which("ffmpeg") is None or not _gst_ok("x264enc", "concat", "qtdemux"),
                    reason="needs ffmpeg + GStreamer x264enc/concat/qtdemux")
def test_process_event_cuts_real_clip(tmp_path):
    gatf = tmp_path / "gatf"
    seg_dir = gatf / "video" / CAM
    seg_dir.mkdir(parents=True)
    # three 4 s H.264 segments (4:2:0 like the Axis stream), keyframe every second
    for i in range(3):
        subprocess.run(["gst-launch-1.0", "-q", "videotestsrc", "num-buffers=40", "!",
                        "video/x-raw,format=I420,width=320,height=240,framerate=10/1", "!",
                        "x264enc", "key-int-max=10", "speed-preset=ultrafast", "!",
                        "h264parse", "!", "mp4mux", "!", "filesink",
                        f"location={seg_dir / f'seg{i:03d}.mp4'}"], check=True)
    add_segments(gatf, T0, 3, seconds=4)
    ev = make_event(gatf / "events", CAM, "e1", T0 + timedelta(seconds=5), T0 + timedelta(seconds=6))
    conn = clipper.connect_ro(gatf / "index" / "segments.db")
    result = clipper.process_event(gatf, conn, ev, 2, 2, 90, now=T0 + timedelta(seconds=60))
    conn.close()
    assert result == "clipped"
    marker = json.loads((ev / clipper.CLIP_MARKER).read_text())
    clip = gatf / marker["clip_path"]
    # window T0+3 .. T0+8 spans the first two 4 s segments
    assert clip.exists() and marker["segments"] == ["video/inbound_cam_01/seg000.mp4",
                                                     "video/inbound_cam_01/seg001.mp4"]
    assert not list(clip.parent.glob("*.part.mp4")) and not list(clip.parent.glob("*.join.mp4"))
    frames, starts_on_key, span = _probe_h264(clip)
    assert starts_on_key
    assert 45 <= frames <= 51 and 4.4 <= span <= 5.0   # 5 s window at 10 fps, keyframe-snapped


# --- spool uploader -------------------------------------------------------------

def test_pending_folders_oldest_first_and_no_rejected(tmp_path):
    make_event(tmp_path, CAM, "20261024T200002Z_plate_track2", T0, T0)
    make_event(tmp_path, "outbound_cam_01", "20261024T200001Z_plate_track1", T0, T0)
    make_event(tmp_path, f"{CAM}_rejected", "20261024T200000Z_plate_track0", T0, T0)
    done = make_event(tmp_path, CAM, "20261024T195959Z_plate_track9", T0, T0)
    (done / UPLOADED_MARKER).touch()
    assert [d.name for d in su.pending_folders(tmp_path)] == [
        "20261024T200001Z_plate_track1", "20261024T200002Z_plate_track2"]


def _uploader(tmp_path, upload_fn, busy=False):
    return su.SpoolUploader(tmp_path / "events", tmp_path / "state", upload_fn=upload_fn,
                            busy_fn=lambda: (busy, 99.0 if busy else 10.0), sleep=lambda s: None)


def test_uploader_drains_and_marks(tmp_path):
    for i in range(3):
        make_event(tmp_path / "events", CAM, f"e{i}", T0, T0)
    seen = []

    def upload(d):
        seen.append(d.name)
        (d / UPLOADED_MARKER).touch()
        return True
    up = _uploader(tmp_path, upload)
    assert up.run_once() is True
    assert seen == ["e0", "e1", "e2"]
    state = json.loads((tmp_path / "state" / "uploader.json").read_text())
    assert state["backlog"] == 0 and state["uploaded"] == 3 and state["bytes_sent"] > 0


def test_uploader_yields_to_busy_cpu(tmp_path):
    make_event(tmp_path / "events", CAM, "e0", T0, T0)
    up = _uploader(tmp_path, lambda d: pytest.fail("must not upload while busy"), busy=True)
    assert up.run_once() is False
    state = json.loads((tmp_path / "state" / "uploader.json").read_text())
    assert state["gated"] is True and state["backlog"] == 1


def test_uploader_backs_off_on_network_error(tmp_path):
    make_event(tmp_path / "events", CAM, "e0", T0, T0)

    def boom(d):
        raise ConnectionError("no route to host")
    up = _uploader(tmp_path, boom)
    assert up.run_once() is False
    assert up.backoff_s == su.BACKOFF_MIN_S
    up.run_once()
    assert up.backoff_s == su.BACKOFF_MIN_S * 2
    state = json.loads((tmp_path / "state" / "uploader.json").read_text())
    assert "no route to host" in state["last_error"] and state["backlog"] == 1


def test_uploader_remembers_skipped_folders(tmp_path):
    make_event(tmp_path / "events", CAM, "legacy", T0, T0)
    calls = []
    up = _uploader(tmp_path, lambda d: calls.append(d) or False)  # declined, no marker
    up.run_once()
    up.run_once()
    assert len(calls) == 1


# --- sysmetrics -------------------------------------------------------------------

TEGRA_LINE = ("10-24-2026 16:03:33 RAM 6028/7485MB (lfb 4x4MB) CPU [10%@729,3%@729] "
              "GR3D_FREQ 48% cpu@48.375C/48.375C gpu@49.937C/49.937C tj@49.937C/49.937C "
              "VDD_IN 4999mW/4999mW/4999mW VDD_CPU_GPU_CV 713mW/713mW/713mW")


def test_parse_tegrastats():
    out = sysmetrics.parse_tegrastats(TEGRA_LINE)
    assert out["gpu_pct"] == 48.0
    assert out["power_w"] == 5.0
    assert out["temps"] == {"cpu": 48.375, "gpu": 49.937, "tj": 49.937}
    assert sysmetrics.parse_tegrastats("garbage") == {}


def test_camera_bitrates(tmp_path):
    gatf = tmp_path / "gatf"
    add_segments(gatf, T0, 6)                      # 1 MB per 10 s = 0.8 Mbps
    add_segments(gatf, T0 - timedelta(hours=1), 1, camera_id="outbound_cam_01")
    rates = sysmetrics.camera_bitrates(gatf / "index" / "segments.db",
                                       now=T0 + timedelta(seconds=60))
    assert rates[CAM]["mbps"] == 0.8
    assert rates["outbound_cam_01"]["mbps"] is None   # nothing closed recently
    assert sysmetrics.camera_bitrates(tmp_path / "missing.db") == {}


# --- plate reader: newest-frame grabber ---------------------------------------------

class FakeCapture:
    """A 'stream' delivering one frame (its sequence number) every `period` s."""

    def __init__(self, period=0.01, fail_after=None, stall=False):
        import threading as _t
        self.period, self.fail_after, self.stall = period, fail_after, stall
        self.seq, self.retrieved = 0, 0
        self._block = _t.Event()

    def grab(self):
        if self.stall:
            self._block.wait(2)
            return False
        time.sleep(self.period)
        self.seq += 1
        return self.fail_after is None or self.seq <= self.fail_after

    def retrieve(self):
        self.retrieved += 1
        return True, self.seq


def _reader_module():
    pytest.importorskip("cv2")
    pytest.importorskip("fast_alpr")
    from scripts import plate_ocr_reader
    return plate_ocr_reader


def test_grabber_hands_out_fresh_frames_and_skips_stale():
    por = _reader_module()
    cap = FakeCapture(period=0.01)
    grabber = por.LatestFrameGrabber(cap)
    seen = []
    for _ in range(5):
        ok, frame, grabbed_at = grabber.read(timeout=2)
        assert ok and grabbed_at is not None
        seen.append(frame)
        time.sleep(0.1)          # a slow detector: ~10 frames arrive meanwhile
    assert grabber.stop()
    assert seen == sorted(seen) and seen[-1] - seen[0] >= 30   # kept up with the stream
    assert grabber.skipped >= 30                                 # stale frames dropped...
    assert cap.retrieved <= 6                                    # ...without decoding them


def test_grabber_reports_failure_and_stall():
    por = _reader_module()
    grabber = por.LatestFrameGrabber(FakeCapture(period=0.001, fail_after=0))
    assert grabber.read(timeout=2)[0] is False
    grabber.stop()
    stalled = por.LatestFrameGrabber(FakeCapture(stall=True))
    t0 = time.time()
    assert stalled.read(timeout=0.3)[0] is False
    assert time.time() - t0 < 1.5


# --- TensorRT detector backend ------------------------------------------------------

def test_tensorrt_detector_matches_cpu():
    """GPU (TensorRT FP16) detections must match the CPU ones on real footage.
    Needs TensorRT, a prebuilt engine (scripts/trt_backend.py --build) and a
    recorded segment on the SSD - skipped otherwise (never builds in a test)."""
    pytest.importorskip("tensorrt")
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("fast_alpr")
    import glob
    from scripts import trt_backend
    from scripts.plate_ocr_reader import ort_session_options
    from fast_alpr import ALPR
    segs = sorted(glob.glob("/mnt/validation/gatf/video/*/*/*.mp4"))
    if not segs:
        pytest.skip("no recorded footage on the SSD")
    alpr = ALPR(detector_model="yolo-v9-t-384-license-plate-end2end", ocr_model="cct-xs-v2-global-model",
                detector_providers=["CPUExecutionProvider"], detector_sess_options=ort_session_options(2),
                ocr_providers=["CPUExecutionProvider"])
    det_onnx, _ = trt_backend.model_paths(alpr)
    engine = trt_backend.engine_path(det_onnx)
    if not engine.exists():
        pytest.skip("TensorRT engine not built (scripts/trt_backend.py --build)")
    frames = []
    for seg in segs[-6:]:
        cap = cv2.VideoCapture(seg)
        ok, frame = cap.read()
        if ok:
            frames.append(frame)
    det = alpr.detector.detector
    cpu = [det.predict(f) for f in frames]
    det.model = trt_backend.TrtSession(engine)
    gpu = [det.predict(f) for f in frames]
    for a, b in zip(cpu, gpu):
        assert len(a) == len(b)
        for x, y in zip(a, b):
            bx, by = x.bounding_box, y.bounding_box
            assert max(abs(bx.x1 - by.x1), abs(bx.y1 - by.y1), abs(bx.x2 - by.x2), abs(bx.y2 - by.y2)) <= 2
