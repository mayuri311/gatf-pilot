"""Camera model: turns a true pass into event-v2 JSON (doc 14 §3.4).

Per-frame reads[] are synthesised around an *observed* plate (normally the
true plate; a confusable swap / dropped edge character when an imperfection
is injected), then the producer's own consensus (consensus.best_reading)
decides plate_text. A consensus error therefore only appears when the
per-frame noise really outvotes the truth.
"""

from __future__ import annotations

import math
import random
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from . import plates
from .config import SimConfig
from .consensus import best_reading, is_clean_read, validate_plate
from .timeutil import folder_stamp, iso
from .world import TruePass

FPS = 30
TRACK_BUFFER = 60
IMAGE_FILENAME = "plate.jpg"

# Fixed lane ROI per direction: centre (x, y) of the plate in a 1920x1080 frame.
LANE_ROI = {"in": (950, 815), "out": (880, 760)}


@dataclass
class NoiseParams:
    miss_rate_in: float = 0.02
    miss_rate_out: float = 0.03
    confusion_rate: float = 0.08
    drop_edge_char_rate: float = 0.02
    fragment_rate: float = 0.03
    late_upload_rate: float = 0.01
    late_upload_max: timedelta = timedelta(hours=3)
    late_upload_min: timedelta = timedelta(minutes=5)
    clock_skew_ms: dict[str, int] = field(default_factory=dict)  # device_id -> ms ('*' = all)
    min_plate_chars: int = 5

    def skew_for(self, device_id: str) -> timedelta:
        ms = self.clock_skew_ms.get(device_id, self.clock_skew_ms.get("*", 0))
        return timedelta(milliseconds=ms)

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["late_upload_max"] = d["late_upload_max"].total_seconds()
        d["late_upload_min"] = d["late_upload_min"].total_seconds()
        return d


@dataclass
class Outage:
    camera_id: str
    start: datetime
    end: datetime
    mode: str = "backlog"  # backlog: captured, uploaded in a burst at the end | lost: camera down

    def covers(self, t: datetime) -> bool:
        return self.start <= t < self.end

    def to_dict(self) -> dict:
        return {"camera_id": self.camera_id, "start": iso(self.start), "end": iso(self.end), "mode": self.mode}


@dataclass
class SimEvent:
    payload: dict
    camera_dir: str
    folder: str
    release_at: datetime
    pass_id: str | None
    visit_id: str | None
    true_plate: str | None
    kind: str = "main"  # main | fragment
    injected: str | None = None  # confusion | drop_edge | scripted
    late: bool = False
    backlog: bool = False
    extra_releases: list[datetime] = field(default_factory=list)  # duplicate deliveries
    contract_valid: bool = True
    note: str | None = None

    @property
    def event_id(self) -> str:
        return self.payload["event_id"]

    @property
    def path(self) -> str:
        return f"{self.camera_dir}/events/{self.folder}"


def _clip(x: float, lo: float = 0.05, hi: float = 0.9999) -> float:
    return lo if x < lo else hi if x > hi else x


