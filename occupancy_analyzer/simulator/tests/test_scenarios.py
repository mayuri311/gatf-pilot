from __future__ import annotations

import json
from datetime import timedelta

import pytest

from occsim.config import SimConfig
from occsim.contract import validate_event, validate_heartbeat
from occsim.scenario import build_scenario, list_scenarios, load_scenario
from occsim.timeutil import parse_iso
from occsim.writer import write_result

ALL = [s["name"] for s in list_scenarios()]


def build(name):
    return build_scenario(load_scenario(name), SimConfig())


def test_twenty_scenarios_numbered_1_to_20():
    ids = sorted(s["id"] for s in list_scenarios())
    assert ids == list(range(1, 21))
    assert {s["mode"] for s in list_scenarios()} <= {"replay", "partial", "engine_only"}


def test_load_by_number_and_name():
    assert load_scenario("2")["name"] == "ocr_near_miss"
    assert load_scenario("ocr_near_miss")["id"] == 2
    with pytest.raises(FileNotFoundError):
        load_scenario("nope")


@pytest.mark.parametrize("name", ALL)
def test_scenario_generates_valid_output(name, tmp_path):
    cfg = SimConfig()
    res = build_scenario(load_scenario(name), cfg)
    out = write_result(res, tmp_path / name)
    m = json.loads((out / "manifest.json").read_text())
    assert m["scenario"]["name"] == name and m["scenario"]["expect"]
    for e in res.events:
        if e.contract_valid:  # intentionally bad fixtures (scenario 18) are exempt
            assert validate_event(e.payload, cfg) == [], name
    for beats in res.heartbeats.values():
        for hb in beats:
            assert validate_heartbeat(hb, cfg) == []
    # deterministic
    res2 = build_scenario(load_scenario(name), SimConfig())
    assert [e.payload for e in res2.events] == [e.payload for e in res.events]


def plates(res, camera=None):
    return [e.payload["plate_text"] for e in sorted(res.events, key=lambda e: e.payload["captured_at_utc"])
            if camera is None or e.camera_dir == camera]


def test_ocr_near_miss_exact_reads():
    res = build("ocr_near_miss")
    assert plates(res) == ["Z94PVE", "Z94PWE"]
    exit_ev = [e for e in res.events if e.camera_dir == "outbound_cam_01"][0]
    assert exit_ev.true_plate == "Z94PVE"


def test_fragmented_track_two_events_four_seconds_apart():
    res = build("fragmented_track")
    ins = sorted((e for e in res.events if e.camera_dir == "inbound_cam_01"), key=lambda e: e.payload["captured_at_utc"])
    assert [e.payload["plate_text"] for e in ins] == ["Z94PVE", "94PVE"]
    dt = parse_iso(ins[1].payload["captured_at_utc"]) - parse_iso(ins[0].payload["captured_at_utc"])
    assert dt == timedelta(seconds=4)
    assert ins[0].pass_id == ins[1].pass_id and ins[1].kind == "fragment"
    assert ins[0].payload["track_id"] != ins[1].payload["track_id"]
    assert len([p for p in res.passes if p.direction == "in"]) == 1


def test_missed_steps_are_truth_only():
    res = build("missed_entry")
    assert len(res.passes) == 3 and len(res.events) == 2
    assert [p.outcome for p in res.passes if p.plate == "GVN4410"] == ["missed", "emitted"]


def test_late_arrival_release():
    res = build("late_arrival")
    late = [e for e in res.events if e.late]
    assert len(late) == 1
    assert late[0].release_at - parse_iso(late[0].payload["timestamp_utc"]) == timedelta(hours=3)


def test_out_of_order_batch_reverse_release():
    res = build("out_of_order_batch")
    sched = res.release_schedule()
    caps = [r["captured_at_utc"] for r in sched]
    assert caps == sorted(caps, reverse=True)
    assert len({r["release_at"][:19] for r in sched}) == 1


def test_duplicate_delivery_schedules_same_event_twice():
    res = build("duplicate_delivery")
    sched = res.release_schedule()
    ids = [r["event_id"] for r in sched]
    assert len(ids) == 3 and len(set(ids)) == 2
    assert sum(r["duplicate"] for r in sched) == 1


def test_reconciliation_counts():
    res = build("admin_reconciliation")
    ins = [e for e in res.events if e.camera_dir == "inbound_cam_01"]
    outs = [e for e in res.events if e.camera_dir == "outbound_cam_01"]
    assert len(ins) == 52 and len(outs) == 5  # S2 = 52, S1 = 52 - 5 = 47
    assert res.actions == [{"at": res.actions[0]["at"], "action": "reconcile", "visual_count": 41, "close": 11}]
    end_occ = sum(1 for v in res.visits if v.exit_at is None)
    assert end_occ == 41


def test_dst_dwell():
    res = build("dst_boundary")
    dw = {v.plate: v.dwell_min for v in res.visits}
    assert dw == {"DST4401": 570.0, "DST5502": 75.0}


def test_heartbeat_gap_scenario():
    res = build("heartbeat_offline_online")
    beats = res.heartbeats["inbound_cam_01"]
    gaps = [(parse_iso(b["sent_at_utc"]) - parse_iso(a["sent_at_utc"])).total_seconds()
            for a, b in zip(beats, beats[1:])]
    assert max(gaps) == 7 * 60  # 10:04 -> 10:11 (6 beats missing)
    assert len(res.heartbeats["outbound_cam_01"]) == 40


def test_contract_validation_fixtures_are_flagged():
    cfg = SimConfig()
    res = build_scenario(load_scenario("contract_validation"), cfg)
    bad = [e for e in res.events if not e.contract_valid]
    assert len(bad) == 3
    by_plate = {e.payload["plate_text"]: e for e in bad}
    assert by_plate["BAD1001"].payload["schema_version"] == 1
    assert by_plate["BAD1002"].payload["camera_id"] == "inbound_cam_99"
    skew = by_plate["BAD1003"]
    ahead = parse_iso(skew.payload["captured_at_utc"]) - skew.release_at
    assert ahead > timedelta(minutes=9)
    assert any("schema_version" in x for x in validate_event(by_plate["BAD1001"].payload, cfg))
    assert len(res.passes) == 1  # only VAL1000 is a real car


def test_scenario_cli_all(tmp_path, capsys):
    from occsim.cli import main
    assert main(["scenario", "run", "all", "--out", str(tmp_path)]) == 0
    assert len([p for p in tmp_path.iterdir() if (p / "manifest.json").exists()]) == 20
    assert main(["scenario", "list"]) == 0
    assert "ocr_near_miss" in capsys.readouterr().out
