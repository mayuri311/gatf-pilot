"""Golden scenarios (doc 10 §2) — YAML → exact event sequences.

Scenario YAML reference (all keys optional unless stated)::

    name: ocr_near_miss                 # required, also the file stem
    id: 2                               # doc 10 §2 number
    title: OCR near-miss
    mode: replay                        # replay | partial (needs DB actions) | engine_only
    date: "2026-10-13"                  # lot-local day that HH:MM:SS times refer to
    days: 1                             # horizon = local midnight(date) .. +days
    horizon: {start: "09:55", end: "10:20"}   # explicit horizon instead
    heartbeats: true                    # emit heartbeats.jsonl over the horizon
    noise: false                        # true = realistic noisy reads[] (consensus decides)
    seed: 0
    capacity: 100                       # override config capacity
    release: {at: "12:00:00", order: reverse}  # deliver every event in one batch
    outages: ["inbound_cam_01@10:05/5m:lost"] # HH:MM is on `date`
    expect: {...}                       # free-form expected end state (pgTAP / evaluate)
    steps:
      - at: "08:00:00"                  # or full ISO with offset; `day: N` adds N days
        camera: inbound_cam_01          # required
        plate: Z94PVE                   # true plate (required unless truth: false)
        observe_as: Z94PWE              # what the camera's consensus reads (default plate)
        emit: true                      # false = camera missed the pass (truth only)
        truth: true                     # false = event is not a real pass (contract tests)
        fragment_of_previous: true      # extra event for the previous pass on this camera
        late: 3h                        # release_at = finalize + 3h
        release_at: "12:00:00"          # explicit release time (same date rules as `at`)
        duplicates: 1                   # deliver the same event N more times (+60 s each)
        override: {schema_version: 1}   # patch the payload (contract-invalid fixtures)
        captured_shift: 10m             # device clock ahead by this much (future skew)
      - bulk:                           # many identical-shape steps
          camera: inbound_cam_01
          at: "07:00:00"
          every: 2m
          plates: [AAA1111, BBB2222]
          observe_as: [null, XYZ9999]   # optional per-plate lists (or scalars)
          emit: [true, false]
    actions:                            # DB-side steps executed by `occsim replay`
      - {at: "12:00:00", day: 1, action: reconcile, visual_count: 41, close: 11}
      - {at: "10:30:00", action: resolve_match, exit_plate: X, entry_plate: Y}
      - {at: "09:00:00", action: set_capacity, capacity: 120}
      - {at: "09:00:00", action: rpc, name: some_rpc, params: {...}}
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from importlib import resources
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

from .camera import CameraModel, NoiseParams, SimEvent
from .config import SimConfig
from .generate import parse_outage
from .heartbeat import build_heartbeats
from .timeutil import iso, local_midnight, parse_duration, parse_iso, parse_local_or_iso
from .world import TruePass, Visit
from .writer import SimResult

DEFAULT_DATE = date(2026, 10, 13)


def scenarios_dir() -> Path:
    return Path(str(resources.files("occsim") / "scenarios"))


def list_scenarios() -> list[dict]:
    out = []
    for p in sorted(scenarios_dir().glob("*.yaml")):
        d = yaml.safe_load(p.read_text())
        out.append({"name": d["name"], "id": d.get("id"), "title": d.get("title", ""),
                    "mode": d.get("mode", "replay"), "path": str(p)})
    out.sort(key=lambda s: (s["id"] is None, s["id"] or 0, s["name"]))
    return out


def load_scenario(name_or_path: str) -> dict:
    """By name ('ocr_near_miss'), doc-10 number ('2'), file stem, or a YAML path."""
    p = Path(name_or_path)
    if not (p.suffix in (".yaml", ".yml") and p.exists()):
        known = list_scenarios()
        hit = next((s for s in known if name_or_path in (s["name"], str(s["id"]), Path(s["path"]).stem)), None)
        if hit is None:
            raise FileNotFoundError(f"unknown scenario {name_or_path!r}; available: "
                                    f"{', '.join(s['name'] for s in known)}")
        p = Path(hit["path"])
    d = yaml.safe_load(p.read_text())
    if not isinstance(d, dict) or "name" not in d:
        raise ValueError(f"{p}: scenario needs a 'name'")
    return d


@dataclass
class _Step:
    at: datetime
    seq: int
    camera: str
    plate: str | None
    observe_as: str | None
    emit: bool
    truth: bool
    fragment: bool
    late: timedelta | None
    release_at: datetime | None
    duplicates: int
    override: dict | None
    captured_shift: timedelta


def _expand_steps(sc: dict, base: date, tz: ZoneInfo) -> list[_Step]:
    def when(value, day=0) -> datetime:
        return parse_local_or_iso(str(value), tz, base + timedelta(days=int(day or 0)))

    def pick(v, i):
        return v[i] if isinstance(v, list) else v

    raw: list[dict] = []
    for s in sc.get("steps") or []:
        if "bulk" in s:
            b = s["bulk"]
            start = when(b["at"], b.get("day", 0))
            every = parse_duration(b.get("every", "1m"))
            for i, plate in enumerate(b["plates"]):
                raw.append({
                    "_at": start + every * i, "camera": b["camera"], "plate": plate,
                    "observe_as": pick(b.get("observe_as"), i), "emit": pick(b.get("emit", True), i),
                    "late": pick(b.get("late"), i),
                })
        else:
            raw.append(dict(s, _at=when(s["at"], s.get("day", 0))))
    steps = []
    for i, s in enumerate(raw):
        rel = s.get("release_at")
        steps.append(_Step(
            at=s["_at"], seq=i, camera=s["camera"], plate=s.get("plate"),
            observe_as=s.get("observe_as"), emit=bool(s.get("emit", True)),
            truth=bool(s.get("truth", True)), fragment=bool(s.get("fragment_of_previous", False)),
            late=parse_duration(s["late"]) if s.get("late") else None,
            release_at=when(rel, s.get("release_day", s.get("day", 0))) if rel else None,
            duplicates=int(s.get("duplicates", 0)), override=s.get("override"),
            captured_shift=parse_duration(s.get("captured_shift", 0)),
        ))
    steps.sort(key=lambda s: (s.at, s.seq))
    return steps


def build_scenario(sc: dict, cfg: SimConfig, *, date_override: date | None = None) -> SimResult:
    tz = ZoneInfo(cfg.timezone)
    if sc.get("capacity"):
        cfg.capacity = int(sc["capacity"])
    base = date_override or (date.fromisoformat(str(sc["date"])) if sc.get("date") else DEFAULT_DATE)
    days = int(sc.get("days", 1))
    seed = int(sc.get("seed", 0))
    noisy = bool(sc.get("noise", False))
    steps = _expand_steps(sc, base, tz)

    hz = sc.get("horizon")
    if hz:
        start = parse_local_or_iso(str(hz["start"]), tz, base)
        end = parse_local_or_iso(str(hz["end"]), tz, base + timedelta(days=int(hz.get("end_day", 0))))
    else:
        start = local_midnight(base, tz)
        end = local_midnight(base + timedelta(days=days), tz)

    outages = []
    for spec in sc.get("outages") or []:
        cam, rest = spec.split("@", 1)
        when_s = rest.split("/", 1)[0]
        if ":" in when_s and "T" not in when_s and "-" not in when_s:  # HH:MM on base date
            rest = parse_local_or_iso(when_s, tz, base).isoformat() + "/" + rest.split("/", 1)[1]
        outages.append(parse_outage(f"{cam}@{rest}", cfg))

    noise = NoiseParams(miss_rate_in=0, miss_rate_out=0, confusion_rate=0, drop_edge_char_rate=0,
                        fragment_rate=0, late_upload_rate=0)
    cam_model = CameraModel(cfg, noise, seed, start, outages)
    rng = random.Random(f"{seed}:scenario")

    passes: list[TruePass] = []
    visits: list[Visit] = []
    open_visits: dict[str, list[Visit]] = {}
    last_pass: dict[str, TruePass] = {}
    events: list[SimEvent] = []
    n_pass = 0

    def new_visit(plate: str, entry: datetime | None) -> Visit:
        v = Visit(visit_id=f"V{len(visits) + 1:06d}", plate=plate, jurisdiction="SCENARIO",
                  is_regular=False, dwell_class="scripted", entry_at=entry, exit_at=None, tz=cfg.timezone)
        visits.append(v)
        return v

    for st in steps:
        direction = cfg.camera(st.camera).direction
        tp: TruePass | None = None
        if st.fragment:
            tp = last_pass.get(st.camera)
        elif st.truth:
            if not st.plate:
                raise ValueError(f"scenario {sc['name']}: step at {iso(st.at)} needs a plate")
            if direction == "in":
                v = new_visit(st.plate, st.at)
                open_visits.setdefault(st.plate, []).append(v)
            else:
                stack = open_visits.get(st.plate) or []
                v = stack.pop(0) if stack else new_visit(st.plate, None)
                v.exit_at = st.at
                if v.entry_at is not None:
                    v.is_bounce = (st.at - v.entry_at) <= timedelta(minutes=5)
            n_pass += 1
            tp = TruePass(pass_id=f"P{n_pass:06d}", visit_id=v.visit_id, camera_id=st.camera,
                          direction=direction, at=st.at, plate=st.plate)
            passes.append(tp)
            last_pass[st.camera] = tp
        if not st.emit:
            if tp is not None and not st.fragment:
                tp.outcome = "missed"
            continue
        observed = st.observe_as or st.plate
        if not observed:
            raise ValueError(f"scenario {sc['name']}: emitted step at {iso(st.at)} needs plate/observe_as")
        ev, _ = cam_model.build_event(
            st.camera, st.at, observed, st.plate or observed,
            n_frames=rng.randint(30, 45) if st.fragment else rng.randint(90, 150),
            noisy=noisy, kind="fragment" if st.fragment else "main",
            pass_id=tp.pass_id if tp else None, visit_id=tp.visit_id if tp else None,
            overrides=st.override, captured_shift=st.captured_shift, validate=False,
        )
        if st.captured_shift:
            # the device clock is wrong; it still uploads at the true time
            ev.release_at = ev.release_at - st.captured_shift
        if not st.truth:
            ev.true_plate = None
        if st.override:
            ev.contract_valid = False
            ev.note = f"payload override {st.override}"
        if st.captured_shift:
            ev.contract_valid = False
            ev.note = f"captured_at_utc skewed by {st.captured_shift.total_seconds():+.0f}s"
        if st.late:
            ev.release_at = ev.release_at + st.late
            ev.late = True
        if st.release_at:
            ev.release_at = st.release_at
        ev.extra_releases = [ev.release_at + timedelta(seconds=60 * (k + 1)) for k in range(st.duplicates)]
        if tp is not None:
            tp.event_ids.append(ev.event_id)
            if not st.fragment:
                tp.outcome, tp.plate_text = "emitted", ev.payload["plate_text"]
        events.append(ev)

    rel = sc.get("release")
    if rel:
        at = parse_local_or_iso(str(rel["at"]), tz, base + timedelta(days=int(rel.get("day", 0))))
        order = list(events)
        if rel.get("order", "forward") == "reverse":
            order.reverse()
        for k, ev in enumerate(order):
            ev.release_at = at + timedelta(microseconds=k)

    heartbeats = (build_heartbeats(cfg, start, end, events, outages, noise, seed)
                  if sc.get("heartbeats", True) else {})

    actions = []
    for a in sc.get("actions") or []:
        a = dict(a)
        at = parse_local_or_iso(str(a.pop("at")), tz, base + timedelta(days=int(a.pop("day", 0))))
        actions.append({"at": iso(at), **a})
    actions.sort(key=lambda a: a["at"])

    for v in visits:
        if v.exit_at is not None and v.exit_at >= end:
            v.exit_at = None
    counts = {
        "true_passes": {"in": sum(p.direction == "in" for p in passes),
                        "out": sum(p.direction == "out" for p in passes)},
        "pass_outcomes": {o: sum(p.outcome == o for p in passes) for o in {p.outcome for p in passes}},
        "imperfections": {
            "missed": sum(p.outcome == "missed" for p in passes),
            "fragments": sum(e.kind == "fragment" for e in events),
            "late_uploads": sum(e.late for e in events),
            "duplicate_deliveries": sum(len(e.extra_releases) for e in events),
            "contract_invalid_events": sum(not e.contract_valid for e in events),
            "misreads": sum(1 for e in events if e.true_plate and e.kind == "main"
                            and e.payload["plate_text"] != e.true_plate),
        },
    }
    meta = {k: sc.get(k) for k in ("name", "id", "title", "mode", "description", "expect")}
    meta["mode"] = meta["mode"] or "replay"
    params = {"scenario": sc["name"], "seed": seed, "date": base.isoformat(), "noise": noisy,
              "capacity": cfg.capacity, "timezone": cfg.timezone}
    events.sort(key=lambda e: (parse_iso(e.payload["timestamp_utc"]), e.camera_dir))
    return SimResult(cfg=cfg, start_utc=start, end_utc=end, visits=visits, passes=passes, events=events,
                     heartbeats=heartbeats, params=params, counts=counts, outages=outages,
                     actions=actions, scenario=meta)
