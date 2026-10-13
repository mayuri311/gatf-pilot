"""
Unit tests for the producer's wire contracts (event v2, heartbeat v1).

No cv2 / fast_alpr / ultralytics / supabase needed - the supabase client is
stubbed. Run from the repo root:
    uv run --with pytest --with pyyaml --with python-dotenv pytest scripts/tests -q
"""

import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from scripts import contract_v2 as c
from scripts.heartbeat import HeartbeatSender, make_send_fn, offline_heartbeat_path

REPO = Path(__file__).resolve().parents[2]
SAMPLES = REPO / "plan" / "samples"
EVENT_SAMPLE = json.loads((SAMPLES / "event.v2.json").read_text())
HB_SAMPLE = json.loads((SAMPLES / "heartbeat.v1.json").read_text())
LEGACY_EVENT = REPO / "output_template" / "20260814T142447042426Z_plate_track73" / "event.json"

T0 = datetime(2026, 8, 14, 14, 24, 40, tzinfo=timezone.utc)


def assert_same_types(actual, sample):
    """Every sample key is present with a compatible JSON type (sample nulls
    accept null or string; ints count as numbers where the sample has a float)."""
    for key, ref in sample.items():
        assert key in actual, key
        val = actual[key]
        if ref is None:
            assert val is None or isinstance(val, str), key
        elif isinstance(ref, bool):
            assert isinstance(val, bool), key
        elif isinstance(ref, float):
            assert isinstance(val, (int, float)) and not isinstance(val, bool), key
        else:
            assert isinstance(val, type(ref)), (key, type(val), type(ref))


def make_readings():
    texts = ["", "Z54PWE", "Z94PVE", "Z94PVE", "1_1"]
    out = []
    for i, text in enumerate(texts):
        out.append({
            "frame_index": 100 + i,
            "text": text,
            "confidence": 0.9 if text else None,
            "confidence_per_char": None,
            "detection_confidence": 0.8,
            "bounding_box": {"x1": 10 + i, "y1": 20, "x2": 60 + i, "y2": 40},
            "captured_at_utc": T0 + timedelta(seconds=i / 30),
        })
    return out


def make_payload(**overrides):
    readings = make_readings()
    consensus = {
        "plate_text": "Z94PVE",
        "plate_confidence": 0.93,
        "plate_confidence_per_char": [0.9, 0.95, 0.9, 0.95, 0.9, 0.98],
        "representative": readings[3],
        "num_frames_used_for_consensus": 3,
    }
    kwargs = dict(
        event_id="1c72cbed-d005-4498-b09c-f786374757fc",
        finalized_at=T0 + timedelta(seconds=5),
        camera_id="inbound_cam_01",
        device_id="jetson-in-01",
        source="rtsp://root:s3cr3t@192.168.1.64/axis-media/media.amp",
        track_id=73,
        readings=readings,
        consensus=consensus,
        image_filename="plate.jpg",
    )
    kwargs.update(overrides)
    return c.build_event_payload(**kwargs)


# --- event v2 ----------------------------------------------------------------

def test_event_payload_matches_sample_shape():
    payload = make_payload()
    # exactly the sample's keys, plus the two local-only audit fields
    assert set(payload) == set(EVENT_SAMPLE) | {"rejected", "rejection_reason"}
    assert_same_types(payload, EVENT_SAMPLE)
    # same leading key order as the contract sample (readability of event.json)
    assert list(payload)[:8] == list(EVENT_SAMPLE)[:8]
    assert payload["schema_version"] == 2
    assert payload["event_type"] == "plate_track_finalized"
    assert set(payload["reads"][0]) == set(EVENT_SAMPLE["reads"][0])
    assert set(payload["plate_bounding_box"]) == {"x1", "y1", "x2", "y2"}
    json.dumps(payload)  # must be JSON-serializable as-is


def test_event_payload_times_and_counters():
    payload = make_payload()
    # captured_at = the representative frame's capture time, not finalize time
    assert payload["captured_at_utc"] == (T0 + timedelta(seconds=3 / 30)).isoformat()
    assert payload["timestamp_utc"] == "2026-08-14T14:24:45.000000+00:00"
    assert c.parse_utc(payload["captured_at_utc"]) < c.parse_utc(payload["timestamp_utc"])
    assert payload["representative_frame_index"] == 103
    assert (payload["frame_first"], payload["frame_last"]) == (100, 104)
    assert payload["num_frames_tracked"] == 5
    assert payload["num_frames_with_text"] == 4
    assert [r["clean"] for r in payload["reads"]] == [False, True, True, True, False]
    assert payload["rejected"] is False and payload["rejection_reason"] is None


