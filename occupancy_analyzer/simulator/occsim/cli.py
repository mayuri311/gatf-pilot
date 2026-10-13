"""occsim CLI: generate | scenario list|run | replay | evaluate | validate."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

from .config import load_config
from .timeutil import parse_duration


def _add_config(p: argparse.ArgumentParser) -> None:
    p.add_argument("--config", "--capacity-from", dest="config", default=None,
                   help="config.yaml (default: repo-root config/config.yaml, or $OCCSIM_CONFIG)")


# --------------------------------------------------------------------------- generate


def cmd_generate(a) -> int:
    from .camera import NoiseParams
    from .generate import generate, parse_outage, parse_skews
    from .world import WorldParams
    from .writer import write_result

    cfg = load_config(a.config)
    if a.capacity:
        cfg.capacity = a.capacity
    wp = WorldParams(start=date.fromisoformat(a.start), days=a.days, seed=a.seed, profile=a.profile,
                     arrivals_per_day=a.arrivals_per_day, weekend_factor=a.weekend_factor,
                     regulars_share=a.regulars_share, regulars_pool=a.regulars_pool,
                     close_follow_rate=a.close_follow_rate, overnight_rate=a.overnight_rate)
    noise = NoiseParams(miss_rate_in=a.miss_rate_in, miss_rate_out=a.miss_rate_out,
                        confusion_rate=a.confusion_rate, drop_edge_char_rate=a.drop_edge_char_rate,
                        fragment_rate=a.fragment_rate, late_upload_rate=a.late_upload_rate,
                        late_upload_max=parse_duration(a.late_upload_max),
                        clock_skew_ms=parse_skews(a.clock_skew_ms, cfg), min_plate_chars=a.min_plate_chars)
    outages = [parse_outage(s, cfg) for s in a.outage or []]
    res = generate(cfg, wp, noise, outages)
    out = write_result(res, a.out, force=a.force)
    c = json.loads((out / "manifest.json").read_text())["counts"]
    w = c["world"]
    print(f"wrote {out}")
    print(f"  arrivals {w['arrivals']} (bounces {w['bounces']}, regulars {w['regular_arrivals']}, "
          f"peak occupancy {w['peak_occupancy']}/{cfg.capacity}, still parked at end {w['still_present_at_end']})")
    print(f"  true passes in/out {c['true_passes']['in']}/{c['true_passes']['out']}; "
          f"events {c['events_total']} {c['events_per_camera']}; heartbeats {c['heartbeats_per_camera']}")
    print(f"  imperfections {json.dumps(c['imperfections'], sort_keys=True)}")
    return 0


# --------------------------------------------------------------------------- scenario


def cmd_scenario(a) -> int:
    from .scenario import build_scenario, list_scenarios, load_scenario
    from .writer import write_result

    if a.scenario_cmd == "list":
        for s in list_scenarios():
            print(f"{s['id']!s:>3}  {s['name']:<26} {s['mode']:<12} {s['title']}")
        return 0
    names = [s["name"] for s in list_scenarios()] if a.name == "all" else [a.name]
    override = date.fromisoformat(a.date) if a.date else None
    for name in names:
        cfg = load_config(a.config, quiet=len(names) > 1)
        sc = load_scenario(name)
        res = build_scenario(sc, cfg, date_override=override)
        out = Path(a.out) / sc["name"] if a.name == "all" else Path(a.out)
        write_result(res, out, force=a.force)
        print(f"{sc['name']}: {len(res.events)} events, {len(res.passes)} true passes, "
              f"{len(res.actions)} actions [{res.scenario['mode']}] -> {out}")
    return 0


# --------------------------------------------------------------------------- replay / evaluate


def _api(a, *, writes: bool):
    from .replay import SupabaseREST, make_client, resolve_target

    base, key = resolve_target(a.target, a.url, a.key)
    if writes and a.target == "hosted" and not a.yes:
        print(f"refusing to write to hosted project {base} without --yes", file=sys.stderr)
        raise SystemExit(2)
    admin = getattr(a, "admin_jwt", None) or os.environ.get("OCCSIM_ADMIN_JWT")
    return SupabaseREST(make_client(base, key), bucket=getattr(a, "bucket", None) or
                        os.environ.get("SUPABASE_BUCKET", "event-snapshots"), admin_token=admin), base


def cmd_replay(a) -> int:
    from .replay import ReplayOptions, Replayer
    from .timeutil import parse_local_or_iso

    if a.dry_run:
        api, base = None, "(dry run)"
    else:
        api, base = _api(a, writes=True)
    opts = ReplayOptions(
        speed=a.speed, fast=a.fast,
        rebase_lead=parse_duration(a.rebase_now) if a.rebase_now is not None else None,
        shuffle_seed=a.shuffle, heartbeats=not a.no_heartbeats, new_ids=a.new_ids,
        dry_run=a.dry_run, stop_on_error=a.stop_on_error,
    )
    if a.until:
        from zoneinfo import ZoneInfo
        opts.until = parse_local_or_iso(a.until, ZoneInfo(load_config(a.config, quiet=True).timezone))
    print(f"replaying {a.sim_dir} -> {base} "
          f"({'fast' if a.fast else 'rebased, real time' if a.rebase_now is not None else f'{a.speed}x'})",
          file=sys.stderr)
    stats = Replayer(a.sim_dir, api, opts).run()
    print(json.dumps(stats, indent=2))
    return 1 if stats["errors"] else 0


def cmd_evaluate(a) -> int:
    from .evaluate import compute_metrics, fetch_tables, load_truth, render_markdown

    truth = load_truth(a.sim_dir)
    api, _ = _api(a, writes=False)
    tables = fetch_tables(api, truth.manifest["lot"]["lot_id"])
    metrics = compute_metrics(truth, tables, offset_s=a.offset_s, tolerance_s=a.tolerance_s,
                              reconcile_every=parse_duration(a.reconcile_every) if a.reconcile_every else None)
    md = render_markdown(metrics)
    print(md)
    if a.report:
        Path(a.report).write_text(md)
        print(f"report written to {a.report}", file=sys.stderr)
    if a.json:
        Path(a.json).write_text(json.dumps(metrics, indent=2, default=str))
    return 0


def cmd_validate(a) -> int:
    from .contract import validate_event, validate_heartbeat

    d = Path(a.sim_dir)
    cfg = load_config(a.config, quiet=True)
    m = json.loads((d / "manifest.json").read_text())
    intentionally_bad = {r["event_id"] for r in m["release_schedule"] if not r.get("contract_valid", True)}
    n_ev = n_hb = bad = 0
    for ev_file in sorted(d.glob("*/events/*/event.json")):
        ev = json.loads(ev_file.read_text())
        errs = validate_event(ev, cfg)
        n_ev += 1
        if errs and ev.get("event_id") not in intentionally_bad:
            bad += 1
            print(f"{ev_file}: {errs}")
        if not (ev_file.parent / "plate.jpg").exists():
            bad += 1
            print(f"{ev_file.parent}: plate.jpg missing")
    for hb_file in sorted(d.glob("*/heartbeats.jsonl")):
        for i, line in enumerate(hb_file.read_text().splitlines()):
            n_hb += 1
            errs = validate_heartbeat(json.loads(line), cfg)
            if errs:
                bad += 1
                print(f"{hb_file}:{i + 1}: {errs}")
    print(f"{n_ev} events, {n_hb} heartbeats, {bad} invalid "
          f"({len(intentionally_bad)} intentionally invalid scenario events skipped)")
    return 1 if bad else 0


# --------------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="occsim", description="Offline camera simulator for the parking-occupancy system")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="simulate N days -> event/heartbeat folders + ground truth")
    g.add_argument("--start", required=True, help="first lot-local day, YYYY-MM-DD")
    g.add_argument("--days", type=int, default=1)
    g.add_argument("--seed", type=int, default=42)
    g.add_argument("--out", required=True)
    g.add_argument("--profile", choices=["auto", "weekday", "weekend"], default="auto",
                   help="arrival profile; auto = by day of week")
    _add_config(g)
    g.add_argument("--capacity", type=int, default=None, help="override config capacity")
    g.add_argument("--arrivals-per-day", type=float, default=None, help="weekday arrivals (default 2.4 x capacity)")
    g.add_argument("--weekend-factor", type=float, default=0.4)
    g.add_argument("--regulars-share", type=float, default=0.40)
    g.add_argument("--regulars-pool", type=int, default=None, help="default 1.5 x capacity")
    g.add_argument("--close-follow-rate", type=float, default=0.03)
    g.add_argument("--overnight-rate", type=float, default=0.02)
    g.add_argument("--miss-rate-in", type=float, default=0.02)
    g.add_argument("--miss-rate-out", type=float, default=0.03)
    g.add_argument("--confusion-rate", type=float, default=0.08)
    g.add_argument("--drop-edge-char-rate", type=float, default=0.02)
    g.add_argument("--fragment-rate", type=float, default=0.03)
    g.add_argument("--late-upload-rate", type=float, default=0.01)
    g.add_argument("--late-upload-max", default="3h")
    g.add_argument("--clock-skew-ms", action="append", default=None,
                   help="per-device constant skew: '250' (all) or 'jetson-out-01=-1500' (repeatable)")
    g.add_argument("--min-plate-chars", type=int, default=5, help="producer rejects shorter consensus reads")
    g.add_argument("--outage", action="append", default=None,
                   help="CAMERA@START/DURATION[:lost], e.g. inbound_cam_01@2026-10-14T10:00/20m (lot-local)")
    g.add_argument("--force", action="store_true", help="write into a non-empty, non-occsim folder")
    g.set_defaults(func=cmd_generate)

    s = sub.add_parser("scenario", help="golden scenarios (doc 10 §2)")
    ssub = s.add_subparsers(dest="scenario_cmd", required=True)
    ssub.add_parser("list")
    sr = ssub.add_parser("run")
    sr.add_argument("name", help="scenario name, number, or 'all'")
    sr.add_argument("--out", required=True, help="output folder ('all' writes one subfolder per scenario)")
    sr.add_argument("--date", default=None, help="re-anchor the scenario on this lot-local date")
    _add_config(sr)
    sr.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_scenario)

    def target_args(p):
        p.add_argument("--target", choices=["local", "hosted"], default="local")
        p.add_argument("--url", default=None, help="override the API base URL")
        p.add_argument("--key", default=None, help="service key (local default: $LOCAL_SERVICE_ROLE_KEY)")
        p.add_argument("--yes", action="store_true", help="required for replay --target hosted")
        _add_config(p)

    r = sub.add_parser("replay", help="push sim_out/ to Supabase in release order")
    r.add_argument("sim_dir")
    target_args(r)
    pace = r.add_mutually_exclusive_group()
    pace.add_argument("--speed", type=float, default=60.0, help="sim seconds per real second (60 = 1 h/min)")
    pace.add_argument("--fast", action="store_true", help="no pacing")
    r.add_argument("--rebase-now", nargs="?", const="0s", default=None, metavar="LEAD",
                   help="shift all timestamps so the first event is at now-LEAD (e.g. 2h); "
                        "past items are sent at once, the rest in real time")
    r.add_argument("--new-ids", action="store_true", help="remap event_ids (uuid5 of id+offset) to replay again")
    r.add_argument("--shuffle", type=int, default=None, metavar="SEED",
                   help="deliver events in random order (engine order-independence check)")
    r.add_argument("--no-heartbeats", action="store_true")
    r.add_argument("--until", default=None, help="stop after this sim time (lot-local unless offset)")
    r.add_argument("--bucket", default=None)
    r.add_argument("--admin-jwt", default=None, help="JWT for admin RPC actions (default: service key)")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--stop-on-error", action="store_true")
    r.set_defaults(func=cmd_replay)

    e = sub.add_parser("evaluate", help="compare DB sessions/occupancy with ground truth")
    e.add_argument("sim_dir")
    target_args(e)
    e.add_argument("--report", default=None, help="write the markdown report here")
    e.add_argument("--json", default=None, help="also write metrics as JSON")
    e.add_argument("--offset-s", type=float, default=None, help="override the rebase offset from manifest")
    e.add_argument("--tolerance-s", type=float, default=30.0, help="DB pass ↔ true pass time tolerance")
    e.add_argument("--reconcile-every", default=None,
                   help="sample the pre-reconciliation residual every N (e.g. 24h); passive, no DB writes")
    e.set_defaults(func=cmd_evaluate)

    v = sub.add_parser("validate", help="check every event/heartbeat against contract v2/v1")
    v.add_argument("sim_dir")
    _add_config(v)
    v.set_defaults(func=cmd_validate)
    return ap


def main(argv: list[str] | None = None) -> int:
    from .replay import ReplayError

    args = build_parser().parse_args(argv)
    try:
        return args.func(args) or 0
    except (ReplayError, FileNotFoundError, FileExistsError, ValueError, KeyError) as e:
        print(f"occsim: error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
