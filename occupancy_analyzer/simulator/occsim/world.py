"""World model: who really entered / left the lot and when (ground truth).

Arrivals are a non-homogeneous Poisson process (piecewise constant per
30-minute bucket, lot-local profile); dwell is a mixture conditioned on the
arrival hour; capacity bounces; regulars pool; close-following pairs.
"""

from __future__ import annotations

import heapq
import math
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from .config import SimConfig
from .plates import PlatePool
from .timeutil import UTC, covers_local_hour, local_midnight

# Relative arrival intensity per local hour (weekday). Morning peak 07–09,
# lunch churn 11:30–13:30 (boost applied per half hour below), evening low.
WEEKDAY_HOURLY = [
    0.15, 0.08, 0.06, 0.06, 0.15, 0.6,   # 00–05
    2.2, 6.5, 7.0, 4.0, 2.8, 2.8,        # 06–11
    3.2, 3.0, 2.4, 2.3, 2.0, 1.6,        # 12–17
    1.3, 1.0, 0.7, 0.5, 0.3, 0.2,        # 18–23
]
# Weekend: flatter, centred on late morning / early afternoon.
WEEKEND_HOURLY = [
    0.2, 0.1, 0.08, 0.06, 0.08, 0.2,
    0.6, 1.4, 2.4, 3.4, 4.0, 4.2,
    4.2, 4.0, 3.6, 3.0, 2.4, 1.8,
    1.4, 1.1, 0.8, 0.6, 0.4, 0.3,
]
LUNCH_BOOST = 1.6  # applied to half-hour buckets in [11:30, 13:30)
# Default weekday arrivals = this × capacity (~245 incl. close followers for capacity 100: the lot
# fills at the morning peak and a few percent of arrivals bounce).
DEFAULT_ARRIVALS_PER_CAPACITY = 2.4

# Dwell mixture (doc 14 §3.3). Minutes.
DWELL_CLASSES = {
    "short": (0.30, 5, 30),
    "medium": (0.35, 60, 180),
    "commuter": (0.33, 450, 570),
    "overnight": (0.02, 12 * 60, 40 * 60),
}


def commuter_factor(local_hour: int) -> float:
    """Commuters mostly arrive in the morning; an 8 h stay starting at 19:00 is
    rare. Conditioning keeps the evening drain at 16–18 realistic."""
    if 5 <= local_hour <= 9:
        return 2.2
    if 10 <= local_hour <= 11:
        return 1.0
    if 12 <= local_hour <= 14:
        return 0.4
    return 0.08


@dataclass
class WorldParams:
    start: date
    days: int = 1
    seed: int = 42
    profile: str = "auto"  # auto | weekday | weekend
    arrivals_per_day: float | None = None  # weekday volume; default 2.4 × capacity
    weekend_factor: float = 0.4
    regulars_share: float = 0.40
    regulars_pool: int | None = None  # default 1.5 × capacity
    close_follow_rate: float = 0.03
    overnight_rate: float = 0.02


@dataclass
class Visit:
    visit_id: str
    plate: str
    jurisdiction: str
    is_regular: bool
    dwell_class: str
    entry_at: datetime | None
    exit_at: datetime | None  # None: still in the lot at the end of the horizon
    is_bounce: bool = False
    close_follow: bool = False
    tz: str = "America/New_York"

    @property
    def dwell_min(self) -> float | None:
        if self.entry_at is None or self.exit_at is None:
            return None
        return (self.exit_at - self.entry_at).total_seconds() / 60.0

    def is_overnight(self, horizon_end: datetime) -> bool:
        if self.entry_at is None:
            return False
        return covers_local_hour(self.entry_at, self.exit_at or horizon_end, ZoneInfo(self.tz), 3)

    def is_multi_day(self, horizon_end: datetime) -> bool:
        if self.entry_at is None:
            return False
        return ((self.exit_at or horizon_end) - self.entry_at) > timedelta(hours=24)


@dataclass
class TruePass:
    pass_id: str
    visit_id: str
    camera_id: str
    direction: str  # in | out
    at: datetime
    plate: str
    # Filled by the camera model: emitted | missed | rejected | lost_outage | suppressed
    outcome: str = "pending"
    event_ids: list[str] = field(default_factory=list)
    plate_text: str | None = None


