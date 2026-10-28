#!/usr/bin/env python3
"""
License plate localization + OCR only - no vehicle object detection.

Unlike yolo_plate_reader.py, this doesn't run a COCO YOLO model to find
vehicles first. fast-alpr's own YOLOv9 detector already localizes plates
directly in the full camera frame, so that two-stage vehicle-then-plate
approach isn't needed here:
    https://github.com/ankandrew/fast-alpr

The plate boxes ARE tracked, though - with the same ByteTrack algorithm
yolo_plate_reader.py used for vehicles (ultralytics' BYTETracker, used
directly here since fast-alpr's detector isn't an ultralytics YOLO model and
so has no built-in .track()). ByteTrack's Kalman filter predicts each
track's next position, which is what lets a track survive a frame or two of
missed/occluded detection instead of being treated as a new plate - a track
is only finalized once it's been un-matched for longer than the tracker's
track_buffer (default 30 frames).

A single physical plate is read many times while it crosses the frame, and
OCR flickers frame to frame (motion blur, angle, partial occlusion) - e.g.
"500X" -> "530X" -> "5513" -> "55J137" for the same plate over 4 consecutive
frames. So instead of writing an event per frame or per text change, reads
are buffered per track ID and only combined into one event once the track is
finalized (see best_reading()): reads are grouped by their most common
length (the strongest signal the plate was segmented correctly), then each
character position is decided by a confidence-weighted vote across that
group. This is the same idea OpenALPR calls "plate candidates" aggregation -
letting many partial/noisy reads outvote each other's mistakes instead of
trusting any single frame.

Each finalized track writes to events/<timestamp>_plate_track<id>/: an
event.json with the consensus reading, the full list of raw per-frame reads
(for validating the consensus logic itself), and plate.jpg - a crop of just
the plate region from the single frame whose read is closest to the
consensus (not the vehicle, not the full frame).

Producer v2 (plan/13-data-contracts.md): event.json follows event contract
v2 - schema_version 2, camera_id, device_id, and captured_at_utc (capture
time of the representative frame, which the backend uses as the event
time; timestamp_utc stays the finalize time). Live streams stamp each frame
with the wall-clock UTC time it was grabbed; a video file uses
--source-start-utc + frame_index / fps when given, else wall clock too.
Credentials are stripped from `source` before it's stored or logged. The
payload itself is built in contract_v2.py (pure, unit tested).

Accepted events are queued for real-time upload (supabase_sync.EventUploader,
a no-op without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY; upload_events.py is
the catch-up/retry path). Rejected tracks only ever go to rejected_dir and
are never uploaded. A heartbeat v1 is sent every config heartbeat.interval_s
(heartbeat.py) - to the report_heartbeat RPC, or to <events_dir>/../
heartbeats.jsonl when Supabase isn't configured. A live stream that drops is
reopened with backoff instead of ending the run, reported in the heartbeat
as "rtsp reconnecting".

Usage (from the repo root; camera_id/device_id must match config.yaml cameras[]):
    # Jetson at the entrance / exit (device_id comes from config.yaml)
    python scripts/plate_ocr_reader.py --camera-id inbound_cam_01 \\
        --source "rtsp://user:pass@192.168.1.64/axis-media/media.amp" --headless
    python scripts/plate_ocr_reader.py --camera-id outbound_cam_01 \\
        --source "rtsp://user:pass@192.168.1.65/axis-media/media.amp" --headless
    # replay a recording with its real capture times (20:57:19 EDT = 00:57:19Z)
    python scripts/plate_ocr_reader.py --camera-id inbound_cam_01 \\
        --source camera_captures/capture_20260813_205719.mp4 \\
        --source-start-utc 2026-08-14T00:57:19Z --no-upload
"""

import argparse
import json
import os
import signal
import sys
import threading
import time
import uuid
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from dotenv import load_dotenv
from fast_alpr import ALPR
from ultralytics.engine.results import Boxes
from ultralytics.trackers.byte_tracker import BYTETracker
from ultralytics.utils import YAML, IterableSimpleNamespace
from ultralytics.utils.checks import check_yaml