def test_event_payload_strips_credentials():
    payload = make_payload()
    assert payload["source"] == "rtsp://192.168.1.64/axis-media/media.amp"
    assert "s3cr3t" not in json.dumps(payload)


def test_event_payload_falls_back_to_finalize_time_without_capture_time():
    readings = make_readings()
    for r in readings:
        r["captured_at_utc"] = None
    payload = make_payload(readings=readings, consensus={
        "plate_text": "Z94PVE", "plate_confidence": 0.9,
        "plate_confidence_per_char": [0.9] * 6, "representative": readings[2],
        "num_frames_used_for_consensus": 2,
    })
    assert payload["captured_at_utc"] == payload["timestamp_utc"]


def test_sample_keys_are_all_upload_columns():
    assert set(EVENT_SAMPLE) - {"image_filename"} <= set(c.EVENT_COLUMNS)


def test_filter_event_columns_whitelist():
    payload = make_payload(rejected=False)
    payload["vehicle_class"] = "car"  # some stray key
    row = c.filter_event_columns(payload, "abc.jpg")
    assert set(row) <= set(c.EVENT_COLUMNS)
    assert row["image_path"] == "abc.jpg"
    for dropped in ("image_filename", "rejected", "rejection_reason", "vehicle_class"):
        assert dropped not in row
    # every contract column the producer writes survives
    assert set(row) == set(c.EVENT_COLUMNS)


def test_filter_event_columns_redacts_legacy_source():
    row = c.filter_event_columns({"source": "rtsp://u:p@cam/x", "event_id": "e"}, "e.jpg")
    assert row["source"] == "rtsp://cam/x"


@pytest.mark.parametrize("mutate, expect", [
    (lambda p: None, None),
    (lambda p: p.pop("schema_version"), "schema_version"),
    (lambda p: p.update(schema_version=1), "schema_version"),
    (lambda p: p.pop("camera_id"), "camera_id"),
    (lambda p: p.update(camera_id=""), "camera_id"),
    (lambda p: p.update(event_type="entry"), "event_type"),
    (lambda p: p.update(rejected=True, rejection_reason="too_short"), "rejected"),
])
def test_event_upload_problem(mutate, expect):
    payload = make_payload()
    mutate(payload)
    problem = c.event_upload_problem(payload)
    if expect is None:
        assert problem is None
    else:
        assert problem and expect in problem


def test_backfill_legacy_event():
    legacy = json.loads(LEGACY_EVENT.read_text())
    legacy.pop("camera_id", None)  # older files had none at all
    assert c.event_upload_problem(legacy)
    out, filled = c.backfill_legacy_event(legacy, camera_id="outbound_cam_01", device_id="jetson-out-01")
    assert set(filled) == {"schema_version", "camera_id", "device_id", "captured_at_utc"}
    assert out["captured_at_utc"] == legacy["timestamp_utc"]
    assert c.event_upload_problem(out) is None
    assert "schema_version" not in legacy  # input untouched


def test_backfill_never_overrides_existing_values():
    payload = make_payload()
    out, filled = c.backfill_legacy_event(payload, camera_id="outbound_cam_01", device_id="x")
    assert filled == [] and out["camera_id"] == "inbound_cam_01"


def test_backfill_ignores_vehicle_events():
    out, filled = c.backfill_legacy_event({"event_type": "entry"}, camera_id="inbound_cam_01")
    assert filled == [] and c.event_upload_problem(out)


# --- source / time helpers -----------------------------------------------------

@pytest.mark.parametrize("src, expect", [
    ("rtsp://user:pass@192.168.1.64/axis-media/media.amp", "rtsp://192.168.1.64/axis-media/media.amp"),
    ("rtsp://user:pass@cam.local:554/axis-media/media.amp?resolution=1080p",
     "rtsp://cam.local:554/axis-media/media.amp?resolution=1080p"),
    ("rtsp://root:p@ss@w0rd@10.0.0.5/stream", "rtsp://10.0.0.5/stream"),
    ("rtsp://useronly@cam/x", "rtsp://cam/x"),
    ("http://admin:admin@cam/mjpg", "http://cam/mjpg"),
    ("rtsp://inbound-cam.local/axis-media/media.amp", "rtsp://inbound-cam.local/axis-media/media.amp"),
    ("camera_captures/capture_20260813_205719.mp4", "camera_captures/capture_20260813_205719.mp4"),
    (0, "0"),
    (None, None),
])
def test_redact_source(src, expect):
    assert c.redact_source(src) == expect


