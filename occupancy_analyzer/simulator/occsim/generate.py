"""`occsim generate`: world → cameras → heartbeats → SimResult."""

from __future__ import annotations

from collections import Counter
from zoneinfo import ZoneInfo

from .camera import CameraModel, NoiseParams, Outage
from .config import SimConfig
from .heartbeat import build_heartbeats
from .timeutil import iso, parse_duration, parse_local_or_iso
from .world import DEFAULT_ARRIVALS_PER_CAPACITY, WorldParams, simulate_world
from .writer import SimResult



def parse_outage(spec: str, cfg: SimConfig) -> Outage:
    """'inbound_cam_01@2026-10-14T10:00/20m[:lost|:backlog]'.

    The start is lot-local time unless it carries an offset. Default mode is
    'backlog' (device keeps capturing, nothing reaches the DB, queued uploads
    burst out when the outage ends); ':lost' means the camera itself is down
    and passes during the window are never captured.
    """
    mode = "backlog"
    s = spec.strip()
    for m in ("lost", "backlog"):
        if s.endswith(":" + m):
            mode, s = m, s[: -len(m) - 1]
    if "@" not in s or "/" not in s:
        raise ValueError(f"bad --outage {spec!r}; expected CAMERA@START/DURATION[:lost]")
    cam, rest = s.split("@", 1)
    start_s, dur_s = rest.rsplit("/", 1)
    cfg.camera(cam)  # validates the camera id
    tz = ZoneInfo(cfg.timezone)
    start = parse_local_or_iso(start_s, tz)
    dur = parse_duration(dur_s)
    if dur.total_seconds() <= 0:
        raise ValueError(f"outage duration must be positive: {spec!r}")
    return Outage(cam, start, start + dur, mode)


def parse_skews(values: list[str] | None, cfg: SimConfig) -> dict[str, int]:
    """--clock-skew-ms 250 (all devices) | jetson-out-01=-1500 (repeatable).
    A camera id may be used instead of the device id."""
    out: dict[str, int] = {}
    for v in values or []:
        if "=" in v:
            k, ms = v.split("=", 1)
            k = k.strip()
            if any(c.camera_id == k for c in cfg.cameras):
                k = cfg.camera(k).device_id
            out[k] = int(float(ms))
        else:
            out["*"] = int(float(v))
    return out


def generate(cfg: SimConfig, wp: WorldParams, noise: NoiseParams,
             outages: list[Outage] | None = None) -> SimResult:
    outages = outages or []
    world = simulate_world(cfg, wp)
    cam = CameraModel(cfg, noise, wp.seed, world.start_utc, outages)
    events = []
    for tp in world.passes:
        events.extend(cam.process_pass(tp))
    events.sort(key=lambda e: (e.payload["timestamp_utc"], e.camera_dir, e.payload["track_id"]))
    heartbeats = build_heartbeats(cfg, world.start_utc, world.end_utc, events, outages, noise, wp.seed)

    true_in = sum(1 for p in world.passes if p.direction == "in")
    true_out = len(world.passes) - true_in
    imperfections = Counter(cam.counts)
    imperfections["close_following_cars"] = world.stats["close_follow"]
    counts = {
        "world": world.stats,
        "true_passes": {"in": true_in, "out": true_out},
        "pass_outcomes": dict(Counter(p.outcome for p in world.passes)),
        "imperfections": dict(sorted(imperfections.items())),
        "rejections_by_reason": dict(cam.rejections),
    }
    params = {
        "seed": wp.seed,
        "start": wp.start.isoformat(),
        "days": wp.days,
        "profile": wp.profile,
        "capacity": cfg.capacity,
        "arrivals_per_day": wp.arrivals_per_day if wp.arrivals_per_day is not None else DEFAULT_ARRIVALS_PER_CAPACITY * cfg.capacity,
        "weekend_factor": wp.weekend_factor,
        "regulars_share": wp.regulars_share,
        "regulars_pool": wp.regulars_pool if wp.regulars_pool is not None else int(1.5 * cfg.capacity),
        "close_follow_rate": wp.close_follow_rate,
        "overnight_rate": wp.overnight_rate,
        "noise": noise.to_dict(),
        "outages": [o.to_dict() for o in outages],
        "timezone": cfg.timezone,
        "start_utc": iso(world.start_utc),
    }
    return SimResult(cfg=cfg, start_utc=world.start_utc, end_utc=world.end_utc, visits=world.visits,
                     passes=world.passes, events=events, heartbeats=heartbeats, params=params,
                     counts=counts, outages=outages)