@dataclass
class World:
    start_utc: datetime
    end_utc: datetime
    capacity: int
    visits: list[Visit]
    passes: list[TruePass]
    stats: dict

    def occupancy_changes(self) -> list[tuple[datetime, int, int, str, str]]:
        """[(at, delta, occupancy_after, cause, plate)] in time order (exits
        before entries on exact ties)."""
        changes = []
        for p in self.passes:
            changes.append((p.at, 1 if p.direction == "in" else -1, p.direction, p.plate))
        changes.sort(key=lambda c: (c[0], c[1]))
        occ, out = 0, []
        for at, delta, direction, plate in changes:
            occ += delta
            out.append((at, delta, occ, "entry" if direction == "in" else "exit", plate))
        return out

    def true_occupancy_at(self, t: datetime) -> int:
        occ = 0
        for p in self.passes:
            if p.at <= t:
                occ += 1 if p.direction == "in" else -1
        return occ


def _poisson(rng: random.Random, lam: float) -> int:
    if lam <= 0:
        return 0
    if lam > 30:  # normal approximation, plenty for half-hour buckets
        return max(0, int(round(rng.gauss(lam, math.sqrt(lam)))))
    l, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= l:
            return k
        k += 1


def _is_weekend(local_dt: datetime, profile: str) -> bool:
    if profile == "weekday":
        return False
    if profile == "weekend":
        return True
    return local_dt.weekday() >= 5


def arrival_times(rng: random.Random, start_utc: datetime, end_utc: datetime,
                  tz: ZoneInfo, per_day: float, weekend_factor: float, profile: str) -> list[datetime]:
    """Piecewise-constant NHPP over 30-minute UTC buckets, weighted by the
    lot-local hour (DST handled because buckets are stepped in UTC)."""
    wd_total = sum(WEEKDAY_HOURLY) + (LUNCH_BOOST - 1) * 0.5 * (WEEKDAY_HOURLY[11] + 2 * WEEKDAY_HOURLY[12] + WEEKDAY_HOURLY[13])
    we_total = sum(WEEKEND_HOURLY)
    out = []
    t = start_utc
    step = timedelta(minutes=30)
    while t < end_utc:
        local = t.astimezone(tz)
        weekend = _is_weekend(local, profile)
        hourly = WEEKEND_HOURLY if weekend else WEEKDAY_HOURLY
        w = hourly[local.hour] * 0.5
        minute_of_day = local.hour * 60 + local.minute
        if not weekend and 11 * 60 + 30 <= minute_of_day < 13 * 60 + 30:
            w *= LUNCH_BOOST
        if weekend:
            lam = per_day * weekend_factor * w / we_total
        else:
            lam = per_day * w / wd_total
        span = min(step, end_utc - t).total_seconds()
        lam *= span / step.total_seconds()
        for _ in range(_poisson(rng, lam)):
            out.append(t + timedelta(seconds=rng.uniform(0, span)))
        t += step
    out.sort()
    return out


def draw_dwell(rng: random.Random, local_hour: int, overnight_rate: float) -> tuple[str, timedelta]:
    # day classes re-weighted by arrival hour, then scaled so that the
    # overnight/multi-day tail is exactly `overnight_rate`
    weights = {
        name: w * (commuter_factor(local_hour) if name == "commuter" else 1.0)
        for name, (w, _, _) in DWELL_CLASSES.items() if name != "overnight"
    }
    norm = sum(weights.values())
    weights = {k: v / norm * (1.0 - overnight_rate) for k, v in weights.items()}
    weights["overnight"] = overnight_rate
    x, acc = rng.random(), 0.0
    chosen = "medium"
    for name in ("short", "medium", "commuter", "overnight"):
        acc += weights[name]
        if x < acc:
            chosen = name
            break
    _, lo, hi = DWELL_CLASSES[chosen]
    return chosen, timedelta(minutes=rng.uniform(lo, hi))


