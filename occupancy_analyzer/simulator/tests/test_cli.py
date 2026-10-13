from __future__ import annotations

import json

from occsim.cli import main
from occsim.timeutil import parse_duration


def test_generate_cli_with_all_knobs(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("OCCSIM_CONFIG", str(tmp_path / "missing.yaml"))  # -> built-in defaults
    out = tmp_path / "sim"
    rc = main(["generate", "--start", "2026-10-13", "--days", "1", "--seed", "9", "--out", str(out),
               "--profile", "weekday", "--miss-rate-in", "0.05", "--miss-rate-out", "0.05",
               "--confusion-rate", "0.1", "--drop-edge-char-rate", "0.02", "--fragment-rate", "0.05",
               "--late-upload-rate", "0.02", "--late-upload-max", "2h", "--clock-skew-ms", "jetson-out-01=-800",
               "--overnight-rate", "0.05", "--outage", "outbound_cam_01@2026-10-13T12:00/15m:lost"])
    assert rc == 0
    assert "arrivals" in capsys.readouterr().out
    m = json.loads((out / "manifest.json").read_text())
    p = m["params"]
    assert p["noise"]["clock_skew_ms"] == {"jetson-out-01": -800}
    assert p["noise"]["late_upload_max"] == 7200
    assert m["outages"][0]["mode"] == "lost" and m["outages"][0]["start"].startswith("2026-10-13T16:00")
    assert main(["validate", str(out)]) == 0


def test_generate_refuses_foreign_nonempty_dir(tmp_path):
    (tmp_path / "keep.txt").write_text("x")
    assert main(["generate", "--start", "2026-10-13", "--out", str(tmp_path)]) == 2
    assert (tmp_path / "keep.txt").exists()


def test_parse_duration():
    assert parse_duration("3h").total_seconds() == 10800
    assert parse_duration("20m").total_seconds() == 1200
    assert parse_duration("1h30m").total_seconds() == 5400
    assert parse_duration("250ms").total_seconds() == 0.25
    assert parse_duration("-2s").total_seconds() == -2
    assert parse_duration(90).total_seconds() == 90


def test_replay_dry_run_cli(tmp_path, capsys):
    out = tmp_path / "s"
    assert main(["scenario", "run", "bounce", "--out", str(out)]) == 0
    assert main(["replay", str(out), "--dry-run", "--fast", "--no-heartbeats"]) == 0
    assert '"events": 2' in capsys.readouterr().out


def test_hosted_replay_requires_yes(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "x")
    monkeypatch.setattr("occsim.config.REPO_ENV_PATH", tmp_path / "none.env")
    out = tmp_path / "s"
    main(["scenario", "run", "bounce", "--out", str(out)])
    try:
        main(["replay", str(out), "--target", "hosted", "--fast"])
    except SystemExit as e:
        assert e.code == 2
    else:  # pragma: no cover
        raise AssertionError("expected refusal")
