"""Write the producer-identical folder layout + ground truth + manifest (doc 14 §3.6).

sim_out/
├── manifest.json
├── ground_truth/{visits.csv, occupancy.csv, passes.csv}
├── <camera_id>/events/<UTC ts>Z_plate_track<id>/{event.json, plate.jpg}
└── <camera_id>/heartbeats.jsonl
"""

from __future__ import annotations

import csv
import io
import json
import shutil
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from .camera import IMAGE_FILENAME, Outage, SimEvent
from .config import SimConfig
from .timeutil import iso
from .world import TruePass, Visit

MANIFEST_FORMAT = 1


@lru_cache(maxsize=1)
def placeholder_jpeg() -> bytes:
    """Grey 96x48 JPEG with 'SIM' on it (~1 KB). Same bytes for every event."""
    from PIL import Image, ImageDraw

    img = Image.new("L", (96, 48), color=150)
    draw = ImageDraw.Draw(img)
    try:
        from PIL import ImageFont
        font = ImageFont.load_default(size=22)
    except Exception:  # very old Pillow
        font = None
    if font is not None:
        draw.text((48, 24), "SIM", fill=30, font=font, anchor="mm")
    else:
        draw.text((36, 18), "SIM", fill=30)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75, optimize=False)
    return buf.getvalue()


@dataclass
class SimResult:
    cfg: SimConfig
    start_utc: datetime
    end_utc: datetime
    visits: list[Visit]
    passes: list[TruePass]
    events: list[SimEvent]
    heartbeats: dict[str, list[dict]]
    params: dict
    counts: dict
    outages: list[Outage] = field(default_factory=list)
    actions: list[dict] = field(default_factory=list)
    scenario: dict | None = None

    def release_schedule(self) -> list[dict]:
        rows = []
        for e in self.events:
            for i, at in enumerate([e.release_at, *e.extra_releases]):
                rows.append({
                    "release_at": iso(at),
                    "event_id": e.event_id,
                    "path": e.path,
                    "camera_id": e.payload.get("camera_id"),
                    "device_id": e.payload.get("device_id"),
                    "captured_at_utc": e.payload.get("captured_at_utc"),
                    "timestamp_utc": e.payload.get("timestamp_utc"),
                    "plate_text": e.payload.get("plate_text"),
                    "true_plate": e.true_plate,
                    "pass_id": e.pass_id,
                    "visit_id": e.visit_id,
                    "kind": e.kind,
                    "injected": e.injected,
                    "late": e.late,
                    "backlog": e.backlog,
                    "duplicate": i > 0,
                    "contract_valid": e.contract_valid,
                    "note": e.note,
                })
        # stable: release time, then generation order (scenarios rely on it)
        for n, r in enumerate(rows):
            r["order"] = n
        rows.sort(key=lambda r: (r["release_at"], r["order"]))
        for n, r in enumerate(rows):
            r["order"] = n
        return rows


def _prepare_out(out: Path, cfg: SimConfig, force: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)
    manifest = out / "manifest.json"
    entries = [p for p in out.iterdir() if not p.name.startswith(".")]
    if not entries:
        return
    if not manifest.exists() and not force:
        raise FileExistsError(f"{out} is not empty and has no manifest.json; refusing to write "
                              f"(use --force or an empty directory)")
    stale = {"ground_truth", *(c.camera_id for c in cfg.cameras)}
    if manifest.exists():
        try:
            old = json.loads(manifest.read_text())
            stale |= set((old.get("counts") or {}).get("events_per_camera", {}).keys())
        except (ValueError, OSError):
            pass
        manifest.unlink()
    for name in stale:
        p = out / name
        # only remove directories that look like simulator output
        if p.is_dir() and (name == "ground_truth" or (p / "events").exists()):
            shutil.rmtree(p)
    for f in ("report.md",):
        (out / f).unlink(missing_ok=True)


def _bool(b) -> str:
    return "1" if b else "0"


