#!/usr/bin/env python3
"""
GATF Pilot - Vehicle occupancy demo
YOLOv8 + ByteTrack -> zone occupancy + directional line counting -> event log

Works with any video source. Swap SOURCE to the Axis RTSP URL when PoE arrives:
    rtsp://<user>:<pass>@<camera-ip>/axis-media/media.amp

Usage:
    python occupancy_demo.py --source lot.mp4 --draw        # define zones/lines by clicking
    python occupancy_demo.py --source lot.mp4               # run detection
    python occupancy_demo.py --source rtsp://... --save out.mp4
"""

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

# COCO vehicle classes: car, motorcycle, bus, truck
VEHICLE_CLASSES = [2, 3, 5, 7]
CONFIG_PATH = Path("zones.json")

# ----------------------------------------------------------------------------
# Geometry config: zones (polygons) and counting lines
# ----------------------------------------------------------------------------

class Geometry:
    def __init__(self, zones=None, lines=None, capacity=100):
        self.zones = zones or {}      # {name: [[x,y], ...]}
        self.lines = lines or {}      # {name: {"pts": [[x1,y1],[x2,y2]], "dir": "entry"|"exit"}}
        self.capacity = capacity

    @classmethod
    def load(cls, path=CONFIG_PATH):
        if not Path(path).exists():
            return cls()
        d = json.loads(Path(path).read_text())
        return cls(d.get("zones"), d.get("lines"), d.get("capacity", 100))

    def save(self, path=CONFIG_PATH):
        Path(path).write_text(json.dumps({
            "zones": self.zones,
            "lines": self.lines,
            "capacity": self.capacity,
        }, indent=2))
        print(f"Saved geometry -> {path}")

    def zone_contains(self, name, pt):
        poly = np.array(self.zones[name], dtype=np.int32)
        return cv2.pointPolygonTest(poly, (float(pt[0]), float(pt[1])), False) >= 0


