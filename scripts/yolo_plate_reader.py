#!/usr/bin/env python3
"""
License plate reader for the Axis camera feed, using fast-alpr instead of the
Haar cascade in plate_reader.py. Also draws boxes around vehicles using a
COCO-pretrained YOLO model, since COCO already includes car/motorcycle/bus/
truck classes (unlike license plates, which need fast-alpr's own model).

fast-alpr bundles a pretrained YOLOv9 plate detector and a pretrained OCR
model, so unlike a plain custom-trained YOLO model, no training or --weights
file is needed - detection and reading both work out of the box:
    https://github.com/ankandrew/fast-alpr

Click 2 points on the first frame at startup to define a crossing line.
Vehicles are tracked (not just detected per-frame) with ByteTrack, which
gives each one a persistent ID and specifically re-associates low-confidence
or briefly-missed detections with their existing track instead of treating a
flicker as a new object - that persistent ID is what the crossing count is
keyed on. Crossing the line in one direction increments the on-screen
occupancy count, the other direction decrements it (swap your click order if
it comes out backwards for your layout).

Every crossing also writes an event to disk under events/<timestamp>_<type>_track<id>/:
an event.json with the crossing's metadata (type, UTC timestamp, vehicle
class/confidence, plate text/confidence, bounding boxes, etc.) and
vehicle.jpg - a crop of just the crossing vehicle (no overlays), not the
full frame. Plate OCR only runs on that crop, not on every full frame in the
live view, so it's spending its effort on the vehicle that actually
triggered an event instead of scanning the whole scene every frame.

If SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set (.env or environment),
each event is also queued for upload to Supabase (see supabase_sync.py) and
synced by a background thread - the local write above always happens first
and is what actually unblocks the frame loop; the network call happens
later, off-thread, so a slow/unreliable connection can never stall tracking.
A failed upload is only logged, not retried inline - the event folder's
missing .uploaded marker is what upload_events.py picks up on its next run.

Axis RTSP URL format:
    rtsp://<user>:<pass>@<camera-ip>/axis-media/media.amp

Usage:
    python yolo_plate_reader.py --source "rtsp://user:pass@192.168.1.64/axis-media/media.amp"
    python yolo_plate_reader.py --source lot.mp4
"""

import argparse
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import cv2
from dotenv import load_dotenv
from fast_alpr import ALPR
from ultralytics import YOLO

from occupancy_demo import side_of_line, segments_near
from supabase_sync import EventUploader

load_dotenv()

VEHICLE_CLASSES = [2, 3, 5, 7]  # COCO: car, motorcycle, bus, truck


def get_plate_detections(alpr, frame):
    return alpr.predict(frame)