def write_result(res: SimResult, out: str | Path, *, force: bool = False) -> Path:
    out = Path(out)
    _prepare_out(out, res.cfg, force)
    jpg = placeholder_jpeg()

    # events
    per_camera: Counter = Counter()
    for e in res.events:
        d = out / e.camera_dir / "events" / e.folder
        d.mkdir(parents=True, exist_ok=False)
        (d / "event.json").write_text(json.dumps(e.payload, indent=2))
        (d / IMAGE_FILENAME).write_bytes(jpg)
        per_camera[e.camera_dir] += 1
    # heartbeats (one file per configured camera, even if empty)
    hb_counts = {}
    for cam in res.cfg.cameras:
        (out / cam.camera_id / "events").mkdir(parents=True, exist_ok=True)
        beats = res.heartbeats.get(cam.camera_id, [])
        with open(out / cam.camera_id / "heartbeats.jsonl", "w") as f:
            for hb in beats:
                f.write(json.dumps(hb) + "\n")
        hb_counts[cam.camera_id] = len(beats)

    # ground truth
    gt = out / "ground_truth"
    gt.mkdir(parents=True, exist_ok=True)
    passes_by_visit: dict[str, dict[str, TruePass]] = {}
    for p in res.passes:
        passes_by_visit.setdefault(p.visit_id, {})[p.direction] = p
    with open(gt / "visits.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["visit_id", "plate", "jurisdiction", "is_regular", "dwell_class", "entry_at", "exit_at",
                    "dwell_min", "is_bounce", "is_overnight", "is_multi_day", "close_follow",
                    "entry_outcome", "entry_plate_read", "exit_outcome", "exit_plate_read"])
        for v in res.visits:
            pi = passes_by_visit.get(v.visit_id, {}).get("in")
            po = passes_by_visit.get(v.visit_id, {}).get("out")
            w.writerow([
                v.visit_id, v.plate, v.jurisdiction, _bool(v.is_regular), v.dwell_class,
                iso(v.entry_at) if v.entry_at else "", iso(v.exit_at) if v.exit_at else "",
                f"{v.dwell_min:.2f}" if v.dwell_min is not None else "",
                _bool(v.is_bounce), _bool(v.is_overnight(res.end_utc)), _bool(v.is_multi_day(res.end_utc)),
                _bool(v.close_follow),
                pi.outcome if pi else "", (pi.plate_text or "") if pi else "",
                po.outcome if po else "", (po.plate_text or "") if po else "",
            ])
    with open(gt / "passes.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["pass_id", "visit_id", "camera_id", "direction", "at", "plate", "outcome",
                    "plate_text", "event_ids"])
        for p in res.passes:
            w.writerow([p.pass_id, p.visit_id, p.camera_id, p.direction, iso(p.at), p.plate, p.outcome,
                        p.plate_text or "", ";".join(p.event_ids)])
    with open(gt / "occupancy.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["at", "occupancy", "delta", "cause", "plate", "visit_id", "pass_id"])
        w.writerow([iso(res.start_utc), 0, 0, "start", "", "", ""])
        occ = 0
        for p in sorted(res.passes, key=lambda p: (p.at, 0 if p.direction == "out" else 1)):
            delta = 1 if p.direction == "in" else -1
            occ += delta
            w.writerow([iso(p.at), occ, delta, "entry" if delta > 0 else "exit", p.plate, p.visit_id, p.pass_id])

    counts = dict(res.counts)
    counts["events_total"] = len(res.events)
    counts["events_per_camera"] = dict(sorted(per_camera.items()))
    counts["heartbeats_per_camera"] = hb_counts
    manifest = {
        "format_version": MANIFEST_FORMAT,
        "generator": "occsim",
        "scenario": res.scenario,
        "lot": res.cfg.to_dict(),
        "time_range": {"start_utc": iso(res.start_utc), "end_utc": iso(res.end_utc)},
        "params": res.params,
        "counts": counts,
        "outages": [o.to_dict() for o in res.outages],
        "actions": res.actions,
        "release_schedule": res.release_schedule(),
        "rebase": None,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    return out