class CameraModel:
    def __init__(self, cfg: SimConfig, noise: NoiseParams, seed: int, origin: datetime,
                 outages: list[Outage] | None = None):
        self.cfg = cfg
        self.noise = noise
        self.rng = random.Random(f"{seed}:camera")
        self.origin = origin
        self.outages = outages or []
        self.counts: Counter = Counter()
        self.rejections: Counter = Counter()
        self.track_ids = {c.camera_id: self.rng.randint(1, 40) for c in cfg.cameras}
        # per-camera running frame counter base (process started a little before the horizon)
        self.frame_base = {c.camera_id: self.rng.randint(1_000, 50_000) for c in cfg.cameras}
        self._backlog_seq: Counter = Counter()

    # ---------- helpers ----------
    def new_uuid(self) -> str:
        return str(uuid.UUID(int=self.rng.getrandbits(128), version=4))

    def next_track_id(self, camera_id: str) -> int:
        self.track_ids[camera_id] = self.track_ids.get(camera_id, 1) + self.rng.choice((1, 1, 1, 2, 3))
        return self.track_ids[camera_id]

    def frame_at(self, camera_id: str, t: datetime) -> int:
        return self.frame_base.get(camera_id, 1000) + int((t - self.origin).total_seconds() * FPS)

    def outage_at(self, camera_id: str, t: datetime) -> Outage | None:
        for o in self.outages:
            if o.camera_id == camera_id and o.covers(t):
                return o
        return None

    # ---------- per-frame reads ----------
    def render_reads(self, observed: str, truth: str, n: int, noisy: bool) -> list[dict]:
        rng = self.rng
        lead = max(1, round(n * rng.uniform(0.03, 0.10)))
        trail = max(1, round(n * rng.uniform(0.03, 0.10)))
        p_major = rng.uniform(0.62, 0.85) if noisy else 1.0
        reads = []
        for i in range(n):
            pos = i / max(n - 1, 1)
            base = 0.55 + 0.445 * math.sin(math.pi * pos) ** 0.5  # low at the edges
            det = round(rng.uniform(0.5, 0.95), 4)
            if i < lead or i >= n - trail:
                reads.append({"frame_index": i, "text": "", "confidence": round(rng.uniform(0.3, 0.99), 4),
                              "confidence_per_char": None, "detection_confidence": det})
                continue
            factor, weak_pos = 1.0, None
            if rng.random() < p_major:
                text = observed
            elif observed != truth and rng.random() < 0.35:
                text, factor = truth, 0.95  # the truth is there, just outvoted
            else:
                x = rng.random()
                if x < 0.45:
                    text = plates.confuse_one(rng, observed)
                    weak_pos = next((k for k, (a, b) in enumerate(zip(text, observed)) if a != b), None)
                elif x < 0.60:
                    text, factor = plates.drop_edge(rng, observed), 0.9
                elif x < 0.72:
                    text, factor = plates.confuse_one(rng, plates.confuse_one(rng, observed)), 0.85
                elif x < 0.87:
                    text, factor = plates.garbage_read(rng, observed), 0.7
                else:
                    text, factor = plates.random_junk(rng), 0.6
            per_char = []
            for k in range(len(text)):
                c = base * factor + rng.gauss(0, 0.02)
                if k == weak_pos:
                    c *= 0.8
                per_char.append(round(_clip(c), 4))
            conf = round(sum(per_char) / len(per_char), 4) if per_char else round(base, 4)
            reads.append({"frame_index": i, "text": text, "confidence": conf,
                          "confidence_per_char": per_char or None, "detection_confidence": det})
        return reads

    # ---------- event construction ----------
    def build_event(self, camera_id: str, at: datetime, observed: str, truth: str, *,
                    n_frames: int, noisy: bool, kind: str, pass_id: str | None, visit_id: str | None,
                    overrides: dict | None = None, captured_shift: timedelta = timedelta(0),
                    validate: bool = True) -> tuple[SimEvent | None, str | None]:
        """Build one event for configured camera `camera_id` (also its output
        folder). `overrides` patch the payload afterwards (scenario 18 writes
        e.g. an unknown camera_id or schema_version 1 this way).
        Returns (event, None) or (None, rejection_reason)."""
        cam = self.cfg.camera(camera_id)
        device, direction = cam.device_id, cam.direction
        local = self.render_reads(observed, truth, n_frames, noisy)
        cons = best_reading(local)
        if validate:
            ok, reason = validate_plate(cons["plate_text"], self.noise.min_plate_chars)
            if not ok:
                return None, reason.split(":")[0]
        rep = cons["representative"]
        rep_local = rep["frame_index"]
        skew = self.noise.skew_for(device)
        captured = at + skew + captured_shift
        base = self.frame_at(camera_id, at) - rep_local
        reads_out = [
            {"frame_index": base + r["frame_index"], "text": r["text"], "confidence": r["confidence"],
             "clean": is_clean_read(r["text"])}
            for r in local
        ]
        finalize = captured + timedelta(seconds=((n_frames - 1 - rep_local) + TRACK_BUFFER) / FPS)
        track_id = self.next_track_id(camera_id)
        cx, cy = LANE_ROI[direction]
        w = self.rng.randint(70, 110)
        h = int(w * self.rng.uniform(0.45, 0.6))
        x1 = cx + self.rng.randint(-40, 40) - w // 2
        y1 = cy + self.rng.randint(-25, 25) - h // 2
        payload = {
            "schema_version": 2,
            "event_id": self.new_uuid(),
            "event_type": "plate_track_finalized",
            "camera_id": camera_id,
            "device_id": device,
            "captured_at_utc": iso(captured),
            "timestamp_utc": iso(finalize),
            "source": f"sim://{camera_id}",
            "track_id": track_id,
            "frame_first": reads_out[0]["frame_index"],
            "frame_last": reads_out[-1]["frame_index"],
            "num_frames_tracked": len(reads_out),
            "num_frames_with_text": sum(1 for r in local if r["text"]),
            "num_frames_used_for_consensus": cons["num_frames_used_for_consensus"],
            "plate_text": cons["plate_text"],
            "plate_confidence": round(cons["plate_confidence"], 4) if cons["plate_confidence"] is not None else None,
            "plate_confidence_per_char": [round(c, 4) for c in cons["plate_confidence_per_char"]]
            if cons["plate_confidence_per_char"] is not None else None,
            "plate_detection_confidence": rep["detection_confidence"],
            "plate_bounding_box": {"x1": x1, "y1": y1, "x2": x1 + w, "y2": y1 + h},
            "representative_frame_index": base + rep_local,
            "reads": reads_out,
            "image_filename": IMAGE_FILENAME,
        }
        if overrides:
            payload.update(overrides)
        ev = SimEvent(
            payload=payload, camera_dir=camera_id,
            folder=f"{folder_stamp(finalize)}_plate_track{track_id}",
            release_at=finalize, pass_id=pass_id, visit_id=visit_id, true_plate=truth, kind=kind,
        )
        return ev, None

    def _apply_release(self, ev: SimEvent, allow_late: bool = True) -> None:
        """release_at = finalize time, + a random delay for late uploads, or
        the end of a backlog-mode outage (burst of queued uploads)."""
        finalize = ev.release_at
        if allow_late and self.rng.random() < self.noise.late_upload_rate:
            lo = self.noise.late_upload_min.total_seconds()
            hi = max(lo, self.noise.late_upload_max.total_seconds())
            ev.release_at = finalize + timedelta(seconds=self.rng.uniform(lo, hi))
            ev.late = True
            self.counts["late_uploads"] += 1
        o = self.outage_at(ev.camera_dir, finalize)
        if o is not None and o.mode == "backlog":
            self._backlog_seq[(o.camera_id, o.start)] += 1
            burst = o.end + timedelta(seconds=0.25 * self._backlog_seq[(o.camera_id, o.start)])
            if burst > ev.release_at:
                ev.release_at = burst
                ev.backlog = True
                self.counts["backlog_uploads"] += 1

    # ---------- world passes ----------
    def process_pass(self, tp: TruePass) -> list[SimEvent]:
        rng, nz = self.rng, self.noise
        miss_rate = nz.miss_rate_in if tp.direction == "in" else nz.miss_rate_out
        if rng.random() < miss_rate:
            tp.outcome = "missed"
            self.counts[f"missed_{tp.direction}"] += 1
            return []
        o = self.outage_at(tp.camera_id, tp.at)
        if o is not None and o.mode == "lost":
            tp.outcome = "lost_outage"
            self.counts["lost_in_outage"] += 1
            return []

        observed, injected = tp.plate, None
        x = rng.random()
        if x < nz.confusion_rate:
            swapped = plates.confuse_one(rng, tp.plate)
            if swapped != tp.plate:
                observed, injected = swapped, "confusion"
            else:
                self.counts["confusion_skipped_no_confusable_char"] += 1
        elif x < nz.confusion_rate + nz.drop_edge_char_rate:
            observed, injected = plates.drop_edge(rng, tp.plate), "drop_edge"

        ev, reason = self.build_event(tp.camera_id, tp.at, observed, tp.plate,
                                      n_frames=rng.randint(60, 200), noisy=True, kind="main",
                                      pass_id=tp.pass_id, visit_id=tp.visit_id)
        if ev is None:
            tp.outcome = "rejected"
            self.rejections[reason] += 1
            self.counts["rejected_tracks"] += 1
            return []
        if injected:
            self.counts[f"{injected}_injected"] += 1
        ev.injected = injected
        text = ev.payload["plate_text"]
        if text != tp.plate:
            self.counts["consensus_errors_total"] += 1
            if text != observed:
                self.counts["spontaneous_consensus_errors"] += 1
        tp.outcome, tp.plate_text = "emitted", text
        self._apply_release(ev)
        out = [ev]
        tp.event_ids.append(ev.event_id)

        if rng.random() < nz.fragment_rate:
            k = 1 if len(text) <= 6 or rng.random() < 0.7 else 2
            partial = text[k:]
            frag_at = tp.at + timedelta(seconds=rng.uniform(2.0, 8.0))
            fev, freason = self.build_event(tp.camera_id, frag_at, partial, tp.plate,
                                            n_frames=rng.randint(15, 50), noisy=True, kind="fragment",
                                            pass_id=tp.pass_id, visit_id=tp.visit_id)
            if fev is None:
                self.counts["fragment_rejected"] += 1
                self.rejections[freason] += 1
            else:
                self.counts["fragments"] += 1
                self._apply_release(fev)
                out.append(fev)
                tp.event_ids.append(fev.event_id)
        return out