# make `scripts.*` importable both as `python scripts/plate_ocr_reader.py` and
# as `python -m scripts.plate_ocr_reader`
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.contract_v2 import (  # noqa: E402
    CLEAN_READ_RE, DEFAULT_CONFIG_PATH, build_event_payload, captured_at_for,
    config_cameras, heartbeat_interval_s, is_clean_read, is_live_source,
    load_config, normalize_read, parse_utc, redact_source, resolve_camera_id,
    resolve_device_id, utc_now,
)
from scripts.heartbeat import HeartbeatSender  # noqa: E402
from scripts.supabase_sync import EventUploader  # noqa: E402

load_dotenv()


# CLEAN_READ_RE / normalize_read / is_clean_read live in contract_v2.py now (the
# event payload's reads[].clean needs them without cv2); re-exported above.

DEFAULT_MIN_PLATE_CHARS = 5

# Live-stream reconnect backoff, seconds.
RECONNECT_MIN_S = 2
RECONNECT_MAX_S = 30

# A live stream that delivers no frame for this long is treated as dropped.
STALL_TIMEOUT_S = 15

# onnxruntime threads per session. Two readers on the Orin Nano's 6 cores with
# the default (all cores each) oversubscribe it: measured 2.8 fps per reader vs
# 6.5-7.0 fps with 2 threads each (1080p, detector + OCR, both cameras at once).
DEFAULT_ORT_THREADS = 2


def validate_plate(text, min_chars=DEFAULT_MIN_PLATE_CHARS):
    """Gate a track's consensus text. Returns (ok, reason).

    Deliberately has NO confidence floor: a borderline-but-plausible read is
    kept with its confidence recorded, so the dashboard can filter on it
    downstream. Dropping data at capture time is not recoverable; filtering at
    query time is.
    """
    t = normalize_read(text)
    if not t:
        return False, "no_readable_text"
    if not CLEAN_READ_RE.match(t):
        bad = "".join(sorted({c for c in t if not c.isalnum()}))
        return False, f"invalid_characters: {bad!r} in {t!r}"
    if len(t) < min_chars:
        return False, f"too_short: {t!r} ({len(t)} chars, minimum {min_chars})"
    return True, None


def get_plate_detections(alpr, frame):
    return alpr.predict(frame)


def build_tracker(tracker_yaml="scripts/bytetrack_plates.yaml"):
    cfg = IterableSimpleNamespace(**YAML.load(check_yaml(tracker_yaml)))
    return BYTETracker(cfg)


def detections_to_boxes(plate_results, frame_shape):
    """Wrap this frame's plate detections as an ultralytics Boxes object -
    the Results-like input BYTETracker expects. All plates share class 0
    since fast-alpr only ever detects one kind of object."""
    if not plate_results:
        arr = np.zeros((0, 6), dtype=np.float32)
    else:
        arr = np.array([
            [r.detection.bounding_box.x1, r.detection.bounding_box.y1,
             r.detection.bounding_box.x2, r.detection.bounding_box.y2,
             r.detection.confidence, 0.0]
            for r in plate_results
        ], dtype=np.float32)
    return Boxes(arr, frame_shape[:2])


