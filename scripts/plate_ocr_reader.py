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

This is a local-only validation tool: it does not upload to Supabase. The
existing events table (see supabase_schema.sql) is shaped for vehicle
crossing events (event_type check-constrained to entry/exit, vehicle_class,
track_id, etc.) and doesn't fit this metadata - wire up sync later with its
own table if this becomes a real pipeline.

Usage:
    python plate_ocr_reader.py --source "rtsp://user:pass@192.168.1.64/axis-media/media.amp"
    python plate_ocr_reader.py --source camera_captures/capture_20260813_205719.mp4
"""

import argparse
import json
import re
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from dotenv import load_dotenv
from fast_alpr import ALPR
from ultralytics.engine.results import Boxes
from ultralytics.trackers.byte_tracker import BYTETracker
from ultralytics.utils import YAML, IterableSimpleNamespace
from ultralytics.utils.checks import check_yaml

load_dotenv()


# A plate read is only trusted if it is pure A-Z0-9. The OCR model emits "_" as
# its blank/pad token, so reads like "1_1", "5__33" or "41_7" are partial
# decodes leaking the pad character - not plates. Excluding them from the vote
# both kills those false positives and sharpens consensus on real plates, whose
# clean reads then dominate the modal-length grouping.
CLEAN_READ_RE = re.compile(r"^[A-Z0-9]+$")

DEFAULT_MIN_PLATE_CHARS = 5


def normalize_read(text):
    return (text or "").strip().upper()


def is_clean_read(text):
    return bool(CLEAN_READ_RE.match(normalize_read(text)))


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


def make_reading(frame, result, frame_index):
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
                   min_plate_chars=DEFAULT_MIN_PLATE_CHARS):
    """Finalize one track. Valid plates land in events_dir; everything else goes
    to rejected_dir so the filter's decisions stay auditable rather than
    silently discarding data."""
    consensus = best_reading(readings)
    representative = consensus["representative"]
    ok, reason = validate_plate(consensus["plate_text"], min_plate_chars)

    ts = datetime.now(timezone.utc)
    folder_name = f"{ts.strftime('%Y%m%dT%H%M%S%f')}Z_plate_track{track_id}"
    target_dir = events_dir if ok else rejected_dir
    event_dir = target_dir / folder_name
    event_dir.mkdir(parents=True, exist_ok=True)

    image_filename = "plate.jpg"
    cv2.imwrite(str(event_dir / image_filename), representative["crop"])

    payload = {
        "event_id": str(uuid.uuid4()),
        "event_type": "plate_track_finalized",
        "timestamp_utc": ts.isoformat(),
        "source": str(source),
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
        "reads": [
            {"frame_index": r["frame_index"], "text": r["text"], "confidence": r["confidence"]}
            for r in readings
        ],
        "image_filename": image_filename,
        "rejected": not ok,
        "rejection_reason": reason,
    }
    # Per-read audit trail: `clean` marks which reads were eligible to vote, so a
    # surprising consensus can be traced back without re-running the video.
    payload["reads"] = [
        {
            "frame_index": r["frame_index"],
            "text": r["text"],
            "confidence": r["confidence"],
            "clean": is_clean_read(r["text"]),
        }
        for r in readings
    ]

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


def run(source, events_dir="events", conf=0.4, show=True,
        tracker_yaml="scripts/bytetrack_plates.yaml",
        rejected_dir=None, min_plate_chars=DEFAULT_MIN_PLATE_CHARS):
    alpr = ALPR(
        detector_model="yolo-v9-t-384-license-plate-end2end",
        ocr_model="cct-xs-v2-global-model",
        detector_conf_thresh=conf,
    )
    tracker = build_tracker(tracker_yaml)

    events_dir = Path(events_dir)
    events_dir.mkdir(exist_ok=True)
    rejected_dir = Path(rejected_dir or f"{events_dir}_rejected")
    rejected_dir.mkdir(exist_ok=True)

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open source: {source}")

    track_buffers = defaultdict(list)
    finalized = []
    counts = {"accepted": 0, "rejected": 0}
    frame_index = -1

    def _finalize(tid, readings):
        _, accepted = trigger_event(events_dir, rejected_dir, tid, readings,
                                    source, min_plate_chars)
        counts["accepted" if accepted else "rejected"] += 1
        consensus = best_reading(readings)
        finalized.append({
            "track_id": tid,
            "plate_text": consensus["plate_text"],
            "frame_first": readings[0]["frame_index"],
            "frame_last": readings[-1]["frame_index"],
            "first_box": readings[0]["bounding_box"],
            "last_box": readings[-1]["bounding_box"],
        })

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_index += 1

        plate_results = get_plate_detections(alpr, frame)
        boxes = detections_to_boxes(plate_results, frame.shape)
        tracked_rows = tracker.update(boxes)

        for row in tracked_rows:
            track_id, idx = int(row[4]), int(row[7])
            track_buffers[track_id].append(make_reading(frame, plate_results[idx], frame_index))

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

    cap.release()
    cv2.destroyAllWindows()

    # video ended with tracks still open (tracked or lost-but-not-removed) - flush them too
    for tid, readings in list(track_buffers.items()):
        _finalize(tid, readings)

    warn_possible_fragmentation(finalized)
    print(f"\n{counts['accepted']} plates registered -> {events_dir}")
    print(f"{counts['rejected']} rejected (audit them) -> {rejected_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True,
                     help="Axis RTSP URL, video file, or webcam index")
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
    args = ap.parse_args()

    src = int(args.source) if args.source.isdigit() else args.source
    run(src, args.events_dir, args.conf, show=not args.headless,
        tracker_yaml=args.tracker, rejected_dir=args.rejected_dir,
        min_plate_chars=args.min_plate_chars)
