"""Heartbeat v1 stream per device (doc 13 §2, doc 14 §3.5)."""

from __future__ import annotations

import bisect
import random
from datetime import datetime, timedelta

from .camera import NoiseParams, Outage, SimEvent
from .config import SimConfig
from .timeutil import iso, parse_iso

APP_VERSION = "occsim-0.1.0"
DEGRADED_BACKLOG = 5  # pending_uploads at/above this -> status 'degraded'


def build_heartbeats(cfg: SimConfig, start: datetime, end: datetime, events: list[SimEvent],
                     outages: list[Outage], noise: NoiseParams, seed: int) -> dict[str, list[dict]]:
    """One heartbeat per device every `heartbeat.interval_s` over [start, end).

    pending_uploads(τ) = #events finalized by τ − #events released by τ, i.e.
    the local upload backlog; last_event_at_utc = latest finalized event.
    No heartbeats are emitted while an outage covers the device.
    """
    rng = random.Random(f"{seed}:heartbeat")
    interval = timedelta(seconds=cfg.heartbeat_interval_s)
    out: dict[str, list[dict]] = {}
    for cam in cfg.cameras:
        mine = [e for e in events if e.camera_dir == cam.camera_id]
        finals = sorted(parse_iso(e.payload["timestamp_utc"]) for e in mine)
        releases = sorted(e.release_at for e in mine)
        skew = noise.skew_for(cam.device_id)
        cam_outages = sorted((o for o in outages if o.camera_id == cam.camera_id), key=lambda o: o.start)
        process_start = start
        restarted = False
        beats = []
        t = start
        while t < end:
            o = next((o for o in cam_outages if o.covers(t)), None)
            if o is not None:
                if o.mode == "lost":
                    process_start = o.end  # device rebooted
                    restarted = True
                t += interval
                continue
            sent = t + skew
            n_final = bisect.bisect_right(finals, sent)
            n_released = bisect.bisect_right(releases, t)
            pending = max(0, n_final - n_released)
            last_event = finals[n_final - 1] if n_final else None
            status = "degraded" if pending >= DEGRADED_BACKLOG else "ok"
            message = None
            if status == "degraded":
                message = f"upload backlog: {pending}"
            elif restarted:
                message = "restarted after outage"
            restarted = False
            beats.append({
                "schema_version": 1,
                "type": "heartbeat",
                "device_id": cam.device_id,
                "camera_id": cam.camera_id,
                "sent_at_utc": iso(sent),
                "status": status,
                "camera_connected": True,
                "fps": round(rng.uniform(29.0, 30.0), 1),
                "last_event_at_utc": iso(last_event) if last_event else None,
                "pending_uploads": pending,
                "uptime_s": int((t - process_start).total_seconds()),
                "app_version": APP_VERSION,
                "message": message,
            })
            t += interval
        out[cam.camera_id] = beats
    return out
