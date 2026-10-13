from __future__ import annotations

import csv
import json
import re

from occsim.timeutil import folder_stamp, parse_iso

FOLDER_RE = re.compile(r"^\d{8}T\d{12}Z_plate_track\d+$")


def test_top_level_layout(sim_dir):
    names = {p.name for p in sim_dir.iterdir()}
    assert names == {"manifest.json", "ground_truth", "inbound_cam_01", "outbound_cam_01"}
    assert {p.name for p in (sim_dir / "ground_truth").iterdir()} == {"visits.csv", "occupancy.csv", "passes.csv"}
    for cam in ("inbound_cam_01", "outbound_cam_01"):
        assert (sim_dir / cam / "heartbeats.jsonl").exists()
        assert (sim_dir / cam / "events").is_dir()


def test_event_folders_match_producer_naming(sim_dir):
    for d in (sim_dir / "inbound_cam_01" / "events").iterdir():
        assert FOLDER_RE.match(d.name), d.name
        assert sorted(p.name for p in d.iterdir()) == ["event.json", "plate.jpg"]
        ev = json.loads((d / "event.json").read_text())
        assert d.name == f"{folder_stamp(parse_iso(ev['timestamp_utc']))}_plate_track{ev['track_id']}"


def test_placeholder_jpeg_is_small_and_shared(sim_dir):
    jpgs = list(sim_dir.glob("*/events/*/plate.jpg"))
    data = {p.read_bytes() for p in jpgs}
    assert len(data) == 1
    blob = data.pop()
    assert blob[:2] == b"\xff\xd8" and len(blob) < 3000
    from PIL import Image
    import io
    assert Image.open(io.BytesIO(blob)).size == (96, 48)


def test_manifest_release_schedule_covers_every_event(sim_dir):
    m = json.loads((sim_dir / "manifest.json").read_text())
    sched = m["release_schedule"]
    folders = {str(p.parent.relative_to(sim_dir)) for p in sim_dir.glob("*/events/*/event.json")}
    assert {r["path"] for r in sched} == folders
    assert [r["order"] for r in sched] == list(range(len(sched)))
    times = [r["release_at"] for r in sched]
    assert times == sorted(times)
    for r in sched:
        assert parse_iso(r["release_at"]) >= parse_iso(r["timestamp_utc"])
    assert m["counts"]["events_total"] == len(folders)
    assert m["params"]["seed"] == 42
    assert m["rebase"] is None


def test_ground_truth_consistency(sim_dir):
    with open(sim_dir / "ground_truth" / "visits.csv") as f:
        visits = list(csv.DictReader(f))
    with open(sim_dir / "ground_truth" / "occupancy.csv") as f:
        occ = list(csv.DictReader(f))
    with open(sim_dir / "ground_truth" / "passes.csv") as f:
        passes = list(csv.DictReader(f))
    assert occ[0]["cause"] == "start" and occ[0]["occupancy"] == "0"
    assert len(occ) - 1 == len(passes)
    final = int(occ[-1]["occupancy"])
    assert final == sum(1 for v in visits if not v["exit_at"])
    assert min(int(r["occupancy"]) for r in occ) >= 0
    for v in visits:
        if v["exit_at"]:
            assert parse_iso(v["exit_at"]) > parse_iso(v["entry_at"])
    emitted = [p for p in passes if p["outcome"] == "emitted"]
    assert all(p["event_ids"] for p in emitted)
