"""`occsim evaluate`: score the DB engine against ground truth (doc 14 §3.7).

Reads parking_sessions, passes, occupancy_timeline (and device_heartbeats)
over PostgREST with the service key, maps DB passes back to true passes by
direction + time (+ plate as tie-break), and reports match precision /
recall, false auto-match rate, occupancy MAE / max error, band coverage,
dwell error, flag counts and residual drift. Rebased replays are handled via
manifest.json["rebase"]["offset_seconds"].

`--reconcile-every 24h` is computed passively: the residual (DB best
estimate − true occupancy) is sampled at each tick, which is what an admin
reconciliation would record *before* correcting. It does not call
reconcile_commit (that would mutate the DB being measured).
"""

from __future__ import annotations

import bisect
import csv
import json
import statistics
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .timeutil import covers_local_hour, iso, parse_iso

AUTO_METHODS = {"exact", "fuzzy"}


# --------------------------------------------------------------------------- truth


@dataclass
class Truth:
    manifest: dict
    visits: list[dict]
    passes: list[dict]
    occupancy: list[tuple[datetime, int]]
    start: datetime
    end: datetime
    capacity: int
    tz: ZoneInfo


def load_truth(sim_dir: str | Path) -> Truth:
    d = Path(sim_dir)
    m = json.loads((d / "manifest.json").read_text())
    gt = d / "ground_truth"
    with open(gt / "visits.csv") as f:
        visits = list(csv.DictReader(f))
    with open(gt / "passes.csv") as f:
        passes = list(csv.DictReader(f))
    for p in passes:
        p["_at"] = parse_iso(p["at"])
    with open(gt / "occupancy.csv") as f:
        occ = [(parse_iso(r["at"]), int(r["occupancy"])) for r in csv.DictReader(f)]
    for v in visits:
        v["_entry"] = parse_iso(v["entry_at"]) if v["entry_at"] else None
        v["_exit"] = parse_iso(v["exit_at"]) if v["exit_at"] else None
    lot = m["lot"]
    return Truth(m, visits, passes, occ, parse_iso(m["time_range"]["start_utc"]),
                 parse_iso(m["time_range"]["end_utc"]), int(m["params"].get("capacity", lot["capacity"])),
                 ZoneInfo(lot.get("timezone", "America/New_York")))


def _norm(plate: str | None) -> str:
    return "".join(c for c in (plate or "").upper() if c.isalnum())


class StepFn:
    """Right-continuous step function from [(t, value...)] sorted by t."""

    def __init__(self, rows: list[tuple]):
        self.rows = rows
        self.ts = [r[0] for r in rows]

    def at(self, t: datetime):
        i = bisect.bisect_right(self.ts, t) - 1
        return self.rows[i] if i >= 0 else None


class PassMapper:
    """Map a DB pass (direction, time, plate) to the nearest true pass."""

    def __init__(self, passes: list[dict], tol: timedelta):
        self.tol = tol
        self.by_dir: dict[str, list[dict]] = {"in": [], "out": []}
        for p in passes:
            self.by_dir[p["direction"]].append(p)
        for v in self.by_dir.values():
            v.sort(key=lambda p: p["_at"])
        self.ts = {k: [p["_at"] for p in v] for k, v in self.by_dir.items()}

    def map(self, direction: str, t: datetime, plate: str | None) -> dict | None:
        lst, ts = self.by_dir.get(direction, []), self.ts.get(direction, [])
        lo = bisect.bisect_left(ts, t - self.tol)
        hi = bisect.bisect_right(ts, t + self.tol)
        cands = lst[lo:hi]
        if not cands:
            return None
        pn = _norm(plate)
        return min(cands, key=lambda p: (_norm(p["plate"]) != pn, abs((p["_at"] - t).total_seconds())))


# --------------------------------------------------------------------------- fetch


def fetch_tables(api, lot_id: str) -> dict[str, list[dict]]:
    """api: replay.SupabaseREST (select with paging)."""
    lot = {"lot_id": f"eq.{lot_id}"}
    out = {
        "parking_sessions": api.select("parking_sessions", {**lot, "order": "session_id"}),
        "passes": api.select("passes", {**lot, "order": "pass_id"}),
        "occupancy_timeline": api.select("occupancy_timeline", {**lot, "order": "seq"}),
    }
    try:
        out["device_heartbeats"] = api.select("device_heartbeats", {"order": "device_id"})
    except Exception:  # noqa: BLE001 - optional table
        out["device_heartbeats"] = []
    return out


# --------------------------------------------------------------------------- metrics


def _ratio(a: float, b: float) -> float | None:
    return a / b if b else None