def draw_plate_boxes(frame, plate_results, tracked_rows):
    track_id_by_idx = {int(row[7]): int(row[4]) for row in tracked_rows}
    for i, result in enumerate(plate_results):
        box = result.detection.bounding_box
        text = result.ocr.text if result.ocr else ""
        tid = track_id_by_idx.get(i)
        label = f"#{tid} {text}" if tid is not None else text
        cv2.rectangle(frame, (box.x1, box.y1), (box.x2, box.y2), (0, 255, 0), 2)
        cv2.putText(frame, label, (box.x1, box.y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)


def make_reading(frame, result, frame_index, captured_at_utc=None):
    box = result.detection.bounding_box
    x1, y1, x2, y2 = box.x1, box.y1, box.x2, box.y2
    crop = frame[max(y1, 0):y2, max(x1, 0):x2].copy()

    text, confidence, confidence_per_char = "", None, None
    if result.ocr:
        text = result.ocr.text
        ocr_conf = result.ocr.confidence
        if isinstance(ocr_conf, list):
            confidence_per_char = ocr_conf
            confidence = sum(ocr_conf) / len(ocr_conf) if ocr_conf else None
        else:
            confidence = ocr_conf

    return {
        "frame_index": frame_index,
        "text": text,
        "confidence": confidence,
        "confidence_per_char": confidence_per_char,
        "detection_confidence": result.detection.confidence,
        "bounding_box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        # when this frame was captured - becomes the event's captured_at_utc
        # if this read ends up as the track's representative
        "captured_at_utc": captured_at_utc,
        "crop": crop,
    }


def best_reading(readings):
    """Combine a track's buffered per-frame reads into one consensus reading.

    Reads are grouped by their most common text length (a length that
    recurs is good evidence the plate was segmented correctly that frame),
    then each character position is decided by a confidence-weighted vote
    within that group - so a handful of clean reads outvote noisier ones
    instead of the result depending on whichever frame happened first/last.
    """
    # Only fully-alphanumeric reads vote. See CLEAN_READ_RE above.
    texted = [r for r in readings if is_clean_read(r["text"])]
    if not texted:
        representative = max(readings, key=lambda r: r["detection_confidence"])
        return {
            "plate_text": None,
            "plate_confidence": None,
            "plate_confidence_per_char": None,
            "representative": representative,
            "num_frames_used_for_consensus": 0,
        }

    mode_length, _ = Counter(len(normalize_read(r["text"])) for r in texted).most_common(1)[0]
    candidates = [r for r in texted if len(normalize_read(r["text"])) == mode_length]

    consensus_chars, consensus_conf = [], []
    for pos in range(mode_length):
        weight_by_char = defaultdict(float)
        votes_by_char = Counter()
        for r in candidates:
            ch = normalize_read(r["text"])[pos]
            weight = r["confidence_per_char"][pos] if r["confidence_per_char"] else (r["confidence"] or 0.0)
            weight_by_char[ch] += weight
            votes_by_char[ch] += 1
        winner = max(weight_by_char, key=weight_by_char.get)
        consensus_chars.append(winner)
        consensus_conf.append(weight_by_char[winner] / votes_by_char[winner])

    consensus_text = "".join(consensus_chars)
    # prefer a frame that actually read the consensus text verbatim, for the
    # saved crop - falls back to the highest-confidence candidate otherwise
    exact_matches = [r for r in candidates if normalize_read(r["text"]) == consensus_text]
    representative = max(exact_matches or candidates, key=lambda r: r["confidence"] or 0.0)

    return {
        "plate_text": consensus_text,
        "plate_confidence": sum(consensus_conf) / len(consensus_conf),
        "plate_confidence_per_char": consensus_conf,
        "representative": representative,
        "num_frames_used_for_consensus": len(candidates),
    }


def trigger_event(events_dir, rejected_dir, track_id, readings, source,
                   min_plate_chars=DEFAULT_MIN_PLATE_CHARS,
                   camera_id=None, device_id=None):
    """Finalize one track. Valid plates land in events_dir; everything else goes
    to rejected_dir so the filter's decisions stay auditable rather than
    silently discarding data. The payload is event contract v2, built by
    contract_v2.build_event_payload()."""
    consensus = best_reading(readings)
    representative = consensus["representative"]
    ok, reason = validate_plate(consensus["plate_text"], min_plate_chars)

    ts = utc_now()
    folder_name = f"{ts.strftime('%Y%m%dT%H%M%S%f')}Z_plate_track{track_id}"
    target_dir = events_dir if ok else rejected_dir
    event_dir = target_dir / folder_name
    event_dir.mkdir(parents=True, exist_ok=True)

    image_filename = "plate.jpg"
    cv2.imwrite(str(event_dir / image_filename), representative["crop"])

    payload = build_event_payload(
        event_id=uuid.uuid4(),
        finalized_at=ts,
        camera_id=camera_id,
        device_id=device_id,
        source=source,
        track_id=track_id,
        readings=readings,
        consensus=consensus,
        image_filename=image_filename,
        rejected=not ok,
        rejection_reason=reason,
    )

    with open(event_dir / "event.json", "w") as f:
        json.dump(payload, f, indent=2)

    if ok:
        print(f"[event] track#{track_id} plate='{consensus['plate_text']}' "
              f"({len(readings)} frames, {consensus['num_frames_used_for_consensus']} used for consensus) -> {event_dir}")
    else:
        print(f"[rejected] track#{track_id} {reason} "
              f"({len(readings)} frames) -> {event_dir}")
    return event_dir, ok


def warn_possible_fragmentation(finalized, max_frame_gap=15):
    """Post-hoc check that one physical plate didn't become several tracks.

    This only WARNS - it deliberately does not merge. Checked against the
    2026-08-14 run, no merge rule that would have joined tracks #11/#13/#17/#19
    (which read '4444' / '' / '77M' / '') is narrow enough to also keep the two
    plates that are on screen together at frames 662-674 apart. A rule loose
    enough to fix the bug is loose enough to fuse two different cars, which is a
    silent error and strictly worse than a visible one. If these warnings fire,
    that's the evidence needed to design merging properly.
    """
    ordered = sorted(finalized, key=lambda t: t["frame_first"])
    for prev, nxt in zip(ordered, ordered[1:]):
        gap = nxt["frame_first"] - prev["frame_last"]
        if not 0 <= gap <= max_frame_gap:
            continue
        pb, nb = prev["last_box"], nxt["first_box"]
        # Scale-aware proximity: compare centre offset to the plate's own size,
        # since a 25 px plate and a 90 px plate tolerate very different jumps.
        pcx, pcy = (pb["x1"] + pb["x2"]) / 2, (pb["y1"] + pb["y2"]) / 2
        ncx, ncy = (nb["x1"] + nb["x2"]) / 2, (nb["y1"] + nb["y2"]) / 2
        scale = max(pb["x2"] - pb["x1"], 1)
        if ((ncx - pcx) ** 2 + (ncy - pcy) ** 2) ** 0.5 / scale < 4.0:
            print(f"[warn] possible fragmentation: track#{prev['track_id']} "
                  f"({prev['plate_text']!r}, ends f{prev['frame_last']}) -> "
                  f"track#{nxt['track_id']} ({nxt['plate_text']!r}, starts f{nxt['frame_first']}), "
                  f"gap={gap} frames")


def open_capture(source):
    cap = cv2.VideoCapture(source)
    if cap.isOpened():
        return cap
    cap.release()
    return None


class LatestFrameGrabber:
    """Live streams only: always hand the detector the newest frame.

    cv2.VideoCapture queues every frame, so a reader slower than the stream (3.5
    fps of a 10 fps stream under full CPU load) falls further behind real time
    every second - measured 0.65 s per second - and stamps old frames with the
    current wall clock. This thread grab()s continuously and only retrieve()s
    (the costly decode-to-BGR) the frame the main loop is waiting for, so each
    processed frame is fresh and its grab time is its real capture time.
    """

    def __init__(self, cap):
        self.cap = cap
        self.skipped = 0
        self._cond = threading.Condition()
        self._wanted = self._ready = self._failed = self._stop = False
        self._frame = self._grabbed_at = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop:
            ok = self.cap.grab()
            grabbed_at = utc_now()
            if ok:
                with self._cond:
                    wanted = self._wanted
                if not wanted:
                    self.skipped += 1
                    continue
                ok, frame = self.cap.retrieve()
            with self._cond:
                if not ok:
                    self._failed = True
                else:
                    self._frame, self._grabbed_at = frame, grabbed_at
                    self._ready, self._wanted = True, False
                self._cond.notify_all()
            if not ok:
                return

    def read(self, timeout=STALL_TIMEOUT_S):
        """(ok, frame, grabbed_at_utc) for the next fresh frame; ok=False if the
        stream failed or stalled for `timeout` seconds."""
        with self._cond:
            self._wanted = True
            self._cond.wait_for(lambda: self._ready or self._failed, timeout)
            if not self._ready:
                self._wanted = False
                return False, None, None
            frame, grabbed_at = self._frame, self._grabbed_at
            self._ready, self._frame = False, None
            return True, frame, grabbed_at

    def stop(self):
        """Stop grabbing. Returns False if the thread is still stuck in a blocking
        read on a dead stream - then the capture must not be released under it."""
        self._stop = True
        self._thread.join(timeout=5)
        return not self._thread.is_alive()


def ort_session_options(threads):
    if not threads:
        return None
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    return opts


def capture_fps(cap):
    """The capture's nominal fps, or None if it isn't believable - RTSP
    backends sometimes report 0, or the 90 kHz RTP clock, instead."""
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    return fps if 1.0 <= fps <= 120.0 else None


def run(source, events_dir="events", conf=0.4, show=True,
        tracker_yaml="scripts/bytetrack_plates.yaml",
        rejected_dir=None, min_plate_chars=DEFAULT_MIN_PLATE_CHARS,
        camera_id=None, device_id=None, source_start_utc=None,
        heartbeat_interval=60, upload=True, metrics_path=None,
        ort_threads=DEFAULT_ORT_THREADS, backend="auto"):
    live = is_live_source(source)
    # never print/store the stream password - logs end up in bug reports
    safe_source = redact_source(source)
    if source_start_utc is not None and live:
        print("[warn] --source-start-utc only applies to video files - "
              "live frames are stamped with the wall clock")
        source_start_utc = None

    cpu = ["CPUExecutionProvider"]
    alpr = ALPR(
        detector_model="yolo-v9-t-384-license-plate-end2end",
        ocr_model="cct-xs-v2-global-model",
        detector_conf_thresh=conf,
        detector_providers=cpu,
        detector_sess_options=ort_session_options(ort_threads),
        ocr_providers=cpu,
        ocr_sess_options=ort_session_options(ort_threads),
    )
    if backend != "cpu":
        # plate detector on the GPU (TensorRT); OCR stays on the CPU (see trt_backend.py)
        try:
            from scripts.trt_backend import use_tensorrt
            use_tensorrt(alpr)
            print("[backend] plate detector on GPU (TensorRT FP16), OCR on CPU")
        except Exception as e:  # anything from a missing library to a bad engine
            if backend == "tensorrt":
                raise
            print(f"[backend] TensorRT unavailable ({e}) - plate detector on CPU")
    else:
        print("[backend] plate detector and OCR on CPU")
    tracker = build_tracker(tracker_yaml)

    events_dir = Path(events_dir)
    events_dir.mkdir(exist_ok=True)
    rejected_dir = Path(rejected_dir or f"{events_dir}_rejected")
    rejected_dir.mkdir(exist_ok=True)

    uploader = EventUploader() if upload else None
    # started before the stream opens, so a camera that never comes up is
    # still reported (status=error) instead of the device just going silent
    heartbeat = HeartbeatSender(device_id, camera_id, events_dir,
                                interval_s=heartbeat_interval,
                                metrics_path=metrics_path).start()

    def _reconnect(cap):
        """Reopen a dropped live stream, backing off up to RECONNECT_MAX_S.
        Blocks until it's back - the heartbeat thread keeps reporting
        meanwhile (camera_connected=false, status=error after 10 s)."""
        if cap is not None:
            cap.release()
        note = "rtsp reconnecting" if str(source).lower().startswith("rtsp") else "stream reconnecting"
        delay = RECONNECT_MIN_S
        while True:
            heartbeat.set_stream_state(False, note)
            print(f"[stream] {safe_source} not delivering frames - reconnecting in {delay}s")
            time.sleep(delay)
            cap = open_capture(source)
            if cap is not None:
                break
            delay = min(delay * 2, RECONNECT_MAX_S)
        print(f"[stream] {safe_source} connected")
        heartbeat.set_stream_state(True)
        heartbeat.set_nominal_fps(capture_fps(cap))
        return cap

    cap = open_capture(source)
    if cap is None and not live:
        heartbeat.stop()
        raise RuntimeError(f"Could not open source: {safe_source}")

    grabber = None
    track_buffers = defaultdict(list)
    finalized = []
    counts = {"accepted": 0, "rejected": 0}
    frame_index = -1

    def _finalize(tid, readings):
        event_dir, accepted = trigger_event(events_dir, rejected_dir, tid, readings,
                                            source, min_plate_chars,
                                            camera_id=camera_id, device_id=device_id)
        counts["accepted" if accepted else "rejected"] += 1
        if accepted:
            heartbeat.note_event(utc_now())
            # rejected tracks are local-only by design (doc 13 §1, D24)
            if uploader is not None:
                uploader.submit(event_dir)
        consensus = best_reading(readings)
        finalized.append({
            "track_id": tid,
            "plate_text": consensus["plate_text"],
            "frame_first": readings[0]["frame_index"],
            "frame_last": readings[-1]["frame_index"],
            "first_box": readings[0]["bounding_box"],
            "last_box": readings[-1]["bounding_box"],
        })

    try:
        if cap is None:
            cap = _reconnect(None)
        else:
            heartbeat.set_stream_state(True)
            heartbeat.set_nominal_fps(capture_fps(cap))

        # only a file's own fps can turn frame_index into a recording time
        file_fps = None
        if source_start_utc is not None:
            file_fps = capture_fps(cap)
            if file_fps is None:
                print("[warn] video fps unknown - ignoring --source-start-utc, "
                      "frames get wall-clock capture times")

        if live:
            grabber = LatestFrameGrabber(cap)
        while True:
            if grabber is not None:
                ok, frame, grabbed_at = grabber.read()
            else:
                ok, frame = cap.read()
                grabbed_at = utc_now()
            if not ok:
                if not live:
                    break  # end of the video file
                # don't release a capture the grab thread may still be blocked in
                cap = _reconnect(cap if grabber.stop() else None)
                grabber = LatestFrameGrabber(cap)
                continue
            frame_index += 1
            heartbeat.note_frame()
            captured_at = captured_at_for(frame_index, grabbed_at, source_start_utc, file_fps)

            plate_results = get_plate_detections(alpr, frame)
            boxes = detections_to_boxes(plate_results, frame.shape)
            tracked_rows = tracker.update(boxes)

            for row in tracked_rows:
                track_id, idx = int(row[4]), int(row[7])
                track_buffers[track_id].append(
                    make_reading(frame, plate_results[idx], frame_index, captured_at))

            # a track_id still in tracked_stracks is matched this frame; still in
            # lost_stracks means it's within track_buffer frames of its last
            # match and being kept alive on motion prediction alone. Anything in
            # our buffer that's in neither has just aged out - finalize it.
            alive_ids = {t.track_id for t in tracker.tracked_stracks} | {t.track_id for t in tracker.lost_stracks}
            for tid in [tid for tid in track_buffers if tid not in alive_ids]:
                _finalize(tid, track_buffers.pop(tid))

            if show:
                draw_plate_boxes(frame, plate_results, tracked_rows)
                cv2.imshow("plate OCR reader", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    except KeyboardInterrupt:
        # a second Ctrl-C / SIGTERM must not abort the finalize below and lose
        # the open tracks (run_pipeline.sh kills outright if this ever hangs)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        print("\n[stop] interrupted - finalizing open tracks")

    if grabber is not None:
        if not grabber.stop():
            cap = None  # still blocked in a read; leave the capture alone
        print(f"[stream] analysed the newest frame each time; skipped {grabber.skipped} stale frames")
    if cap is not None:
        cap.release()
    cv2.destroyAllWindows()

    # video ended with tracks still open (tracked or lost-but-not-removed) - flush them too
    for tid, readings in list(track_buffers.items()):
        _finalize(tid, readings)

    warn_possible_fragmentation(finalized)
    print(f"\n{counts['accepted']} plates registered -> {events_dir}")
    print(f"{counts['rejected']} rejected (audit them) -> {rejected_dir}")

    # the uploader thread is a daemon - let queued uploads finish before exit
    # (a failure is logged and left for upload_events.py, so this can't hang)
    if uploader is not None and uploader.enabled and uploader.queue.unfinished_tasks:
        print("[upload] waiting for queued uploads to finish...")
        uploader.queue.join()

    # one last beat so the dashboard sees the stream stop rather than a stale "ok"
    heartbeat.set_stream_state(False, "producer stopped")
    heartbeat.send_once()
    heartbeat.stop()


def _sigterm_as_interrupt(signum, frame):
    # only the first signal starts the shutdown; repeats are ignored
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise KeyboardInterrupt


if __name__ == "__main__":
    # SIGTERM (run_pipeline.sh, systemd) takes the same path as Ctrl-C: open tracks
    # are finalized and a last heartbeat is sent. A supervisor's background job
    # can't be sent SIGINT reliably - bash starts it with SIGINT ignored.
    signal.signal(signal.SIGTERM, _sigterm_as_interrupt)
    ap = argparse.ArgumentParser()
    src_group = ap.add_mutually_exclusive_group(required=True)
    src_group.add_argument("--source",
                           help="Axis RTSP URL, video file, or webcam index")
    src_group.add_argument("--source-env", metavar="VAR",
                           help="read --source from this environment variable instead, "
                                "so an RTSP password never shows up in `ps` "
                                "(run_pipeline.sh uses this)")
    ap.add_argument("--camera-id", default=None,
                     help="camera_id from config.yaml cameras[] (inbound_cam_01 / "
                          "outbound_cam_01). Required unless exactly one camera's "
                          "device_id matches --device-id or this hostname.")
    ap.add_argument("--device-id", default=None,
                     help="default: config.yaml cameras[] entry for --camera-id, "
                          "else the hostname")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG_PATH),
                     help="config.yaml (v2) for cameras[] and heartbeat.interval_s")
    ap.add_argument("--source-start-utc", default=None,
                     help="video files only: ISO-8601 UTC time of the file's first "
                          "frame, so captured_at_utc = start + frame_index / fps "
                          "(e.g. 2026-08-14T00:57:19Z). Default: wall clock at grab.")
    ap.add_argument("--no-upload", action="store_true",
                     help="don't upload events in real time (upload_events.py can "
                          "sweep them up later)")
    ap.add_argument("--conf", type=float, default=0.4,
                     help="plate DETECTION confidence threshold. Lowering this is "
                          "not what fixes track fragmentation - see "
                          "scripts/bytetrack_plates.yaml for the measured cause.")
    ap.add_argument("--events-dir", default="events",
                     help="folder to write accepted plate-track events into")
    ap.add_argument("--rejected-dir", default=None,
                     help="folder for tracks that fail plate validation "
                          "(default: <events-dir>_rejected)")
    ap.add_argument("--min-plate-chars", type=int, default=DEFAULT_MIN_PLATE_CHARS,
                     help="reject consensus reads shorter than this")
    ap.add_argument("--tracker", default="scripts/bytetrack_plates.yaml",
                     help="ByteTrack config; the plate-tuned one by default")
    ap.add_argument("--headless", action="store_true",
                     help="don't open a preview window")
    ap.add_argument("--backend", choices=["auto", "tensorrt", "cpu"], default="auto",
                     help="where the plate detector runs: auto = TensorRT on the GPU if "
                          "available, else CPU; tensorrt = fail if it isn't")
    ap.add_argument("--ort-threads", type=int, default=DEFAULT_ORT_THREADS,
                     help="onnxruntime threads per model session (0 = onnxruntime "
                          "default, all cores - oversubscribes with two readers)")
    ap.add_argument("--metrics-path", default=None,
                     help="sysmetrics.py's metrics_latest.json - attached to each "
                          "heartbeat as `metrics` while it's fresh")
    args = ap.parse_args()
    if args.source_env:
        args.source = os.environ.get(args.source_env, "")
        if not args.source:
            ap.error(f"--source-env: ${args.source_env} is not set")

    config = load_config(args.config)
    camera_id = resolve_camera_id(config, args.camera_id, args.device_id)
    if not camera_id:
        ap.error("--camera-id is required (couldn't resolve it from --device-id / "
                 f"hostname in {args.config})")
    known = {c.get("camera_id") for c in config_cameras(config)}
    if known and camera_id not in known:
        print(f"[warn] camera_id {camera_id!r} is not in {args.config} cameras[] "
              f"{sorted(known)} - the backend will quarantine its events")
    device_id = resolve_device_id(config, camera_id, args.device_id)

    source_start_utc = None
    if args.source_start_utc:
        try:
            source_start_utc = parse_utc(args.source_start_utc)
        except ValueError:
            ap.error(f"--source-start-utc: not an ISO-8601 time: {args.source_start_utc!r}")

    print(f"[producer v2] camera_id={camera_id} device_id={device_id} "
          f"source={redact_source(args.source)}")
    src = int(args.source) if args.source.isdigit() else args.source
    run(src, args.events_dir, args.conf, show=not args.headless,
        tracker_yaml=args.tracker, rejected_dir=args.rejected_dir,
        min_plate_chars=args.min_plate_chars,
        camera_id=camera_id, device_id=device_id,
        source_start_utc=source_start_utc,
        heartbeat_interval=heartbeat_interval_s(config),
        upload=not args.no_upload, metrics_path=args.metrics_path,
        ort_threads=args.ort_threads, backend=args.backend)
