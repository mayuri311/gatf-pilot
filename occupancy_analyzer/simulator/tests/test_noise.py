"""Injected imperfection rates roughly match the knobs."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from conftest import run_generate
from occsim.timeutil import parse_iso


@pytest.fixture(scope="module")
def noisy(tmp_path_factory):
    out = tmp_path_factory.mktemp("noisy") / "o"
    res = run_generate(out, seed=123, days=3, wp_kw={"arrivals_per_day": 600, "profile": "weekday"},
                       miss_rate_in=0.10, miss_rate_out=0.05, confusion_rate=0.15, drop_edge_char_rate=0.05,
                       fragment_rate=0.10, late_upload_rate=0.05, clock_skew_ms={"jetson-out-01": 1500})
    return res, json.loads((out / "manifest.json").read_text())


def _close(observed, expected, n, k=4.0):
    """within k binomial standard deviations"""
    sd = (expected * (1 - expected) / n) ** 0.5
    return abs(observed - expected) <= k * sd + 1e-9


def test_miss_rates(noisy):
    res, m = noisy
    imp = m["counts"]["imperfections"]
    n_in, n_out = m["counts"]["true_passes"]["in"], m["counts"]["true_passes"]["out"]
    assert n_in > 1500
    assert _close(imp["missed_in"] / n_in, 0.10, n_in)
    assert _close(imp["missed_out"] / n_out, 0.05, n_out)


def test_confusion_drop_fragment_late_rates(noisy):
    res, m = noisy
    imp = m["counts"]["imperfections"]
    seen = sum(1 for p in res.passes if p.outcome in ("emitted", "rejected"))
    assert _close((imp["confusion_injected"] + imp.get("confusion_skipped_no_confusable_char", 0)) / seen, 0.15, seen)
    assert _close(imp["drop_edge_injected"] / seen, 0.05, seen)
    emitted = sum(1 for p in res.passes if p.outcome == "emitted")
    assert _close((imp["fragments"] + imp.get("fragment_rejected", 0)) / emitted, 0.10, emitted)
    n_ev = len(res.events)
    assert _close(imp["late_uploads"] / n_ev, 0.05, n_ev)


def test_consensus_errors_come_from_injection(noisy):
    _, m = noisy
    imp = m["counts"]["imperfections"]
    injected = imp["confusion_injected"] + imp["drop_edge_injected"]
    assert imp.get("spontaneous_consensus_errors", 0) <= 0.01 * injected + 3
    # nearly every injected error survives consensus (drop_edge on short plates may be rejected)
    assert imp["consensus_errors_total"] >= 0.9 * injected


def test_misreads_are_confusable_or_truncated(noisy):
    from occsim.plates import CONFUSABLE
    res, _ = noisy
    for e in res.events:
        if e.kind != "main" or e.payload["plate_text"] == e.true_plate:
            continue
        got, true = e.payload["plate_text"], e.true_plate
        if len(got) == len(true):
            diffs = [(a, b) for a, b in zip(got, true) if a != b]
            assert all(a in CONFUSABLE.get(b, "") for a, b in diffs), (got, true)
        else:
            assert got in (true[1:], true[:-1]), (got, true)


def test_late_uploads_released_after_finalize(noisy):
    res, _ = noisy
    late = [e for e in res.events if e.late]
    assert late
    for e in late:
        delay = e.release_at - parse_iso(e.payload["timestamp_utc"])
        assert timedelta(minutes=5) <= delay <= timedelta(hours=3)


def test_clock_skew_applied(noisy):
    res, _ = noisy
    by_pass = {p.pass_id: p for p in res.passes}
    for e in res.events:
        if e.kind == "main":
            skew = parse_iso(e.payload["captured_at_utc"]) - by_pass[e.pass_id].at
            expected = 1.5 if e.camera_dir == "outbound_cam_01" else 0.0
            assert abs(skew.total_seconds() - expected) < 1e-3


def test_fragments_are_partial_and_close_in_time(noisy):
    res, _ = noisy
    by_pass = {p.pass_id: p for p in res.passes}
    main = {e.pass_id: e for e in res.events if e.kind == "main"}
    frags = [e for e in res.events if e.kind == "fragment"]
    assert frags
    suffix = 0
    for f in frags:
        tp = by_pass[f.pass_id]
        assert f.payload["track_id"] != main[f.pass_id].payload["track_id"]
        assert len(f.payload["plate_text"]) < len(main[f.pass_id].payload["plate_text"])
        suffix += main[f.pass_id].payload["plate_text"].endswith(f.payload["plate_text"])
        dt = (parse_iso(f.payload["captured_at_utc"]) - tp.at).total_seconds()
        assert 2.0 <= dt <= 8.0 + 1.5  # + device skew
    assert suffix >= 0.9 * len(frags)  # '94PVE'-style tails of the main read


def test_world_mixture_and_capacity(noisy):
    res, m = noisy
    w = m["counts"]["world"]
    total = sum(w["dwell_classes"].values())
    assert _close(w["dwell_classes"]["overnight"] / total, 0.02, total)
    assert 0.3 < w["regular_arrivals"] / w["arrivals"] < 0.5
    # the lot is overbooked at 600/day: bounces happen and occupancy never exceeds capacity + bouncers
    assert w["bounces"] > 0


def test_outage_backlog_and_heartbeat_gap(sim_dir):
    m = json.loads((sim_dir / "manifest.json").read_text())
    o = m["outages"][0]
    start, end = parse_iso(o["start"]), parse_iso(o["end"])
    beats = [json.loads(line) for line in (sim_dir / "inbound_cam_01" / "heartbeats.jsonl").read_text().splitlines()]
    assert not [b for b in beats if start <= parse_iso(b["sent_at_utc"]) < end]
    assert len(beats) == 1440 - 20
    backlog = [r for r in m["release_schedule"] if r["backlog"]]
    for r in backlog:
        assert parse_iso(r["release_at"]) >= end
        assert start <= parse_iso(r["timestamp_utc"]) < end
    # the first beat after the outage reports the queued uploads (late uploads may add to it);
    # the burst drains them by the next beat
    i = next(i for i, b in enumerate(beats) if parse_iso(b["sent_at_utc"]) >= end)
    assert beats[i]["pending_uploads"] >= len(backlog) > 0
    if beats[i]["pending_uploads"] >= 5:
        assert beats[i]["status"] == "degraded" and "backlog" in beats[i]["message"]
    assert beats[i + 1]["pending_uploads"] < beats[i]["pending_uploads"]


def test_lost_outage_drops_passes(tmp_path):
    from occsim.config import SimConfig
    from occsim.generate import parse_outage
    out = tmp_path / "o"
    o = parse_outage("inbound_cam_01@2026-10-13T07:00/2h:lost", SimConfig())
    res = run_generate(out, seed=5, outages=[o])
    lost = [p for p in res.passes if p.outcome == "lost_outage"]
    assert lost and all(p.camera_id == "inbound_cam_01" and o.covers(p.at) for p in lost)
