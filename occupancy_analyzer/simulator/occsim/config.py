"""Read lot / camera / heartbeat settings from the repo-root config/config.yaml (v2)."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

# occupancy_analyzer/simulator/occsim/config.py -> parents[3] == repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "config.yaml"
REPO_ENV_PATH = REPO_ROOT / ".env"


@dataclass(frozen=True)
class Camera:
    camera_id: str
    direction: str  # 'in' | 'out'
    device_id: str


@dataclass
class SimConfig:
    lot_id: str = "gatf_main"
    lot_name: str = "GATF Parking Lot"
    capacity: int = 100
    timezone: str = "America/New_York"
    cameras: list[Camera] = field(default_factory=lambda: [
        Camera("inbound_cam_01", "in", "jetson-in-01"),
        Camera("outbound_cam_01", "out", "jetson-out-01"),
    ])
    heartbeat_interval_s: int = 60
    offline_after_s: int = 180
    bucket: str = "event-snapshots"
    source_path: str | None = None

    def camera(self, camera_id: str) -> Camera:
        for c in self.cameras:
            if c.camera_id == camera_id:
                return c
        raise KeyError(f"unknown camera_id {camera_id!r}; config has "
                       f"{[c.camera_id for c in self.cameras]}")

    def by_direction(self, direction: str) -> Camera:
        for c in self.cameras:
            if c.direction == direction:
                return c
        raise KeyError(f"no camera with direction {direction!r}")

    def to_dict(self) -> dict:
        return {
            "lot_id": self.lot_id, "name": self.lot_name, "capacity": self.capacity,
            "timezone": self.timezone,
            "cameras": [c.__dict__ for c in self.cameras],
            "heartbeat_interval_s": self.heartbeat_interval_s,
            "offline_after_s": self.offline_after_s,
            "config_path": self.source_path,
        }


def load_config(path: str | os.PathLike | None = None, *, quiet: bool = False) -> SimConfig:
    """Load config.yaml. Order: explicit path, $OCCSIM_CONFIG, repo-root
    config/config.yaml. Missing file -> built-in defaults (with a warning) so
    the simulator still runs where config/ is gitignored (CI, fresh clone)."""
    candidate = path or os.environ.get("OCCSIM_CONFIG") or DEFAULT_CONFIG_PATH
    p = Path(candidate)
    if not p.exists():
        if path:
            raise FileNotFoundError(f"config not found: {p}")
        if not quiet:
            print(f"[occsim] warning: {p} not found; using built-in defaults", file=sys.stderr)
        return SimConfig()

    raw = yaml.safe_load(p.read_text()) or {}
    lot = raw.get("parkinglot") or {}
    cams = [
        Camera(str(c["camera_id"]), str(c["direction"]), str(c["device_id"]))
        for c in (raw.get("cameras") or [])
    ]
    hb = raw.get("heartbeat") or {}
    cfg = SimConfig(
        lot_id=str(lot.get("lot_id", "gatf_main")),
        lot_name=str(lot.get("name", "GATF Parking Lot")),
        capacity=int(lot.get("capacity", 100)),
        timezone=str(lot.get("timezone", "America/New_York")),
        cameras=cams or SimConfig().cameras,
        heartbeat_interval_s=int(hb.get("interval_s", 60)),
        offline_after_s=int(hb.get("offline_after_s", 180)),
        bucket=str((raw.get("supabase") or {}).get("bucket", "event-snapshots")),
        source_path=str(p),
    )
    directions = {c.direction for c in cfg.cameras}
    if not {"in", "out"} <= directions:
        raise ValueError(f"config needs one 'in' and one 'out' camera, got {directions}")
    return cfg
