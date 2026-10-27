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
    # Query for the plate reader's own RTSP session, e.g. "fps=10": the reader can't
    # keep up with full frame rate on the CPU, while the recorder keeps the full stream.
    inference_query: str = ""

    @property
    def rtsp_url(self) -> str:
        """Full URL including credentials. Never log or persist this."""
        return self._url(self.query)

    @property
    def inference_url(self) -> str:
        """Like rtsp_url, for the plate reader's stream. Never log or persist this."""
        return self._url(self.inference_query or self.query)

    def _url(self, query: str) -> str:
        auth = ""
        if self.user:
            auth = (
                f"{urllib.parse.quote(self.user, safe='')}:"
                f"{urllib.parse.quote(self.password, safe='')}@"
            )
        query = f"?{query}" if query else ""
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


def with_credentials(camera: Camera) -> Camera:
    """Fill in one camera's user/password (env first, then .camera_config) - so
    opening one camera never requires the other cameras' credentials."""
    camera.user, camera.password = _resolve_credentials(
        {"credentials_env": camera.credentials_env}, camera.camera_id
    )
    return camera


_UUID_RE = re.compile(r"^[0-9A-Za-z-]{4,64}$")


def load(path: Path | None = None, credentials: bool = True) -> RecorderConfig:
    """credentials=False: skip credential lookup (and leave user/password empty), for
    tools that only need the drive UUID and camera list, never a stream."""
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
        user, password = _resolve_credentials(cam, camera_id) if credentials else ("", "")
        cameras[camera_id] = Camera(
            camera_id=camera_id,
            ip=cam["ip"],
            path=cam.get("path", "/axis-media/media.amp"),
            credentials_env=cam.get("credentials_env", ""),
            user=user,
            password=password,
            query=cam.get("query", ""),
            inference_query=cam.get("inference_query", ""),
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


def main(argv: list[str] | None = None) -> int:
    """Shell helper for run_pipeline.sh: list cameras, or print one camera's URL
    (for `export`, never for argv - the URL carries the password)."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Inspect recorder.config.json")
    parser.add_argument("--config", type=Path, default=None)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="print '<camera_id> <ip>' per camera")
    group.add_argument("--print-url", metavar="CAMERA_ID")
    group.add_argument("--drive-uuid", action="store_true", help="print the configured drive UUID")
    parser.add_argument("--inference", action="store_true",
                        help="with --print-url: the plate reader's URL (inference_query)")
    args = parser.parse_args(argv)
    try:
        cfg = load(args.config, credentials=False)
        if args.list:
            for cam in cfg.cameras.values():
                print(cam.camera_id, cam.ip)
        elif args.drive_uuid:
            print(cfg.drive_uuid)
        else:
            cam = with_credentials(cfg.camera(args.print_url))
            print(cam.inference_url if args.inference else cam.rtsp_url)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