def draw_plate_boxes(frame, plate_results):
    for result in plate_results:
        box = result.detection.bounding_box
        text = result.ocr.text if result.ocr else ""
        conf = result.detection.confidence

        cv2.rectangle(frame, (box.x1, box.y1), (box.x2, box.y2), (0, 255, 0), 2)
        label = f"{text} ({conf:.2f})" if text else f"({conf:.2f})"
        cv2.putText(frame, label, (box.x1, box.y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)


def trigger_event(events_dir, event_type, alpr, frame, track_id, vehicle_cls_name,
                   vehicle_cls_id, det_conf, vehicle_box, occupancy_count, source):
    ts = datetime.now(timezone.utc)
    folder_name = f"{ts.strftime('%Y%m%dT%H%M%S%f')}Z_{event_type}_track{track_id}"
    event_dir = events_dir / folder_name
    event_dir.mkdir(parents=True, exist_ok=True)

    x1, y1, x2, y2 = (int(v) for v in vehicle_box)
    crop = frame[max(y1, 0):y2, max(x1, 0):x2]

    image_filename = "vehicle.jpg"
    cv2.imwrite(str(event_dir / image_filename), crop)

    plate_match = None
    if crop.size:
        plate_results = get_plate_detections(alpr, crop)
        if plate_results:
            plate_match = max(plate_results, key=lambda r: r.detection.confidence)

    plate_text = plate_confidence = plate_confidence_per_char = None
    plate_detection_confidence = plate_bounding_box = None
    if plate_match is not None:
        pb = plate_match.detection.bounding_box
        plate_detection_confidence = plate_match.detection.confidence
        # relative to vehicle.jpg (the crop), not the original camera frame
        plate_bounding_box = {"x1": pb.x1, "y1": pb.y1, "x2": pb.x2, "y2": pb.y2}
        if plate_match.ocr:
            plate_text = plate_match.ocr.text
            ocr_conf = plate_match.ocr.confidence
            if isinstance(ocr_conf, list):
                plate_confidence_per_char = ocr_conf
                plate_confidence = sum(ocr_conf) / len(ocr_conf) if ocr_conf else None
            else:
                plate_confidence = ocr_conf

    payload = {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "timestamp_utc": ts.isoformat(),
        "source": str(source),
        "track_id": track_id,
        "occupancy_count": occupancy_count,
        "vehicle_class": vehicle_cls_name,
        "vehicle_class_id": vehicle_cls_id,
        "detection_confidence": det_conf,
        "bounding_box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        "plate_text": plate_text,
        "plate_confidence": plate_confidence,
        "plate_confidence_per_char": plate_confidence_per_char,
        "plate_detection_confidence": plate_detection_confidence,
        "plate_bounding_box": plate_bounding_box,
        "image_filename": image_filename,
    }
    with open(event_dir / "event.json", "w") as f:
        json.dump(payload, f, indent=2)

    print(f"[event] {event_type} track#{track_id} -> {event_dir}")
    return event_dir


def setup_crossing_line(source):
    """Click 2 points on the first frame to define the crossing line."""
    cap = cv2.VideoCapture(source)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError(f"Could not read first frame from {source}")

    pts = []

    def on_mouse(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN and len(pts) < 2:
            pts.append((x, y))

    window = "click 2 points to define the crossing line"
    cv2.namedWindow(window)
    cv2.setMouseCallback(window, on_mouse)
    print("Click 2 points to define the crossing line, then press any key. "
          "Crossing one direction increments the count, the other "
          "decrements it - swap your click order if it comes out backwards.")

    while True:
        vis = frame.copy()
        for p in pts:
            cv2.circle(vis, p, 5, (255, 255, 255), -1)
        if len(pts) == 2:
            cv2.line(vis, pts[0], pts[1], (0, 255, 255), 2)
        cv2.imshow(window, vis)
        key = cv2.waitKey(20)
        if len(pts) == 2 and key != -1:
            break

    cv2.destroyWindow(window)
    return pts[0], pts[1]


def run(source, vehicle_model="yolov8n.pt", conf=0.35, events_dir="events"):
    alpr = ALPR(
        detector_model="yolo-v9-t-384-license-plate-end2end",
        ocr_model="cct-xs-v2-global-model",
    )
    vehicles = YOLO(vehicle_model)

    events_dir = Path(events_dir)
    events_dir.mkdir(exist_ok=True)
    uploader = EventUploader()

    p1, p2 = setup_crossing_line(source)
    prev_side = {}
    count = 0

    for result in vehicles.track(
        source=source,
        stream=True,
        persist=True,
        tracker="bytetrack.yaml",
        classes=VEHICLE_CLASSES,
        conf=conf,
        verbose=False,
    ):
        frame = result.orig_img.copy()
        # plate_results = get_plate_detections(alpr, frame)  # now read per-crop in trigger_event, not every frame
        raw_frame = frame.copy()  # snapshot before any overlay drawing, for event logging

        boxes = result.boxes

        if boxes is not None and boxes.id is not None:
            ids = boxes.id.int().cpu().tolist()
            xyxy = boxes.xyxy.cpu().numpy()
            clss = boxes.cls.int().cpu().tolist()
            confs = boxes.conf.cpu().tolist()

            for tid, box, cls, cf in zip(ids, xyxy, clss, confs):
                x1, y1, x2, y2 = box.astype(int)
                # bottom-center = where the vehicle meets the ground, so
                # crossing detection isn't skewed by tall vehicles.
                anchor = ((x1 + x2) // 2, y2)

                cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 0, 0), 2)
                cv2.putText(frame, f"#{tid} {vehicles.names[cls]} {cf:.2f}",
                            (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 0), 2)

                side = side_of_line(anchor, p1, p2)
                prev = prev_side.get(tid)
                crossed = (
                    prev is not None
                    and side != 0 and prev != 0 and side != prev
                    and segments_near(anchor, p1, p2)
                )
                if crossed:
                    event_type = "entry" if side > prev else "exit"
                    count += 1 if event_type == "entry" else -1
                    event_dir = trigger_event(
                        events_dir, event_type, alpr, raw_frame, tid, vehicles.names[cls],
                        cls, cf, (x1, y1, x2, y2), count, source,
                    )
                    uploader.submit(event_dir)  # non-blocking - queues for the background thread
                prev_side[tid] = side

        cv2.line(frame, p1, p2, (0, 255, 255), 3)
        cv2.putText(frame, f"Occupancy: {count}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)

        # draw_plate_boxes(frame, plate_results)  # no longer computed every frame, see above

        cv2.imshow("Axis Camera 1", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cv2.destroyAllWindows()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True,
                     help="Axis RTSP URL, video file, or webcam index")
    ap.add_argument("--vehicle-model", default="yolov8n.pt",
                     help="COCO-pretrained YOLO model for vehicle boxes")
    ap.add_argument("--conf", type=float, default=0.35,
                     help="detection confidence threshold for vehicle tracking")
    ap.add_argument("--events-dir", default="events",
                     help="folder to write crossing-event subfolders into")
    args = ap.parse_args()

    src = int(args.source) if args.source.isdigit() else args.source
    run(src, args.vehicle_model, args.conf, args.events_dir)
