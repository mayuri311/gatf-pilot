"""Config for the video recorder: drive UUID, segment policy, camera definitions.

Credentials never live in this file. They come from the environment or from the
existing ``.camera_config`` that capture.sh already writes, and they are never
persisted into the index, filenames, logs or the drive manifest — only a redacted
RTSP URL is stored.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = Path(__file__).resolve().parent / "recorder.config.json"
CAMERA_CONFIG = REPO_ROOT / ".camera_config"


class ConfigError(RuntimeError):
    pass


@dataclass
class Camera:
    camera_id: str
    ip: str
    path: str = "/axis-media/media.amp"
    credentials_env: str = ""
    user: str = ""
    password: str = ""
    query: str = ""  # e.g. "videokeyframeinterval=30" to force a short GOP

    @property
    def rtsp_url(self) -> str:
        """Full URL including credentials. Never log or persist this."""
        auth = ""
        if self.user:
            auth = (
                f"{urllib.parse.quote(self.user, safe='')}:"
                f"{urllib.parse.quote(self.password, safe='')}@"
            )
        query = f"?{self.query}" if self.query else ""
        return f"rtsp://{auth}{self.ip}{self.path}{query}"

    @property
    def rtsp_redacted(self) -> str:
        """Safe to store in SQLite and print to logs."""
        auth = "<redacted>@" if self.user else ""
        query = f"?{self.query}" if self.query else ""
        return f"rtsp://{auth}{self.ip}{self.path}{query}"


@dataclass
class RecorderConfig:
    drive_uuid: str
    segment_seconds: int = 300
    max_size_bytes: int = 0            # 0 = time-based splitting only
    fragmented_mp4: bool = True
    min_free_gb: float = 20.0
    retention: str = "delete_oldest"   # or "stop"
    rtsp_latency_ms: int = 200
    ntp_sync: bool = True
    reconnect_max_backoff_s: float = 30.0
    cameras: dict[str, Camera] = field(default_factory=dict)

    def camera(self, camera_id: str) -> Camera:
        if camera_id not in self.cameras:
            known = ", ".join(sorted(self.cameras)) or "(none defined)"
            raise ConfigError(f"Unknown camera_id {camera_id!r}. Configured: {known}")
        return self.cameras[camera_id]


def _parse_camera_config(path: Path) -> dict[str, str]:
    """Read the shell-style .camera_config that capture.sh already maintains."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        try:
            parts = shlex.split(raw)
        except ValueError:
            continue
        values[key.strip()] = parts[0] if parts else ""
    return values


def _resolve_credentials(cam: dict, camera_id: str) -> tuple[str, str]:
    """Env vars first (<PREFIX>_USER / <PREFIX>_PASS), then .camera_config."""
    prefix = cam.get("credentials_env", "")
    if prefix:
        user = os.environ.get(f"{prefix}_USER", "")
        password = os.environ.get(f"{prefix}_PASS", "")
        if user:
            return user, password

    fallback = _parse_camera_config(CAMERA_CONFIG)
    if fallback.get("CAM_USER"):
        return fallback["CAM_USER"], fallback.get("CAM_PASS", "")

    raise ConfigError(
        f"No credentials for camera {camera_id!r}. Set "
        f"{prefix or '<PREFIX>'}_USER and {prefix or '<PREFIX>'}_PASS in the environment, "
        f"or run scripts/capture.sh once to create {CAMERA_CONFIG}."
    )


_UUID_RE = re.compile(r"^[0-9A-Za-z-]{4,64}$")


def load(path: Path | None = None) -> RecorderConfig:
    path = path or DEFAULT_CONFIG
    if not path.exists():
        raise ConfigError(
            f"{path} not found. Copy recorder.config.example.json to recorder.config.json "
            f"and fill in your drive UUID and camera."
        )
    raw = json.loads(path.read_text())

    drive_uuid = str(raw.get("drive_uuid", "")).strip()
    if not _UUID_RE.match(drive_uuid):
        raise ConfigError(
            "drive_uuid is missing or malformed. Get it with `lsblk -o NAME,UUID` "
            "(Linux) or `diskutil info /Volumes/<name>` (macOS)."
        )

    cameras: dict[str, Camera] = {}
    for camera_id, cam in (raw.get("cameras") or {}).items():
        if not cam.get("ip"):
            raise ConfigError(f"Camera {camera_id!r} has no 'ip'.")
        user, password = _resolve_credentials(cam, camera_id)
        cameras[camera_id] = Camera(
            camera_id=camera_id,
            ip=cam["ip"],
            path=cam.get("path", "/axis-media/media.amp"),
            credentials_env=cam.get("credentials_env", ""),
            user=user,
            password=password,
            query=cam.get("query", ""),
        )

    if not cameras:
        raise ConfigError("No cameras defined in config.")

    cfg = RecorderConfig(
        drive_uuid=drive_uuid,
        segment_seconds=int(raw.get("segment_seconds", 300)),
        max_size_bytes=int(raw.get("max_size_bytes", 0)),
        fragmented_mp4=bool(raw.get("fragmented_mp4", True)),
        min_free_gb=float(raw.get("min_free_gb", 20.0)),
        retention=raw.get("retention", "delete_oldest"),
        rtsp_latency_ms=int(raw.get("rtsp_latency_ms", 200)),
        ntp_sync=bool(raw.get("ntp_sync", True)),
        reconnect_max_backoff_s=float(raw.get("reconnect_max_backoff_s", 30.0)),
        cameras=cameras,
    )
    if cfg.segment_seconds < 1:
        raise ConfigError("segment_seconds must be >= 1")
    if cfg.retention not in ("delete_oldest", "stop"):
        raise ConfigError("retention must be 'delete_oldest' or 'stop'")
    return cfg