def draw_geometry_tool(source):
    """Click to define zones and counting lines on the first frame."""
    cap = cv2.VideoCapture(source)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError(f"Could not read from {source}")

    geo = Geometry.load()
    pts, mode = [], "zone"
    print("""
  LEFT CLICK  add point
  z           finish as ZONE (parking area / lane region)
  e           finish as ENTRY line (2 pts)
  x           finish as EXIT line (2 pts)
  u           undo last point
  s           save and quit
  q           quit without saving
""")

    def on_mouse(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN:
            pts.append([x, y])

    cv2.namedWindow("define geometry")
    cv2.setMouseCallback("define geometry", on_mouse)

    while True:
        vis = frame.copy()
        # existing
        for name, poly in geo.zones.items():
            cv2.polylines(vis, [np.array(poly, np.int32)], True, (0, 200, 255), 2)
            cv2.putText(vis, name, tuple(poly[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)
        for name, ln in geo.lines.items():
            p1, p2 = ln["pts"]
            color = (0, 255, 0) if ln["dir"] == "entry" else (0, 0, 255)
            cv2.line(vis, tuple(p1), tuple(p2), color, 2)
            cv2.putText(vis, f'{name}:{ln["dir"]}', tuple(p1), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        # in progress
        for p in pts:
            cv2.circle(vis, tuple(p), 4, (255, 255, 255), -1)
        if len(pts) > 1:
            cv2.polylines(vis, [np.array(pts, np.int32)], False, (255, 255, 255), 1)

        cv2.imshow("define geometry", vis)
        k = cv2.waitKey(20) & 0xFF

        if k == ord("u") and pts:
            pts.pop()
        elif k == ord("z") and len(pts) >= 3:
            geo.zones[f"zone_{len(geo.zones)}"] = pts.copy(); pts.clear()
        elif k in (ord("e"), ord("x")) and len(pts) == 2:
            d = "entry" if k == ord("e") else "exit"
            geo.lines[f"line_{len(geo.lines)}"] = {"pts": pts.copy(), "dir": d}; pts.clear()
        elif k == ord("s"):
            geo.save(); break
        elif k == ord("q"):
            break

    cv2.destroyAllWindows()


# ----------------------------------------------------------------------------
# Occupancy state machine
# ----------------------------------------------------------------------------

class OccupancyCounter:
    """
    Bounded counter driven by line-crossing events.

    Bounding at [0, capacity] is what keeps missed detections from letting the
    count drift off into nonsense. It does NOT fix drift - it caps how wrong it
    can get. For the pilot, plan a daily reset against a manual count.
    """

    def __init__(self, capacity):
        self.capacity = capacity
        self.count = 0
        self.events = []
        self.clamped = 0   # times we hit a bound == drift indicator

    def _emit(self, kind, track_id, extra=None):
        ev = {
            "event": kind,
            "track_id": int(track_id),
            "occupancy": self.count,
            "timestamp": time.time(),
        }
        if extra:
            ev.update(extra)
        self.events.append(ev)
        return ev

    def entry(self, track_id, **kw):
        if self.count >= self.capacity:
            self.clamped += 1
        self.count = min(self.count + 1, self.capacity)
        return self._emit("entry", track_id, kw)

    def exit(self, track_id, **kw):
        if self.count <= 0:
            self.clamped += 1
        self.count = max(self.count - 1, 0)
        return self._emit("exit", track_id, kw)


def side_of_line(pt, p1, p2):
    """Sign of the cross product: which side of the directed line p1->p2."""
    return np.sign((p2[0] - p1[0]) * (pt[1] - p1[1]) - (p2[1] - p1[1]) * (pt[0] - p1[0]))


def segments_near(pt, p1, p2, tol=60):
    """Guard against counting a crossing of the infinite line far from the segment."""
    p1, p2, pt = np.array(p1, float), np.array(p2, float), np.array(pt, float)
    seg = p2 - p1
    t = np.clip(np.dot(pt - p1, seg) / (np.dot(seg, seg) + 1e-9), 0, 1)
    return np.linalg.norm(p1 + t * seg - pt) < tol


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

def run(source, geo, model_name="yolov8n.pt", conf=0.35, save=None, show=True):
    """
    Two independent occupancy signals are tracked and shown on screen:

    1. ZONE OCCUPANCY (live) - how many currently-tracked vehicles have their
       anchor point inside a zone polygon, right now, this frame. No memory
       across frames. This is the number to show an advisor: pause the video,
       count the cars in the zone by eye, and it should match immediately.
       Nothing to explain about entry/exit logic - it's just "count what's
       inside the box."

    2. CUMULATIVE (entry/exit) - the OccupancyCounter driven by line crossings,
       incremented on entry-line crossing, decremented on exit-line crossing.
       This is the metric the real product needs (a lot with one shared
       in/out lane doesn't let you just look at a zone), but it depends on
       tracking staying consistent across the whole crossing, so it's more
       fragile and harder to eyeball-verify. Kept for comparison against (1).
    """
    model = YOLO(model_name)
    counter = OccupancyCounter(geo.capacity)

    prev_side = defaultdict(dict)     # track_id -> {line_name: side}
    counted = defaultdict(set)        # track_id -> {line_names already counted}
    writer = None
    last_zone_log = 0.0

    cap = cv2.VideoCapture(source)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.release()

    for result in model.track(
        source=source,
        stream=True,
        persist=True,
        tracker="bytetrack.yaml",
        classes=VEHICLE_CLASSES,
        conf=conf,
        verbose=False,
    ):
        frame = result.orig_img.copy()
        boxes = result.boxes

        zone_hits = {name: 0 for name in geo.zones}
        zone_occupants = set()   # track_ids inside ANY zone this frame (deduped)

        if boxes is not None and boxes.id is not None:
            ids = boxes.id.int().cpu().tolist()
            xyxy = boxes.xyxy.cpu().numpy()
            clss = boxes.cls.int().cpu().tolist()
            confs = boxes.conf.cpu().tolist()

            for tid, box, cls, cf in zip(ids, xyxy, clss, confs):
                x1, y1, x2, y2 = box.astype(int)
                # bottom-center = where the vehicle meets the ground.
                # Using the box centroid biases the position toward the camera
                # and makes zone membership wrong for tall vehicles.
                anchor = ((x1 + x2) // 2, y2)

                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(frame, f"#{tid} {model.names[cls]} {cf:.2f}",
                            (x1, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
                cv2.circle(frame, anchor, 4, (0, 255, 255), -1)

                for zname in geo.zones:
                    if geo.zone_contains(zname, anchor):
                        zone_hits[zname] += 1
                        zone_occupants.add(tid)

                for lname, ln in geo.lines.items():
                    p1, p2 = ln["pts"]
                    s = side_of_line(anchor, p1, p2)
                    prev = prev_side[tid].get(lname)
                    crossed = (
                        prev is not None
                        and s != 0 and prev != 0 and s != prev
                        and segments_near(anchor, p1, p2)
                        and lname not in counted[tid]   # one count per track per line
                    )
                    if crossed:
                        counted[tid].add(lname)
                        ev = (counter.entry if ln["dir"] == "entry" else counter.exit)(
                            tid, line=lname, confidence=round(cf, 3)
                        )
                        print(json.dumps(ev))
                    prev_side[tid][lname] = s

        # overlay geometry
        for name, poly in geo.zones.items():
            arr = np.array(poly, np.int32)
            cv2.polylines(frame, [arr], True, (0, 200, 255), 2)
            cv2.putText(frame, f"{name}: {zone_hits[name]}", tuple(arr[0]),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)
        for name, ln in geo.lines.items():
            p1, p2 = ln["pts"]
            color = (0, 255, 0) if ln["dir"] == "entry" else (0, 0, 255)
            cv2.line(frame, tuple(p1), tuple(p2), color, 3)

        zone_capacity = geo.capacity if geo.zones else None
        zone_line = f"ZONE OCCUPANCY (live): {len(zone_occupants)}"
        if zone_capacity:
            zone_line += f" / {zone_capacity}"

        cross_line = f"CUMULATIVE (entry/exit): {counter.count}/{counter.capacity}"
        if counter.clamped:
            cross_line += f"   [clamped x{counter.clamped}]"

        cv2.rectangle(frame, (0, 0), (frame.shape[1], 72), (0, 0, 0), -1)
        cv2.putText(frame, zone_line, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.putText(frame, cross_line, (10, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)

        now = time.time()
        if now - last_zone_log >= 1.0:
            counter.events.append({
                "event": "zone_occupancy_sample",
                "count": len(zone_occupants),
                "timestamp": now,
            })
            last_zone_log = now

        if save:
            if writer is None:
                h, w = frame.shape[:2]
                writer = cv2.VideoWriter(save, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
            writer.write(frame)

        if show:
            cv2.imshow("occupancy demo", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    if writer:
        writer.release()
    cv2.destroyAllWindows()

    Path("events.jsonl").write_text("\n".join(json.dumps(e) for e in counter.events))
    print(f"\n{len(counter.events)} events -> events.jsonl")
    print(f"final occupancy: {counter.count}   clamped: {counter.clamped}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="video file, rtsp:// url, or webcam index")
    ap.add_argument("--draw", action="store_true", help="define zones/lines on first frame")
    ap.add_argument("--model", default="yolov8n.pt")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--capacity", type=int, default=100)
    ap.add_argument("--save", default=None, help="write annotated mp4")
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    src = int(args.source) if args.source.isdigit() else args.source

    if args.draw:
        draw_geometry_tool(src)
    else:
        geo = Geometry.load()
        geo.capacity = args.capacity
        if not geo.zones and not geo.lines:
            print("No geometry defined. Run with --draw first.")
        else:
            run(src, geo, args.model, args.conf, args.save, show=not args.headless)