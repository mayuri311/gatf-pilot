from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from occsim.config import REPO_ROOT
from occsim.contract import EVENT_DB_COLUMNS, db_row, validate_event, validate_heartbeat


def test_every_generated_event_is_contract_v2(sim_dir, cfg):
    files = sorted(sim_dir.glob("*/events/*/event.json"))
    assert len(files) > 100
    for f in files:
        ev = json.loads(f.read_text())
        assert validate_event(ev, cfg) == [], f
        assert (f.parent / "plate.jpg").stat().st_size > 0


def test_every_heartbeat_is_v1(sim_dir, cfg):
    n = 0
    for f in sim_dir.glob("*/heartbeats.jsonl"):
        for line in f.read_text().splitlines():
            assert validate_heartbeat(json.loads(line), cfg) == []
            n += 1
    assert n > 2000


def test_event_shape_matches_sample_keys(sim_dir):
    ev = json.loads(next(sim_dir.glob("inbound_cam_01/events/*/event.json")).read_text())
    assert ev["schema_version"] == 2
    assert ev["event_type"] == "plate_track_finalized"
    assert ev["camera_id"] == "inbound_cam_01" and ev["device_id"] == "jetson-in-01"
    assert ev["image_filename"] == "plate.jpg"
    assert ev["source"] == "sim://inbound_cam_01"
    assert ev["captured_at_utc"].endswith("+00:00")


SAMPLE = REPO_ROOT / "plan" / "samples" / "event.v2.json"
SAMPLE_HB = REPO_ROOT / "plan" / "samples" / "heartbeat.v1.json"


@pytest.mark.skipif(not SAMPLE.exists(), reason="plan/samples not available")
def test_doc_samples_validate(cfg):
    # the sample shortens reads[] for readability -> non-strict
    assert validate_event(json.loads(SAMPLE.read_text()), cfg, strict=False) == []
    assert validate_heartbeat(json.loads(SAMPLE_HB.read_text()), cfg) == []


def _good_event(sim_dir) -> dict:
    return json.loads(next(sim_dir.glob("*/events/*/event.json")).read_text())


@pytest.mark.parametrize("mutate, needle", [
    (lambda e: e.update(schema_version=1), "schema_version"),
    (lambda e: e.update(camera_id="inbound_cam_99"), "camera_id"),
    (lambda e: e.update(device_id="jetson-xx-99"), "device_id"),
    (lambda e: e.update(plate_text="ab-12"), "plate_text"),
    (lambda e: e.update(captured_at_utc="2026-10-13T10:00:00"), "captured_at_utc"),
    (lambda e: e.update(plate_confidence=1.5), "plate_confidence"),
    (lambda e: e["plate_confidence_per_char"].pop(), "length"),
    (lambda e: e.update(extra_field=1), "unexpected"),
    (lambda e: e.pop("reads"), "missing"),
    (lambda e: e["reads"][0].update(clean=not e["reads"][0]["clean"]), "clean"),
    (lambda e: e.update(source="rtsp://user:pw@cam/x"), "credentials"),
    (lambda e: e.update(image_filename="vehicle.jpg"), "image_filename"),
])
def test_validator_catches_violations(sim_dir, cfg, mutate, needle):
    ev = copy.deepcopy(_good_event(sim_dir))
    mutate(ev)
    errs = validate_event(ev, cfg)
    assert any(needle in e for e in errs), errs


def test_heartbeat_validator_catches_violations(cfg):
    hb = json.loads(SAMPLE_HB.read_text()) if SAMPLE_HB.exists() else None
    if hb is None:
        pytest.skip("sample missing")
    bad = dict(hb, status="sleepy")
    assert any("status" in e for e in validate_heartbeat(bad, cfg))
    bad = dict(hb, pending_uploads=-1)
    assert any("pending_uploads" in e for e in validate_heartbeat(bad, cfg))


def test_db_row_has_only_contract_columns(sim_dir):
    ev = _good_event(sim_dir)
    row = db_row(ev)
    assert set(row) <= set(EVENT_DB_COLUMNS)
    assert row["image_path"] == f"{ev['event_id']}.jpg"
    assert "image_filename" not in row


def test_validate_cli(sim_dir):
    from occsim.cli import main
    assert main(["validate", str(sim_dir)]) == 0
