"""Replay against an httpx.MockTransport fake of Supabase (no network)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import httpx
import pytest

from occsim.config import SimConfig
from occsim.contract import EVENT_DB_COLUMNS
from occsim.replay import (ReplayError, ReplayOptions, Replayer, SupabaseREST, make_client, rebase_offset,
                           resolve_target)
from occsim.scenario import build_scenario, load_scenario
from occsim.timeutil import UTC, parse_iso
from occsim.writer import write_result


class FakeSupabase:
    def __init__(self, fail_first: int = 0):
        self.calls: list[httpx.Request] = []
        self.fail_first = fail_first
        self.passes = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        if self.fail_first:
            self.fail_first -= 1
            return httpx.Response(503, text="busy")
        path = req.url.path
        if path.startswith("/storage/v1/object/"):
            return httpx.Response(200, json={"Key": path})
        if path == "/rest/v1/events":
            return httpx.Response(201)
        if path == "/rest/v1/rpc/report_heartbeat":
            return httpx.Response(200, json={"ok": True})
        if path == "/rest/v1/rpc/reconcile_preview":
            body = json.loads(req.content)
            return httpx.Response(200, json={"to_close_count": 11, "visual_count": body["p_visual_count"],
                                             "proposed": [{"session_id": f"s{i}"} for i in range(12)]})
        if path == "/rest/v1/rpc/reconcile_commit":
            return httpx.Response(200, json={"residual": 6, "closed": len(json.loads(req.content)["p_close"])})
        if path == "/rest/v1/passes":
            d = req.url.params["direction"].removeprefix("eq.")
            return httpx.Response(200, json=[{"pass_id": f"pass-{d}", "event_at": "x"}])
        if path == "/rest/v1/rpc/resolve_match":
            return httpx.Response(200, json={"ok": True})
        if path in ("/rest/v1/lots", "/rest/v1/lot_capacity_history"):
            return httpx.Response(204)
        return httpx.Response(404, text=f"no route {path}")

    def paths(self):
        return [c.url.path for c in self.calls]


class Clock:
    def __init__(self, start: datetime):
        self.t = start
        self.slept = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept += s
        self.t += timedelta(seconds=s)


def api_for(fake, sleep=lambda s: None):
    client = make_client("http://fake:54321", "service-key", transport=httpx.MockTransport(fake))
    return SupabaseREST(client, sleep=sleep)


@pytest.fixture
def scen_dir(tmp_path):
    def _make(name):
        out = tmp_path / name
        write_result(build_scenario(load_scenario(name), SimConfig()), out)
        return out
    return _make


def test_fast_replay_uploads_image_then_row(scen_dir):
    d = scen_dir("happy_path")
    fake = FakeSupabase()
    stats = Replayer(d, api_for(fake), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    assert stats["events"] == 6 and stats["errors"] == 0
    paths = fake.paths()
    assert len(paths) == 12
    for i in range(0, 12, 2):
        assert paths[i].startswith("/storage/v1/object/event-snapshots/") and paths[i].endswith(".jpg")
        assert paths[i + 1] == "/rest/v1/events"
    img, row = fake.calls[0], fake.calls[1]
    assert img.headers["x-upsert"] == "true" and img.headers["content-type"] == "image/jpeg"
    assert img.headers["apikey"] == "service-key" and img.headers["authorization"] == "Bearer service-key"
    assert row.url.params["on_conflict"] == "event_id"
    assert "resolution=merge-duplicates" in row.headers["prefer"]
    body = json.loads(row.content)
    assert set(body) <= set(EVENT_DB_COLUMNS) and "image_filename" not in body
    assert img.url.path.endswith(body["image_path"])
    # captured order
    caps = [json.loads(c.content)["captured_at_utc"] for c in fake.calls if c.url.path == "/rest/v1/events"]
    assert caps == sorted(caps)


def test_heartbeats_sent_via_rpc(scen_dir):
    d = scen_dir("heartbeat_offline_online")
    fake = FakeSupabase()
    stats = Replayer(d, api_for(fake), ReplayOptions(fast=True), log=lambda m: None).run()
    assert stats["heartbeats"] == 74
    hb_calls = [c for c in fake.calls if c.url.path == "/rest/v1/rpc/report_heartbeat"]
    body = json.loads(hb_calls[0].content)
    assert set(body) == {"hb"} and body["hb"]["type"] == "heartbeat"
    times = [json.loads(c.content)["hb"]["sent_at_utc"] for c in hb_calls]
    assert times == sorted(times)
    # events are interleaved at their release time, not batched at the end
    paths = fake.paths()
    first_event = paths.index("/rest/v1/events")
    assert 0 < first_event < len(paths) - 10


def test_late_event_is_sent_after_later_captures(scen_dir):
    d = scen_dir("late_arrival")
    fake = FakeSupabase()
    Replayer(d, api_for(fake), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    plates = [json.loads(c.content)["plate_text"] for c in fake.calls if c.url.path == "/rest/v1/events"]
    assert plates == ["PXR3318", "DWT6042", "DWT6042", "PXR3318"]


def test_duplicate_delivery_sends_same_event_id_twice(scen_dir):
    d = scen_dir("duplicate_delivery")
    fake = FakeSupabase()
    Replayer(d, api_for(fake), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    ids = [json.loads(c.content)["event_id"] for c in fake.calls if c.url.path == "/rest/v1/events"]
    assert len(ids) == 3 and len(set(ids)) == 2


def test_speed_pacing(scen_dir):
    d = scen_dir("happy_path")
    clock = Clock(datetime(2026, 10, 12, tzinfo=UTC))
    Replayer(d, api_for(FakeSupabase()), ReplayOptions(speed=60, heartbeats=False),
             now=clock.now, sleep=clock.sleep, log=lambda m: None).run()
    # first entry 08:00:03 finalize, last exit release 17:02:4x -> ~9.04 sim hours / 60
    assert 9.0 * 60 <= clock.slept <= 9.1 * 60


def test_rebase_now_shifts_and_paces_in_real_time(scen_dir):
    d = scen_dir("ocr_near_miss")
    now = datetime(2026, 10, 20, 15, 0, 30, tzinfo=UTC)
    clock = Clock(now)
    fake = FakeSupabase()
    sent_at_wall = []
    orig = fake.__call__

    def recording(req):
        if req.url.path == "/rest/v1/events":
            sent_at_wall.append(clock.now())
        return orig(req)
    stats = Replayer(d, api_for(recording), ReplayOptions(rebase_lead=timedelta(hours=1)),
                     now=clock.now, sleep=clock.sleep, log=lambda m: None).run()
    evs = [json.loads(c.content) for c in fake.calls if c.url.path == "/rest/v1/events"]
    first = parse_iso(evs[0]["captured_at_utc"])
    assert now - timedelta(hours=1, minutes=1) < first <= now - timedelta(hours=1)
    # exit was 2h15m after the entry; it is due ~1h15m after now -> replay waited in real time
    assert parse_iso(evs[1]["captured_at_utc"]) - first == timedelta(hours=2, minutes=15)
    assert sent_at_wall[0] == now  # already in the past -> sent immediately
    assert timedelta(hours=1, minutes=14) < sent_at_wall[1] - now < timedelta(hours=1, minutes=17)
    assert parse_iso(evs[1]["timestamp_utc"]) <= sent_at_wall[1]  # never sent before its finalize time
    # heartbeats already older than 5 minutes at start were skipped, not replayed; the
    # rest of the simulated day's heartbeats are paced in real time
    assert stats["heartbeats_skipped_stale"] > 0
    hb = [json.loads(c.content)["hb"] for c in fake.calls if c.url.path.endswith("report_heartbeat")]
    assert all(parse_iso(h["sent_at_utc"]) >= now - timedelta(minutes=5) for h in hb)
    m = json.loads((d / "manifest.json").read_text())
    off = m["rebase"]["offset_seconds"]
    assert off % 60 == 0 and off > 0
    assert parse_iso(evs[0]["captured_at_utc"]) - timedelta(seconds=off) == parse_iso(
        m["release_schedule"][0]["captured_at_utc"])


def test_rebase_offset_floor_minute():
    manifest = {"release_schedule": [{"captured_at_utc": "2026-10-13T12:00:00.500000+00:00"}],
                "time_range": {"start_utc": "2026-10-13T04:00:00+00:00"}}
    off = rebase_offset(manifest, datetime(2026, 10, 20, 9, 30, 45, tzinfo=UTC), timedelta(0))
    assert off.total_seconds() % 60 == 0
    assert parse_iso("2026-10-13T12:00:00.500000+00:00") + off <= datetime(2026, 10, 20, 9, 30, 45, tzinfo=UTC)


def test_new_ids_remaps_event_and_image(scen_dir):
    d = scen_dir("bounce")
    fake = FakeSupabase()
    Replayer(d, api_for(fake), ReplayOptions(fast=True, heartbeats=False, new_ids=True), log=lambda m: None).run()
    original = {r["event_id"] for r in json.loads((d / "manifest.json").read_text())["release_schedule"]}
    rows = [json.loads(c.content) for c in fake.calls if c.url.path == "/rest/v1/events"]
    assert not {r["event_id"] for r in rows} & original
    assert all(r["image_path"] == f"{r['event_id']}.jpg" for r in rows)


def test_shuffle_changes_order_but_not_rows(scen_dir):
    d = scen_dir("happy_path")
    a, b = FakeSupabase(), FakeSupabase()
    Replayer(d, api_for(a), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    Replayer(d, api_for(b), ReplayOptions(fast=True, heartbeats=False, shuffle_seed=3), log=lambda m: None).run()
    ra = [c.content for c in a.calls if c.url.path == "/rest/v1/events"]
    rb = [c.content for c in b.calls if c.url.path == "/rest/v1/events"]
    assert sorted(ra) == sorted(rb) and ra != rb


def test_reconcile_action(scen_dir):
    d = scen_dir("admin_reconciliation")
    fake = FakeSupabase()
    stats = Replayer(d, api_for(fake), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    assert stats["actions"] == 1 and stats["errors"] == 0
    assert fake.paths()[-2:] == ["/rest/v1/rpc/reconcile_preview", "/rest/v1/rpc/reconcile_commit"]
    commit = json.loads(fake.calls[-1].content)
    assert commit["p_lot"] == "gatf_main" and commit["p_visual_count"] == 41
    assert commit["p_close"] == [f"s{i}" for i in range(11)]


def test_resolve_match_and_capacity_actions(scen_dir):
    fake = FakeSupabase()
    Replayer(scen_dir("staff_override_survives"), api_for(fake), ReplayOptions(fast=True, heartbeats=False),
             log=lambda m: None).run()
    rm = [c for c in fake.calls if c.url.path == "/rest/v1/rpc/resolve_match"][0]
    assert json.loads(rm.content) == {"p_exit_pass": "pass-out", "p_entry_pass": "pass-in",
                                      "p_note": "scenario 13 manual pair"}
    # the resolve happens before the late event (released 12:00) is delivered
    order = [c.url.path for c in fake.calls if c.url.path in ("/rest/v1/rpc/resolve_match", "/rest/v1/events")]
    assert order == ["/rest/v1/events", "/rest/v1/events", "/rest/v1/rpc/resolve_match", "/rest/v1/events"]

    fake = FakeSupabase()
    Replayer(scen_dir("capacity_change"), api_for(fake), ReplayOptions(fast=True, heartbeats=False),
             log=lambda m: None).run()
    patch = [c for c in fake.calls if c.url.path == "/rest/v1/lots"][0]
    assert patch.method == "PATCH" and json.loads(patch.content) == {"capacity": 120}
    hist = json.loads([c for c in fake.calls if c.url.path == "/rest/v1/lot_capacity_history"][0].content)
    assert hist["capacity"] == 120 and hist["lot_id"] == "gatf_main"


def test_retries_5xx_then_succeeds(scen_dir):
    d = scen_dir("bounce")
    fake = FakeSupabase(fail_first=2)
    stats = Replayer(d, api_for(fake), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    assert stats["errors"] == 0 and stats["events"] == 2


def test_4xx_counted_as_error_and_continues(scen_dir):
    d = scen_dir("bounce")

    def handler(req):
        return httpx.Response(400, text="bad") if req.url.path == "/rest/v1/events" else httpx.Response(200, json={})
    stats = Replayer(d, api_for(handler), ReplayOptions(fast=True, heartbeats=False), log=lambda m: None).run()
    assert stats["errors"] == 2


def test_dry_run_makes_no_calls_and_keeps_manifest(scen_dir):
    d = scen_dir("happy_path")
    before = (d / "manifest.json").read_text()
    stats = Replayer(d, None, ReplayOptions(fast=True, dry_run=True), log=lambda m: None).run()
    assert stats["events"] == 6
    assert (d / "manifest.json").read_text() == before


def test_resolve_target(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("LOCAL_SERVICE_ROLE_KEY", "local-key")
    assert resolve_target("local") == ("http://127.0.0.1:54321", "local-key")
    assert resolve_target("local", key="k2") == ("http://127.0.0.1:54321", "k2")
    monkeypatch.delenv("LOCAL_SERVICE_ROLE_KEY")
    with pytest.raises(ReplayError):
        resolve_target("local")