def simulate_world(cfg: SimConfig, params: WorldParams) -> World:
    tz = ZoneInfo(cfg.timezone)
    rng = random.Random(f"{params.seed}:world")
    start_utc = local_midnight(params.start, tz)
    end_utc = local_midnight(params.start + timedelta(days=params.days), tz)
    capacity = cfg.capacity
    per_day = params.arrivals_per_day if params.arrivals_per_day is not None else DEFAULT_ARRIVALS_PER_CAPACITY * capacity
    pool = PlatePool(random.Random(f"{params.seed}:plates"),
                     params.regulars_pool if params.regulars_pool is not None else int(1.5 * capacity))

    base_arrivals = arrival_times(rng, start_utc, end_utc, tz, per_day, params.weekend_factor, params.profile)
    # close-following: a second car 1–3 s behind
    arrivals: list[tuple[datetime, bool]] = []
    for t in base_arrivals:
        arrivals.append((t, False))
        if rng.random() < params.close_follow_rate:
            arrivals.append((t + timedelta(seconds=rng.uniform(1.0, 3.0)), True))
    arrivals.sort(key=lambda a: a[0])

    cam_in = cfg.by_direction("in")
    cam_out = cfg.by_direction("out")
    present: list[tuple[datetime, str]] = []  # heap of (exit_at, plate)
    present_plates: set[str] = set()
    visits: list[Visit] = []
    stats = {"arrivals": 0, "bounces": 0, "regular_arrivals": 0, "close_follow": 0,
             "dwell_classes": {k: 0 for k in DWELL_CLASSES}, "still_present_at_end": 0,
             "peak_occupancy": 0}

    for i, (t, follower) in enumerate(arrivals):
        while present and present[0][0] <= t:
            _, plate = heapq.heappop(present)
            present_plates.discard(plate)
        # plate selection: regulars (not currently parked) or a fresh plate
        plate, is_regular = None, False
        if rng.random() < params.regulars_share:
            for _ in range(8):
                cand = rng.choice(pool.regulars) if pool.regulars else None
                if cand and cand not in present_plates:
                    plate, is_regular = cand, True
                    break
        if plate is None:
            plate = pool.new_plate()
        local_hour = t.astimezone(tz).hour
        if len(present) >= capacity:
            dwell_class, dwell = "bounce", timedelta(minutes=rng.uniform(1, 5))
            stats["bounces"] += 1
        else:
            dwell_class, dwell = draw_dwell(rng, local_hour, params.overnight_rate)
            stats["dwell_classes"][dwell_class] += 1
        exit_at = t + dwell
        heapq.heappush(present, (exit_at, plate))
        present_plates.add(plate)
        stats["peak_occupancy"] = max(stats["peak_occupancy"], len(present))
        stats["arrivals"] += 1
        stats["regular_arrivals"] += int(is_regular)
        stats["close_follow"] += int(follower)
        visits.append(Visit(
            visit_id=f"V{i + 1:06d}", plate=plate, jurisdiction=pool.jurisdiction[plate],
            is_regular=is_regular, dwell_class=dwell_class, entry_at=t,
            exit_at=exit_at if exit_at < end_utc else None,
            is_bounce=dwell_class == "bounce", close_follow=follower, tz=cfg.timezone,
        ))

    stats["still_present_at_end"] = sum(1 for v in visits if v.exit_at is None)
    stats["unique_plates"] = len({v.plate for v in visits})
    passes = build_passes(visits, cam_in.camera_id, cam_out.camera_id)
    return World(start_utc, end_utc, capacity, visits, passes, stats)


def build_passes(visits: list[Visit], in_cam: str, out_cam: str) -> list[TruePass]:
    raw = []
    for v in visits:
        if v.entry_at is not None:
            raw.append((v.entry_at, 0, v, "in"))
        if v.exit_at is not None:
            raw.append((v.exit_at, 1, v, "out"))
    raw.sort(key=lambda r: (r[0], r[1], r[2].visit_id))
    return [
        TruePass(pass_id=f"P{i + 1:06d}", visit_id=v.visit_id,
                 camera_id=in_cam if d == "in" else out_cam, direction=d, at=at, plate=v.plate)
        for i, (at, _, v, d) in enumerate(raw)
    ]


__all__ = ["World", "WorldParams", "Visit", "TruePass", "simulate_world", "build_passes", "UTC"]