@pytest.mark.parametrize("src, live", [
    ("rtsp://cam/x", True), ("http://cam/x", True), (0, True), ("1", True),
    ("capture.mp4", False), ("/abs/path/capture.mp4", False),
])
def test_is_live_source(src, live):
    assert c.is_live_source(src) is live


def test_captured_at_for_file_with_start_time():
    got = c.captured_at_for(300, grabbed_at_utc=T0 + timedelta(hours=5),
                            source_start_utc="2026-08-14T00:57:19Z", fps=30.0)
    assert got == datetime(2026, 8, 14, 0, 57, 29, tzinfo=timezone.utc)


def test_captured_at_for_falls_back_to_wall_clock():
    assert c.captured_at_for(300, T0) == T0
    assert c.captured_at_for(300, T0, source_start_utc=T0 - timedelta(days=1), fps=None) == T0
    assert c.captured_at_for(300, T0, source_start_utc=T0 - timedelta(days=1), fps=0) == T0


def test_parse_and_format_utc():
    assert c.parse_utc("2026-08-14T14:24:42Z") == datetime(2026, 8, 14, 14, 24, 42, tzinfo=timezone.utc)
    assert c.parse_utc("2026-08-14T10:24:42-04:00").hour == 14
    assert c.parse_utc("2026-08-14T14:24:42").tzinfo is not None
    assert c.iso_utc(T0) == "2026-08-14T14:24:40.000000+00:00"
    assert c.iso_utc(None) is None


# --- config helpers ------------------------------------------------------------

CONFIG = {
    "cameras": [
        {"camera_id": "inbound_cam_01", "direction": "in", "device_id": "jetson-in-01"},
        {"camera_id": "outbound_cam_01", "direction": "out", "device_id": "jetson-out-01"},
    ],
    "heartbeat": {"interval_s": 45},
}


def test_resolve_ids():
    assert c.resolve_device_id(CONFIG, "outbound_cam_01") == "jetson-out-01"
    assert c.resolve_device_id(CONFIG, "outbound_cam_01", "override") == "override"
    assert c.resolve_device_id(CONFIG, "unknown_cam", hostname="box") == "box"
    assert c.resolve_camera_id(CONFIG, "inbound_cam_01") == "inbound_cam_01"
    assert c.resolve_camera_id(CONFIG, None, device_id="jetson-out-01") == "outbound_cam_01"
    assert c.resolve_camera_id(CONFIG, None, hostname="jetson-in-01") == "inbound_cam_01"
    assert c.resolve_camera_id(CONFIG, None, hostname="my-laptop") is None
    assert c.resolve_camera_id({}, None, hostname="jetson-in-01") is None


def test_heartbeat_interval():
    assert c.heartbeat_interval_s(CONFIG) == 45
    assert c.heartbeat_interval_s({}) == 60
    assert c.heartbeat_interval_s({"heartbeat": {"interval_s": "bad"}}) == 60


def test_repo_config_resolves_both_cameras():
    config = c.load_config()  # repo-root config/config.yaml
    if not config:
        pytest.skip("config/config.yaml not present")
    assert c.resolve_device_id(config, "inbound_cam_01") == "jetson-in-01"
    assert c.resolve_device_id(config, "outbound_cam_01") == "jetson-out-01"
    assert c.heartbeat_interval_s(config) == 60


def test_load_config_missing_file(tmp_path):
    assert c.load_config(tmp_path / "nope.yaml") == {}


# --- heartbeat v1 --------------------------------------------------------------

def hb(**overrides):
    kwargs = dict(device_id="jetson-in-01", camera_id="inbound_cam_01", sent_at=T0,
                  fps=29.7, nominal_fps=30.0, last_event_at=T0 - timedelta(seconds=13),
                  pending_uploads=0, uptime_s=86400.4, seconds_since_last_frame=0.03)
    kwargs.update(overrides)
    return c.build_heartbeat(**kwargs)