def compute_metrics(truth: Truth, tables: dict[str, list[dict]], *, offset_s: float | None = None,
                    tolerance_s: float = 30.0, reconcile_every: timedelta | None = None,
                    sample_every: timedelta = timedelta(minutes=1)) -> dict:
    m = truth.manifest
    if offset_s is None:
        offset_s = float((m.get("rebase") or {}).get("offset_seconds") or 0.0)
    off = timedelta(seconds=offset_s)
    skews = (m.get("params", {}).get("noise") or {}).get("clock_skew_ms") or {}
    max_skew = max([abs(v) for v in skews.values()] or [0]) / 1000.0
    tol = timedelta(seconds=tolerance_s + max_skew)
    lo_win, hi_win = truth.start - timedelta(hours=1), truth.end + timedelta(hours=1)

    def t(v):  # DB timestamp -> sim time
        return parse_iso(v) - off if v else None

    # ---- passes
    db_passes = {}
    for p in tables.get("passes", []):
        at = t(p["event_at"])
        if lo_win <= at <= hi_win:
            db_passes[p["pass_id"]] = {**p, "_at": at}
    mapper = PassMapper(truth.passes, tol)
    pass_map: dict[str, dict | None] = {
        pid: mapper.map(p["direction"], p["_at"], p.get("plate_norm")) for pid, p in db_passes.items()
    }
    mapped_true = Counter(tp["pass_id"] for tp in pass_map.values() if tp)
    emitted = [p for p in truth.passes if p["outcome"] == "emitted"]
    pass_stats = {
        "true_passes": len(truth.passes),
        "true_passes_emitted": len(emitted),
        "db_passes": len(db_passes),
        "db_passes_by_direction": dict(Counter(p["direction"] for p in db_passes.values())),
        "db_passes_unmapped": sum(1 for v in pass_map.values() if v is None),
        "true_passes_split_into_multiple_db_passes": sum(1 for c in mapped_true.values() if c > 1),
        "emitted_true_passes_without_db_pass": sum(1 for p in emitted if p["pass_id"] not in mapped_true),
        "db_passes_flagged_possible_fragment": sum(1 for p in db_passes.values() if p.get("possible_fragment")),
    }
    plate_ok = sum(1 for pid, tp in pass_map.items() if tp and _norm(tp["plate"]) == _norm(db_passes[pid].get("plate_norm")))
    pass_stats["db_pass_plate_accuracy"] = _ratio(plate_ok, sum(1 for v in pass_map.values() if v))

    # ---- sessions
    sessions = []
    for s in tables.get("parking_sessions", []):
        ea, xa = t(s.get("entry_at")), t(s.get("exit_at"))
        anchor = ea or xa
        if anchor is None or not (lo_win <= anchor <= hi_win):
            continue
        sessions.append({**s, "_entry": ea, "_exit": xa})
    status_counts = Counter(s["status"] for s in sessions)
    method_counts = Counter(s.get("match_method") or "none" for s in sessions)

    def visit_of(pass_id):
        tp = pass_map.get(pass_id) if pass_id else None
        return tp["visit_id"] if tp else None

    pairs = [s for s in sessions if s.get("entry_pass_id") and s.get("exit_pass_id")]
    per_method = {}
    correct_pairs, dwell_errs = set(), []
    visits_by_id = {v["visit_id"]: v for v in truth.visits}
    for s in pairs:
        ve, vx = visit_of(s["entry_pass_id"]), visit_of(s["exit_pass_id"])
        ok = ve is not None and ve == vx
        mm = s.get("match_method") or "none"
        pm = per_method.setdefault(mm, {"pairs": 0, "correct": 0})
        pm["pairs"] += 1
        pm["correct"] += int(ok)
        if ok:
            correct_pairs.add(ve)
            v = visits_by_id.get(ve)
            if v and v["_entry"] and v["_exit"] and s["_entry"] and s["_exit"]:
                db_dw = (s["_exit"] - s["_entry"]).total_seconds() / 60
                tr_dw = (v["_exit"] - v["_entry"]).total_seconds() / 60
                dwell_errs.append(abs(db_dw - tr_dw))
    auto = [s for s in pairs if s.get("match_method") in AUTO_METHODS]
    auto_correct = sum(per_method.get(k, {}).get("correct", 0) for k in AUTO_METHODS)
    true_pairs = [v for v in truth.visits if v["_entry"] and v["_exit"]]
    observable = [v for v in true_pairs if v["entry_outcome"] == "emitted" and v["exit_outcome"] == "emitted"]
    matching = {
        "true_pairs": len(true_pairs),
        "true_pairs_observable": len(observable),
        "db_paired_sessions": len(pairs),
        "auto_pairs": len(auto),
        "auto_correct": auto_correct,
        "precision_auto": _ratio(auto_correct, len(auto)),
        "false_auto_match_rate": _ratio(len(auto) - auto_correct, len(auto)),
        "recall": _ratio(len(correct_pairs), len(true_pairs)),
        "recall_observable": _ratio(len({v["visit_id"] for v in observable} & correct_pairs), len(observable)),
        "per_method": per_method,
        "dwell_abs_err_median_min": statistics.median(dwell_errs) if dwell_errs else None,
        "dwell_abs_err_p90_min": (sorted(dwell_errs)[int(0.9 * (len(dwell_errs) - 1))] if dwell_errs else None),
    }

    # ---- occupancy
    tl = sorted(tables.get("occupancy_timeline", []), key=lambda r: (parse_iso(r["valid_from"]), r.get("seq", 0)))
    db_fn = StepFn([(t(r["valid_from"]), r) for r in tl])
    tr_fn = StepFn(truth.occupancy)
    errs, s2_errs, inside, n = [], [], 0, 0
    cur = truth.start
    while cur < truth.end:
        tv = tr_fn.at(cur)
        true_occ = tv[1] if tv else 0
        row = db_fn.at(cur)
        est = int(row[1]["occupancy"]) if row else 0
        lo_b = int(row[1]["band_low"]) if row else 0
        hi_b = int(row[1]["band_high"]) if row else 0
        s2 = int(row[1]["open_sessions"]) if row else 0
        errs.append(est - true_occ)
        s2_errs.append(s2 - true_occ)
        inside += int(lo_b <= true_occ <= hi_b)
        n += 1
        cur += sample_every
    mae = statistics.fmean(abs(e) for e in errs) if errs else None
    occupancy = {
        "samples": n,
        "mae": mae,
        "mae_pct_capacity": (mae / truth.capacity) if mae is not None and truth.capacity else None,
        "max_abs_error": max((abs(e) for e in errs), default=None),
        "bias": statistics.fmean(errs) if errs else None,
        "s2_open_sessions_mae": statistics.fmean(abs(e) for e in s2_errs) if s2_errs else None,
        "band_coverage": _ratio(inside, n),
        "timeline_rows": len(tl),
    }

    drift = []
    if reconcile_every:
        cur = truth.start + reconcile_every
        while cur <= truth.end:
            tv, row = tr_fn.at(cur), db_fn.at(cur)
            true_occ = tv[1] if tv else 0
            est = int(row[1]["occupancy"]) if row else 0
            drift.append({"at": iso(cur), "true": true_occ, "estimate": est, "residual": est - true_occ,
                          "open_sessions": int(row[1]["open_sessions"]) if row else 0})
            cur += reconcile_every

    # ---- flags
    def flag_counts_db():
        c = Counter()
        for s in sessions:
            if s.get("is_bounce"):
                c["bounce"] += 1
            if s["_entry"]:
                end = s["_exit"] or truth.end
                if covers_local_hour(s["_entry"], end, truth.tz, 3):
                    c["overnight"] += 1
                if end - s["_entry"] > timedelta(hours=24):
                    c["multi_day"] += 1
        return c

    tc = Counter()
    for v in truth.visits:
        tc["bounce"] += v["is_bounce"] == "1" and v["_exit"] is not None
        tc["overnight"] += v["is_overnight"] == "1"
        tc["multi_day"] += v["is_multi_day"] == "1"
    tc["missed_entries_with_exit"] = sum(1 for v in truth.visits if v["entry_outcome"] != "emitted" and v["_exit"])
    dc = flag_counts_db()
    flags = {
        "bounce": {"truth": tc["bounce"], "db": dc["bounce"]},
        "overnight": {"truth": tc["overnight"], "db": dc["overnight"]},
        "multi_day": {"truth": tc["multi_day"], "db": dc["multi_day"]},
        "orphan_exits": {"truth_missed_entries": tc["missed_entries_with_exit"],
                         "db": status_counts.get("orphan_exit", 0)},
    }

    devices = {
        "injected_outages": m.get("outages", []),
        "offline_after_s": m["lot"].get("offline_after_s", 180),
        "device_heartbeats_now": [
            {k: d.get(k) for k in ("device_id", "status", "sent_at_utc", "received_at", "pending_uploads")}
            for d in tables.get("device_heartbeats", [])
        ],
        "note": "device_heartbeats keeps only the latest row per device, so historical offline windows "
                "cannot be scored from the DB; use scenario 17 + the dashboard banner.",
    }

    targets = {
        "precision_auto>=0.995": (matching["precision_auto"] or 0) >= 0.995 if matching["auto_pairs"] else None,
        "mae<=3%capacity": (occupancy["mae_pct_capacity"] or 0) <= 0.03 if occupancy["mae"] is not None else None,
        "band_coverage>=0.95": (occupancy["band_coverage"] or 0) >= 0.95 if n else None,
    }
    return {
        "sim": {"scenario": (m.get("scenario") or {}).get("name"), "start_utc": iso(truth.start),
                "end_utc": iso(truth.end), "capacity": truth.capacity, "offset_seconds": offset_s,
                "seed": m.get("params", {}).get("seed")},
        "passes": pass_stats,
        "sessions": {"count": len(sessions), "by_status": dict(status_counts), "by_method": dict(method_counts)},
        "matching": matching,
        "occupancy": occupancy,
        "drift": drift,
        "flags": flags,
        "devices": devices,
        "targets": targets,
        "imperfections": m.get("counts", {}).get("imperfections", {}),
    }


