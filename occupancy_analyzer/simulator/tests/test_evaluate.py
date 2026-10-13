"""Evaluator against synthetic DB tables built from ground truth."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta

import httpx

from occsim.evaluate import compute_metrics, fetch_tables, load_truth, render_markdown
from occsim.replay import SupabaseREST, make_client
from occsim.timeutil import iso


def perfect_engine(truth, offset=timedelta(0), band=1):
    """Tables an ideal sessionizer would produce from the emitted passes."""
    passes, sessions = [], []
    pid = {}
    for p in truth.passes:
        if p["outcome"] != "emitted":
            continue
        pid[p["pass_id"]] = str(uuid.uuid4())
        passes.append({"pass_id": pid[p["pass_id"]], "direction": p["direction"],
                       "event_at": iso(p["_at"] + offset), "plate_norm": p["plate_text"],
                       "possible_fragment": False})
    by_visit = {}
    for p in truth.passes:
        by_visit.setdefault(p["visit_id"], {})[p["direction"]] = p
    for v in truth.visits:
        pi, po = by_visit[v["visit_id"]].get("in"), by_visit[v["visit_id"]].get("out")
        e_ok = pi is not None and pi["pass_id"] in pid
        x_ok = po is not None and po["pass_id"] in pid
        if not e_ok and not x_ok:
            continue
        sessions.append({
            "session_id": str(uuid.uuid4()), "plate_norm": v["plate"],
            "entry_pass_id": pid[pi["pass_id"]] if e_ok else None,
            "exit_pass_id": pid[po["pass_id"]] if x_ok else None,
            "entry_at": iso(pi["_at"] + offset) if e_ok else None,
            "exit_at": iso(po["_at"] + offset) if x_ok else None,
            "status": "closed" if e_ok and x_ok else ("open" if e_ok else "orphan_exit"),
            "match_method": "exact" if e_ok and x_ok else None,
            "is_bounce": v["is_bounce"] == "1",
        })
    timeline = [{"valid_from": iso(t + offset), "occupancy": o, "band_low": o - band, "band_high": o + band,
                 "open_sessions": o, "seq": i} for i, (t, o) in enumerate(truth.occupancy)]
    return {"passes": passes, "parking_sessions": sessions, "occupancy_timeline": timeline,
            "device_heartbeats": []}


def test_perfect_engine_scores_perfectly(sim_dir):
    truth = load_truth(sim_dir)
    r = compute_metrics(truth, perfect_engine(truth), reconcile_every=timedelta(hours=6))
    mt, oc = r["matching"], r["occupancy"]
    assert mt["precision_auto"] == 1.0 and mt["false_auto_match_rate"] == 0.0
    assert mt["recall_observable"] == 1.0
    assert mt["recall"] < 1.0  # missed reads exist in the default noise
    assert mt["dwell_abs_err_median_min"] == 0
    assert oc["mae"] == 0 and oc["band_coverage"] == 1.0 and oc["samples"] == 1440
    assert r["targets"] == {"precision_auto>=0.995": True, "mae<=3%capacity": True, "band_coverage>=0.95": True}
    assert len(r["drift"]) == 4 and all(d["residual"] == 0 for d in r["drift"])
    md = render_markdown(r)
    assert "Auto-match precision" in md and "100.00 %" in md


def test_rebased_offset_from_manifest(sim_dir, tmp_path):
    import shutil
    d = tmp_path / "copy"
    shutil.copytree(sim_dir, d)
    m = json.loads((d / "manifest.json").read_text())
    off = timedelta(days=9, minutes=17)
    m["rebase"] = {"offset_seconds": off.total_seconds()}
    (d / "manifest.json").write_text(json.dumps(m))
    truth = load_truth(d)
    r = compute_metrics(truth, perfect_engine(truth, offset=off))
    assert r["matching"]["precision_auto"] == 1.0 and r["occupancy"]["mae"] == 0
    # without the offset nothing lines up
    r0 = compute_metrics(truth, perfect_engine(truth, offset=off), offset_s=0)
    assert r0["matching"]["auto_pairs"] == 0


def test_wrong_pairs_reduce_precision_and_occupancy_error(sim_dir):
    truth = load_truth(sim_dir)
    tables = perfect_engine(truth)
    closed = [s for s in tables["parking_sessions"] if s["status"] == "closed"]
    # swap the exits of two sessions -> 2 false auto-matches
    a, b = closed[10], closed[20]
    a["exit_pass_id"], b["exit_pass_id"] = b["exit_pass_id"], a["exit_pass_id"]
    for row in tables["occupancy_timeline"]:
        row["occupancy"] += 2  # constant overestimate
    r = compute_metrics(truth, tables)
    assert r["matching"]["auto_pairs"] - r["matching"]["auto_correct"] == 2
    assert r["targets"]["precision_auto>=0.995"] is False
    assert r["occupancy"]["mae"] == 2 and r["occupancy"]["bias"] == 2


def test_fetch_tables_paginates_over_postgrest(sim_dir):
    truth = load_truth(sim_dir)
    tables = perfect_engine(truth)
    seen = []

    def handler(req: httpx.Request):
        table = req.url.path.rsplit("/", 1)[1]
        seen.append((table, req.url.params.get("lot_id"), req.url.params.get("offset")))
        rows = tables.get(table, [])
        off, lim = int(req.url.params["offset"]), int(req.url.params["limit"])
        return httpx.Response(200, json=rows[off:off + lim])

    api = SupabaseREST(make_client("http://fake", "k", transport=httpx.MockTransport(handler)))
    got = fetch_tables(api, "gatf_main")
    assert len(got["passes"]) == len(tables["passes"])
    assert len(got["occupancy_timeline"]) == len(tables["occupancy_timeline"])
    assert ("parking_sessions", "eq.gatf_main", "0") in seen
    assert any(t == "occupancy_timeline" and o == "1000" for t, _, o in seen) or len(tables["occupancy_timeline"]) < 1000