def test_heartbeat_matches_sample_shape():
    payload = hb()
    assert set(payload) == set(HB_SAMPLE)
    assert list(payload) == list(HB_SAMPLE)
    assert_same_types(payload, HB_SAMPLE)
    assert payload["schema_version"] == 1 and payload["type"] == "heartbeat"
    assert payload["status"] == "ok" and payload["camera_connected"] is True
    assert payload["message"] is None
    assert payload["uptime_s"] == 86400 and isinstance(payload["uptime_s"], int)
    assert payload["app_version"] == c.APP_VERSION
    assert payload["sent_at_utc"] == "2026-08-14T14:24:40.000000+00:00"
    json.dumps(payload)


def test_heartbeat_no_event_yet():
    assert hb(last_event_at=None)["last_event_at_utc"] is None


@pytest.mark.parametrize("overrides, status, connected", [
    ({}, "ok", True),
    ({"fps": 14.0}, "degraded", True),            # < 50 % of nominal 30
    ({"fps": 15.0}, "ok", True),                  # exactly 50 % is fine
    ({"fps": 3.0, "nominal_fps": None}, "ok", True),  # unknown nominal: no fps rule
    ({"pending_uploads": 51}, "degraded", True),
    ({"pending_uploads": 50}, "ok", True),
    ({"seconds_since_last_frame": 10.5}, "error", False),
    ({"seconds_since_last_frame": None}, "error", False),
    ({"seconds_since_last_frame": 30, "pending_uploads": 99}, "error", False),
    ({"stream_open": False}, "ok", False),
])
def test_heartbeat_status_rules(overrides, status, connected):
    payload = hb(**overrides)
    assert payload["status"] == status
    assert payload["camera_connected"] is connected


def test_heartbeat_messages():
    assert hb(seconds_since_last_frame=42)["message"] == "no frames for 42 s"
    assert hb(pending_uploads=80)["message"] == "upload backlog 80"
    assert "low fps" in hb(fps=5.0)["message"]
    reconnecting = hb(seconds_since_last_frame=42, stream_open=False, message="rtsp reconnecting")
    assert reconnecting["message"] == "rtsp reconnecting"
    assert reconnecting["status"] == "error"


def test_count_pending_uploads(tmp_path):
    events = tmp_path / "events"
    for name, uploaded in [("a", True), ("b", False), ("c", False)]:
        (events / name).mkdir(parents=True)
        if uploaded:
            (events / name / c.UPLOADED_MARKER).touch()
    (events / "stray.txt").write_text("x")
    assert c.count_pending_uploads(events) == 2
    assert c.count_pending_uploads(tmp_path / "missing") == 0


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_heartbeat_sender_fps_and_events(tmp_path):
    sent = []
    clock = FakeClock()
    sender = HeartbeatSender("jetson-in-01", "inbound_cam_01", tmp_path / "events",
                             interval_s=60, send_fn=sent.append, nominal_fps=30.0, clock=clock)
    sender.set_stream_state(True)
    for _ in range(600):
        sender.note_frame()
    sender.note_event(T0)
    clock.t += 20
    first = sender.send_once()
    assert first is sent[0]
    assert first["fps"] == 30.0
    assert first["last_event_at_utc"] == c.iso_utc(T0)
    assert first["uptime_s"] == 20
    # the fps window resets every beat; no frames for 20 s since -> error
    clock.t += 20
    second = sender.send_once()
    assert second["fps"] == 0.0 and second["status"] == "error"
    assert second["camera_connected"] is False


def test_heartbeat_sender_startup_grace(tmp_path):
    clock = FakeClock()
    sender = HeartbeatSender("d", "inbound_cam_01", tmp_path, send_fn=lambda hb: None,
                             nominal_fps=None, clock=clock)
    clock.t += 5  # no frame yet, but still within the 10 s grace from start
    assert sender.build()["status"] == "ok"
    clock.t += 10
    assert sender.build()["status"] == "error"


def test_heartbeat_sender_swallows_send_errors(tmp_path, capsys):
    def boom(hb):
        raise ConnectionError("network down")
    sender = HeartbeatSender("d", "inbound_cam_01", tmp_path, send_fn=boom)
    assert sender.send_once() is None
    assert "network down" in capsys.readouterr().out