# --------------------------------------------------------------------------- report


def _fmt(v, pct=False) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, bool):
        return "PASS" if v else "FAIL"
    if pct:
        return f"{100 * v:.2f} %"
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)


def render_markdown(r: dict) -> str:
    s, mt, oc, ps = r["sim"], r["matching"], r["occupancy"], r["passes"]
    L = [
        "# occsim evaluation report",
        "",
        f"- Window: {s['start_utc']} → {s['end_utc']} (sim time; DB offset {s['offset_seconds']:+.0f} s)",
        f"- Capacity: {s['capacity']} · seed: {s['seed']} · scenario: {s['scenario'] or '-'}",
        "",
        "## Phase 1 exit criteria",
        "",
        "| Target | Result |",
        "|---|---|",
    ]
    L += [f"| {k} | {_fmt(v)} |" for k, v in r["targets"].items()]
    L += [
        "",
        "## Matching",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Auto-match precision (exact + fuzzy) | {_fmt(mt['precision_auto'], True)} ({mt['auto_correct']}/{mt['auto_pairs']}) |",
        f"| False auto-match rate | {_fmt(mt['false_auto_match_rate'], True)} |",
        f"| Recall (all true visits with entry+exit) | {_fmt(mt['recall'], True)} of {mt['true_pairs']} |",
        f"| Recall (both passes emitted by cameras) | {_fmt(mt['recall_observable'], True)} of {mt['true_pairs_observable']} |",
        f"| Dwell abs error median / p90 (min) | {_fmt(mt['dwell_abs_err_median_min'])} / {_fmt(mt['dwell_abs_err_p90_min'])} |",
        "",
        "| match_method | pairs | correct |",
        "|---|---|---|",
    ]
    L += [f"| {k} | {v['pairs']} | {v['correct']} |" for k, v in sorted(mt["per_method"].items())]
    L += [
        "",
        f"Sessions by status: {json.dumps(r['sessions']['by_status'], sort_keys=True)}",
        "",
        "## Occupancy (sampled every minute)",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| MAE (S1 best estimate) | {_fmt(oc['mae'])} ({_fmt(oc['mae_pct_capacity'], True)} of capacity) |",
        f"| Max abs error | {_fmt(oc['max_abs_error'])} |",
        f"| Bias (estimate − truth) | {_fmt(oc['bias'])} |",
        f"| S2 open-sessions MAE | {_fmt(oc['s2_open_sessions_mae'])} |",
        f"| Band coverage | {_fmt(oc['band_coverage'], True)} |",
        f"| Timeline rows | {oc['timeline_rows']} |",
        "",
        "## Passes",
        "",
        "| Metric | Value |",
        "|---|---|",
    ]
    L += [f"| {k} | {_fmt(v, k.endswith('accuracy'))} |" for k, v in ps.items()]
    if r["drift"]:
        L += ["", "## Drift before reconciliation (passive)", "", "| at | truth | estimate | residual | open sessions |",
              "|---|---|---|---|---|"]
        L += [f"| {d['at']} | {d['true']} | {d['estimate']} | {d['residual']:+d} | {d['open_sessions']} |"
              for d in r["drift"]]
    L += ["", "## Flags (truth vs DB)", "", "| Flag | Truth | DB |", "|---|---|---|"]
    for k, v in r["flags"].items():
        vals = list(v.values())
        L.append(f"| {k} | {vals[0]} | {vals[1]} |")
    L += ["", "## Injected imperfections", "", "```", json.dumps(r["imperfections"], indent=2, sort_keys=True), "```"]
    dv = r["devices"]
    L += ["", "## Device health", "", f"Injected outages: {json.dumps(dv['injected_outages'])}", "",
          f"Latest heartbeats: {json.dumps(dv['device_heartbeats_now'])}", "", f"_{dv['note']}_", ""]
    return "\n".join(L)
