from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from occsim.camera import NoiseParams
from occsim.config import SimConfig
from occsim.generate import generate
from occsim.world import WorldParams
from occsim.writer import write_result


def make_cfg() -> SimConfig:
    """Hermetic config (same values as config/config.yaml v2) so tests don't
    depend on the gitignored repo-root config/."""
    return SimConfig()


def run_generate(out: Path, *, seed=42, days=1, start=date(2026, 10, 13), outages=None, wp_kw=None, **noise_kw):
    cfg = make_cfg()
    res = generate(cfg, WorldParams(start=start, days=days, seed=seed, **(wp_kw or {})),
                   NoiseParams(**noise_kw), outages or [])
    write_result(res, out)
    return res


@pytest.fixture
def cfg() -> SimConfig:
    return make_cfg()


@pytest.fixture(scope="session")
def sim_dir(tmp_path_factory) -> Path:
    """One simulated weekday with default noise and a backlog outage."""
    from occsim.generate import parse_outage

    out = tmp_path_factory.mktemp("sim") / "sim_out"
    cfg = make_cfg()
    outage = parse_outage("inbound_cam_01@2026-10-13T10:00/20m", cfg)
    res = generate(cfg, WorldParams(start=date(2026, 10, 13), days=1, seed=42), NoiseParams(), [outage])
    write_result(res, out)
    return out