def test_offline_mode_writes_jsonl(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    events = tmp_path / "events"
    events.mkdir()
    send_fn, dest = make_send_fn(events)
    assert dest == str(tmp_path.resolve() / "heartbeats.jsonl")
    assert offline_heartbeat_path(events) == tmp_path.resolve() / "heartbeats.jsonl"
    sender = HeartbeatSender("d", "inbound_cam_01", events, send_fn=send_fn)
    sender.send_once()
    sender.send_once()
    lines = (tmp_path / "heartbeats.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert set(json.loads(lines[0])) == set(HB_SAMPLE)


# --- supabase_sync (client stubbed) ----------------------------------------------

class FakeQuery:
    def __init__(self, log, kind, arg):
        self.log, self.kind, self.arg = log, kind, arg

    def execute(self):
        self.log.append((self.kind, self.arg))
        return types.SimpleNamespace(data={"ok": True})


class FakeClient:
    def __init__(self):
        self.log = []
        outer = self

        class Bucket:
            def upload(self, path, data, opts):
                outer.log.append(("storage", path, opts))

        class Storage:
            def from_(self, bucket):
                outer.log.append(("bucket", bucket))
                return Bucket()

        class Table:
            def upsert(self, row):
                return FakeQuery(outer.log, "upsert", row)

        self.storage = Storage()
        self._table = Table()

    def table(self, name):
        assert name == "events"
        return self._table

    def rpc(self, fn, params):
        return FakeQuery(self.log, ("rpc", fn), params)


@pytest.fixture
def sync(monkeypatch):
    """scripts.supabase_sync imported against a stub `supabase` package, with
    get_client() returning a FakeClient."""
    monkeypatch.setitem(sys.modules, "supabase",
                        types.SimpleNamespace(create_client=lambda *a, **k: None))
    sys.modules.pop("scripts.supabase_sync", None)
    import scripts.supabase_sync as mod
    client = FakeClient()
    monkeypatch.setattr(mod, "get_client", lambda: client)
    mod.fake = client
    yield mod
    sys.modules.pop("scripts.supabase_sync", None)


def write_event(folder, payload):
    folder.mkdir(parents=True)
    (folder / "event.json").write_text(json.dumps(payload))
    (folder / "plate.jpg").write_bytes(b"\xff\xd8fakejpeg")
    return folder


def test_upload_event_sends_only_contract_columns(sync, tmp_path):
    payload = make_payload()
    folder = write_event(tmp_path / "ev1", payload)
    assert sync.upload_event(folder) is True
    upserts = [e for e in sync.fake.log if e[0] == "upsert"]
    assert len(upserts) == 1
    row = upserts[0][1]
    assert set(row) <= set(c.EVENT_COLUMNS)
    assert row["image_path"] == f"{payload['event_id']}.jpg"
    assert "rejected" not in row and "image_filename" not in row
    assert ("storage", f"{payload['event_id']}.jpg",
            {"content-type": "image/jpeg", "upsert": "true"}) in sync.fake.log
    assert (folder / c.UPLOADED_MARKER).exists()
    # idempotent: second call is a no-op
    assert sync.upload_event(folder) is False
    assert len([e for e in sync.fake.log if e[0] == "upsert"]) == 1


def test_upload_event_skips_non_v2(sync, tmp_path, capsys):
    legacy = json.loads(LEGACY_EVENT.read_text())
    folder = write_event(tmp_path / "old", legacy)
    assert sync.upload_event(folder) is False
    assert sync.fake.log == []
    assert not (folder / c.UPLOADED_MARKER).exists()
    assert "upload skipped" in capsys.readouterr().out


def test_upload_event_backfills_with_defaults(sync, tmp_path, capsys):
    legacy = json.loads(LEGACY_EVENT.read_text())
    legacy.pop("camera_id", None)
    folder = write_event(tmp_path / "old", legacy)
    defaults = {"camera_id": "inbound_cam_01", "device_id": "jetson-in-01"}
    assert sync.upload_event(folder, defaults=defaults) is True
    row = [e for e in sync.fake.log if e[0] == "upsert"][0][1]
    assert row["schema_version"] == 2
    assert row["camera_id"] == "inbound_cam_01" and row["device_id"] == "jetson-in-01"
    assert row["captured_at_utc"] == legacy["timestamp_utc"]
    assert "[warn]" in capsys.readouterr().out
    # the local file itself is left untouched
    assert "schema_version" not in json.loads((folder / "event.json").read_text())


def test_upload_event_never_uploads_rejected(sync, tmp_path):
    folder = write_event(tmp_path / "rej", make_payload(rejected=True, rejection_reason="too_short"))
    assert sync.upload_event(folder) is False
    assert sync.fake.log == []


def test_send_heartbeat_calls_rpc(sync):
    payload = hb()
    sync.send_heartbeat(payload)
    assert sync.fake.log == [(("rpc", "report_heartbeat"), {"hb": payload})]
