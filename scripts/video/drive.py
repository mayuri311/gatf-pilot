"""Address the external SSD by filesystem UUID, never by mountpoint.

USB enumeration order and mountpoint names change every time the drive is moved to a
different port or cable; the filesystem UUID does not. Everything here takes a UUID
and resolves it to wherever the OS happened to mount the drive this time.

Find the UUID with:
    Linux/Jetson:  lsblk -o NAME,UUID,LABEL,FSTYPE,MOUNTPOINT
                   blkid /dev/sda1
    macOS:         diskutil info /Volumes/<name>     ("Volume UUID")
"""

from __future__ import annotations

import json
import plistlib
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# Everything this project writes lives under one directory on the drive, so the SSD
# can be shared with unrelated data without us ever walking outside our own tree.
GATF_DIR = "gatf"
DRIVE_MANIFEST = "drive.json"
SCHEMA_VERSION = 1


class DriveError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 15) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise DriveError(f"{' '.join(cmd)} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout


# --------------------------------------------------------------------------- Linux


def _linux_device_for_uuid(uuid: str) -> Path:
    link = Path("/dev/disk/by-uuid") / uuid
    if not link.exists():
        raise DriveError(
            f"No device with UUID {uuid} is attached "
            f"(nothing at {link}). Check `lsblk -o NAME,UUID,MOUNTPOINT`."
        )
    return link.resolve()


def _linux_mountpoint(uuid: str) -> Path:
    device = _linux_device_for_uuid(uuid)
    out = _run(["findmnt", "-no", "TARGET", "--source", str(device)]).strip()
    if not out:
        raise DriveError(
            f"Device {device} (UUID {uuid}) is attached but not mounted. "
            f"Mount it first, e.g. `udisksctl mount -b {device}`."
        )
    return Path(out.splitlines()[0])


def _linux_uuid_at(mountpoint: Path) -> str:
    return _run(["findmnt", "-no", "UUID", "--target", str(mountpoint)]).strip()


def _linux_fstype(mountpoint: Path) -> str:
    return _run(["findmnt", "-no", "FSTYPE", "--target", str(mountpoint)]).strip()


# --------------------------------------------------------------------------- macOS
# Kept so the tooling is usable from a dev laptop; the Orin Nano is the supported target.


def _macos_info(identifier: str) -> dict:
    out = subprocess.run(
        ["diskutil", "info", "-plist", identifier], capture_output=True, timeout=15
    )
    if out.returncode != 0:
        # diskutil reports failures as a plist too, with the real reason inside.
        detail = out.stderr.decode().strip()
        try:
            detail = plistlib.loads(out.stdout).get("ErrorMessage", detail)
        except Exception:  # noqa: BLE001 - fall back to raw stderr
            pass
        raise DriveError(
            f"No attached volume matches {identifier!r}"
            + (f": {detail}" if detail else "")
            + ". Check `diskutil list` / `diskutil info /Volumes/<name>`."
        )
    return plistlib.loads(out.stdout)


def _macos_mountpoint(uuid: str) -> Path:
    info = _macos_info(uuid)
    mount = info.get("MountPoint")
    if not mount:
        raise DriveError(f"Volume {uuid} is attached but not mounted.")
    return Path(mount)


def _macos_uuid_at(mountpoint: Path) -> str:
    info = _macos_info(str(mountpoint))
    return info.get("VolumeUUID") or info.get("DiskUUID") or ""


def _macos_fstype(mountpoint: Path) -> str:
    return _macos_info(str(mountpoint)).get("FilesystemType", "")


# --------------------------------------------------------------------------- public

_IS_LINUX = platform.system() == "Linux"


def mountpoint_for_uuid(uuid: str) -> Path:
    return _linux_mountpoint(uuid) if _IS_LINUX else _macos_mountpoint(uuid)


def uuid_at_path(path: Path) -> str:
    """Live filesystem UUID at a mountpoint, or "" if it cannot be determined.

    Returning "" rather than raising matters: verify_drive() must fall through to
    the manifest check instead of reporting a lookup failure as a UUID mismatch.
    """
    try:
        return _linux_uuid_at(path) if _IS_LINUX else _macos_uuid_at(path)
    except DriveError:
        return ""


def fstype_at_path(path: Path) -> str:
    try:
        return _linux_fstype(path) if _IS_LINUX else _macos_fstype(path)
    except DriveError:
        return ""


def gatf_root(mountpoint: Path) -> Path:
    return mountpoint / GATF_DIR


def video_root(gatf: Path) -> Path:
    return gatf / "video"


def db_path(gatf: Path) -> Path:
    return gatf / "index" / "segments.db"


def csv_path(gatf: Path) -> Path:
    return gatf / "index" / "segments.csv"


def log_dir(gatf: Path) -> Path:
    return gatf / "logs"


def init_drive(mountpoint: Path, drive_uuid: str, label: str = "") -> Path:
    """Create the directory tree and the self-describing manifest. Idempotent."""
    gatf = gatf_root(mountpoint)
    for d in (video_root(gatf), gatf / "index", log_dir(gatf)):
        d.mkdir(parents=True, exist_ok=True)

    manifest = gatf / DRIVE_MANIFEST
    if not manifest.exists():
        manifest.write_text(
            json.dumps(
                {
                    "drive_uuid": drive_uuid,
                    "label": label,
                    "filesystem": fstype_at_path(mountpoint),
                    "created_utc": datetime.now(timezone.utc).isoformat(),
                    "schema_version": SCHEMA_VERSION,
                },
                indent=2,
            )
            + "\n"
        )
    return gatf


def read_manifest(mountpoint: Path) -> dict:
    manifest = gatf_root(mountpoint) / DRIVE_MANIFEST
    if not manifest.exists():
        raise DriveError(
            f"{manifest} not found — this drive has not been initialised. "
            f"Run: python -m scripts.video.recorder --init-drive"
        )
    return json.loads(manifest.read_text())


def verify_drive(mountpoint: Path, expected_uuid: str) -> dict:
    """Refuse to touch the drive unless config, filesystem and manifest all agree.

    This is the guard against silently recording onto whatever disk happened to get
    mounted at the same path after a re-plug.
    """
    live_uuid = uuid_at_path(mountpoint)
    if live_uuid and live_uuid.lower() != expected_uuid.lower():
        raise DriveError(
            f"Refusing to write: {mountpoint} has UUID {live_uuid}, "
            f"but the config expects {expected_uuid}."
        )
    manifest = read_manifest(mountpoint)
    if manifest.get("drive_uuid", "").lower() != expected_uuid.lower():
        raise DriveError(
            f"Refusing to write: {mountpoint}/{GATF_DIR}/{DRIVE_MANIFEST} claims UUID "
            f"{manifest.get('drive_uuid')}, but the config expects {expected_uuid}."
        )
    return manifest


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(str(path)).free


def resolve(expected_uuid: str, verify: bool = True) -> tuple[Path, Path]:
    """UUID -> (mountpoint, gatf_root), verified. The one call recorders should use."""
    mountpoint = mountpoint_for_uuid(expected_uuid)
    if verify:
        verify_drive(mountpoint, expected_uuid)
    return mountpoint, gatf_root(mountpoint)
