#!/usr/bin/env python3
"""
Edge-system metrics for the Jetson: CPU, GPU, RAM, temperature, power, camera
and uplink bandwidth, SSD space/writes, and the upload/clip backlogs.

Every --interval seconds (default 5) one snapshot is:
  - appended to <gatf>/metrics/metrics-YYYY-MM-DD.jsonl  (full local history)
  - written to  <gatf>/state/metrics_latest.json          (read by heartbeats)

The plate readers' heartbeats attach the latest snapshot's `system` block plus
their own camera's bitrate (heartbeat.load_metrics_summary), which is how it
reaches device_heartbeats.metrics and the dashboard's health page.

Sources:
  - psutil: CPU per core, load, RAM/swap, per-NIC byte counters, disk I/O
  - tegrastats: GPU load (GR3D_FREQ), SoC temperatures, VDD_IN board power
  - segments.db: per-camera stream bitrate = bytes / seconds of the segments
    each recorder closed in the last BITRATE_WINDOW_S - exact, per camera,
    which the shared camera NIC counter can't give
  - state/uploader.json, state/clipper.json: backlogs from those processes

Usage (from the repo root; run_pipeline.sh starts it):
    python scripts/sysmetrics.py --gatf /mnt/validation/gatf
    python scripts/sysmetrics.py --gatf /mnt/validation/gatf --watch   # live view
"""

import argparse
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

BITRATE_WINDOW_S = 60
DEFAULT_CAMERA_IFACE = "enP8p1s0"

_GR3D_RE = re.compile(r"GR3D_FREQ (\d+)%")
_TEMP_RE = re.compile(r"(\w+)@(-?[\d.]+)C")
_VDD_IN_RE = re.compile(r"VDD_IN (\d+)mW")


def parse_tegrastats(line):
    """One tegrastats line -> {gpu_pct, temps{name: C}, power_w}. Fields the
    line doesn't have are left out."""
    out = {}
    m = _GR3D_RE.search(line)
    if m:
        out["gpu_pct"] = float(m.group(1))
    temps = {name: float(v) for name, v in _TEMP_RE.findall(line)}
    if temps:
        out["temps"] = temps
    m = _VDD_IN_RE.search(line)
    if m:
        out["power_w"] = round(int(m.group(1)) / 1000, 2)
    return out


class TegrastatsReader:
    """Keeps the most recent parsed tegrastats line, from a background thread."""

    def __init__(self, interval_ms):
        self.latest = {}
        self.proc = None
        if shutil.which("tegrastats") is None:
            return
        self.proc = subprocess.Popen(["tegrastats", "--interval", str(interval_ms)],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.latest = parse_tegrastats(line)

    def stop(self):
        if self.proc is not None:
            self.proc.terminate()


def default_route_iface():
    """Interface of the lowest-metric default route (the uplink), from /proc."""
    best = None
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            f = line.split()
            if len(f) > 6 and f[1] == "00000000" and int(f[3], 16) & 2:  # RTF_GATEWAY
                metric = int(f[6])
                if best is None or metric < best[1]:
                    best = (f[0], metric)
    except OSError:
        pass
    return best[0] if best else None


def camera_bitrates(db_path, now=None, window_s=BITRATE_WINDOW_S):
    """{camera_id: {"mbps", "last_segment_end_utc"}} from recently closed segments."""
    if not Path(db_path).exists():
        return {}
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(seconds=window_s)).isoformat()
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        rows = conn.execute(
            "SELECT camera_id, sum(size_bytes), sum(duration_s), max(end_utc)"
            " FROM segments WHERE end_utc >= ? GROUP BY camera_id", (since,)).fetchall()
        latest = dict(conn.execute(
            "SELECT camera_id, max(end_utc) FROM segments GROUP BY camera_id").fetchall())
    finally:
        conn.close()
    out = {cam: {"mbps": None, "last_segment_end_utc": end} for cam, end in latest.items()}
    for cam, size, dur, end in rows:
        if dur:
            out[cam] = {"mbps": round(size * 8 / dur / 1e6, 2), "last_segment_end_utc": end}
    return out


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


def ssd_device(path):
    """Block device name (e.g. 'sda') holding path, for psutil's per-disk I/O."""
    try:
        src = subprocess.run(["findmnt", "-no", "SOURCE", "--target", str(path)],
                             capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    name = Path(src).name
    return re.sub(r"(?<=[a-z])\d+$", "", name) if name.startswith("sd") else name


class Collector:
    def __init__(self, gatf, camera_iface=DEFAULT_CAMERA_IFACE, interval_s=5.0):
        import psutil
        self.psutil = psutil
        self.gatf = Path(gatf)
        self.camera_iface = camera_iface
        self.interval_s = interval_s
        self.tegra = TegrastatsReader(int(interval_s * 1000))
        self.disk = ssd_device(self.gatf)
        self._prev = None
        psutil.cpu_percent(percpu=True)  # prime: first call measures from now

    def _counters(self):
        net = self.psutil.net_io_counters(pernic=True)
        disks = self.psutil.disk_io_counters(perdisk=True) or {}
        return time.monotonic(), net, disks.get(self.disk)

    def sample(self):
        ps = self.psutil
        now_mono, net, disk = self._counters()
        per_core = ps.cpu_percent(percpu=True)
        vm, sw = ps.virtual_memory(), ps.swap_memory()
        usage = shutil.disk_usage(self.gatf)
        uplink = default_route_iface()

        rates = {}
        if self._prev is not None:
            t0, net0, disk0 = self._prev
            dt = max(now_mono - t0, 1e-6)

            def nic(iface, field):
                if iface in net and iface in net0:
                    return (getattr(net[iface], field) - getattr(net0[iface], field)) / dt
                return None

            rx = nic(self.camera_iface, "bytes_recv")
            rates["camera_rx_mbps"] = round(rx * 8 / 1e6, 2) if rx is not None else None
            tx, urx = nic(uplink, "bytes_sent"), nic(uplink, "bytes_recv")
            rates["uplink_tx_kbps"] = round(tx * 8 / 1e3, 1) if tx is not None else None
            rates["uplink_rx_kbps"] = round(urx * 8 / 1e3, 1) if urx is not None else None
            if disk is not None and disk0 is not None:
                rates["ssd_write_mbps"] = round((disk.write_bytes - disk0.write_bytes) / dt / 1e6, 2)
        self._prev = (now_mono, net, disk)

        tegra = self.tegra.latest
        temps = tegra.get("temps", {})
        uploader = read_json(self.gatf / "state" / "uploader.json")
        clipper = read_json(self.gatf / "state" / "clipper.json")
        try:
            cameras = camera_bitrates(self.gatf / "index" / "segments.db")
        except sqlite3.Error:
            cameras = {}

        now = datetime.now(timezone.utc)
        system = {
            "cpu_pct": round(sum(per_core) / len(per_core), 1) if per_core else None,
            "cpu_max_core_pct": max(per_core) if per_core else None,
            "load_1m": round(os.getloadavg()[0], 2),
            "ram_used_mb": round((vm.total - vm.available) / 2**20),
            "ram_total_mb": round(vm.total / 2**20),
            "swap_used_mb": round(sw.used / 2**20),
            "gpu_pct": tegra.get("gpu_pct"),
            "temp_c": temps.get("tj", max(temps.values()) if temps else None),
            "power_w": tegra.get("power_w"),
            "camera_iface": self.camera_iface,
            "camera_rx_mbps": rates.get("camera_rx_mbps"),
            "uplink_iface": uplink,
            "uplink_tx_kbps": rates.get("uplink_tx_kbps"),
            "uplink_rx_kbps": rates.get("uplink_rx_kbps"),
            "ssd_free_gb": round(usage.free / 1e9, 1),
            "ssd_total_gb": round(usage.total / 1e9, 1),
            "ssd_write_mbps": rates.get("ssd_write_mbps"),
            "upload_backlog": uploader.get("backlog"),
            "upload_oldest_age_s": uploader.get("oldest_pending_age_s"),
            "upload_gated": uploader.get("gated"),
            "upload_last_error": uploader.get("last_error"),
            "clip_backlog": clipper.get("backlog"),
        }
        return {
            "sampled_at_utc": now.isoformat(),
            "sampled_at_epoch": time.time(),
            "system": system,
            "cameras": cameras,
            # history only (not sent in heartbeats - keeps them small)
            "detail": {"cpu_per_core": per_core, "temps": temps,
                       "uploader": uploader, "clipper": clipper},
        }

    def write(self, snap):
        metrics_dir = self.gatf / "metrics"
        state_dir = self.gatf / "state"
        metrics_dir.mkdir(parents=True, exist_ok=True)
        state_dir.mkdir(parents=True, exist_ok=True)
        day = snap["sampled_at_utc"][:10]
        with open(metrics_dir / f"metrics-{day}.jsonl", "a") as f:
            f.write(json.dumps(snap) + "\n")
        tmp = state_dir / "metrics_latest.json.tmp"
        tmp.write_text(json.dumps(snap) + "\n")
        os.replace(tmp, state_dir / "metrics_latest.json")

    def run(self, stop):
        print(f"[metrics] every {self.interval_s:.0f}s -> {self.gatf / 'metrics'} "
              f"(camera iface {self.camera_iface}, ssd {self.disk})")
        while not stop.is_set():
            try:
                self.write(self.sample())
            except Exception as e:  # a bad sample must not stop collection
                print(f"[metrics] sample failed: {e}")
            stop.wait(self.interval_s)
        self.tegra.stop()


def _fmt(v, unit="", nd=1):
    if v is None:
        return "-"
    return f"{v:.{nd}f}{unit}" if isinstance(v, float) else f"{v}{unit}"


def watch(gatf, every_s=2.0):
    """Live terminal view of metrics_latest.json (works alongside the collector)."""
    path = Path(gatf) / "state" / "metrics_latest.json"
    while True:
        snap = read_json(path)
        s = snap.get("system", {})
        age = time.time() - snap.get("sampled_at_epoch", 0) if snap else None
        lines = [
            f"GATF edge metrics   {snap.get('sampled_at_utc', 'no data yet')}"
            + (f"   ({age:.0f}s old{' - STALE, is sysmetrics running?' if age > 30 else ''})"
               if age is not None else ""),
            "",
            f"  CPU   {_fmt(s.get('cpu_pct'), '%')} avg  {_fmt(s.get('cpu_max_core_pct'), '%')} max core"
            f"   load {_fmt(s.get('load_1m'), nd=2)}",
            f"  GPU   {_fmt(s.get('gpu_pct'), '%')}     temp {_fmt(s.get('temp_c'), ' C')}"
            f"   power {_fmt(s.get('power_w'), ' W', 2)}",
            f"  RAM   {_fmt(s.get('ram_used_mb'))} / {_fmt(s.get('ram_total_mb'))} MB"
            f"   swap {_fmt(s.get('swap_used_mb'))} MB",
            f"  NET   cameras ({s.get('camera_iface')}) rx {_fmt(s.get('camera_rx_mbps'), ' Mbps', 2)}"
            f"   uplink ({s.get('uplink_iface')}) tx {_fmt(s.get('uplink_tx_kbps'), ' kbps')}"
            f" rx {_fmt(s.get('uplink_rx_kbps'), ' kbps')}",
            f"  SSD   {_fmt(s.get('ssd_free_gb'), ' GB')} free of {_fmt(s.get('ssd_total_gb'), ' GB')}"
            f"   write {_fmt(s.get('ssd_write_mbps'), ' MB/s', 2)}",
            f"  QUEUE uploads {_fmt(s.get('upload_backlog'))} pending"
            f" (oldest {_fmt(s.get('upload_oldest_age_s'), ' s')}, gated={s.get('upload_gated')})"
            f"   clips {_fmt(s.get('clip_backlog'))} waiting",
        ]
        if s.get("upload_last_error"):
            lines.append(f"        last upload error: {s['upload_last_error'][:90]}")
        lines.append("")
        for cam, c in sorted((snap.get("cameras") or {}).items()):
            lines.append(f"  {cam:<18} {_fmt(c.get('mbps'), ' Mbps', 2):>11}"
                         f"   last segment {c.get('last_segment_end_utc') or '-'}")
        if not snap.get("cameras"):
            lines.append("  (no recorded segments yet - per-camera bitrate comes from the recorder)")
        sys.stdout.write("\033[2J\033[H" + "\n".join(lines) + "\n\n  Ctrl-C to quit\n")
        sys.stdout.flush()
        time.sleep(every_s)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gatf", default="/mnt/validation/gatf",
                    help="the drive's gatf/ directory")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--camera-iface", default=DEFAULT_CAMERA_IFACE,
                    help="NIC the cameras are on (its rx rate = total camera ingest)")
    ap.add_argument("--watch", action="store_true", help="live view of the latest snapshot")
    ap.add_argument("--once", action="store_true", help="print one snapshot as JSON, then exit")
    args = ap.parse_args()

    if args.watch:
        try:
            watch(args.gatf)
        except KeyboardInterrupt:
            pass
        sys.exit(0)

    collector = Collector(args.gatf, args.camera_iface, args.interval)
    if args.once:
        collector.sample()
        time.sleep(min(args.interval, 2))
        print(json.dumps(collector.sample(), indent=2))
        collector.tegra.stop()
        sys.exit(0)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    collector.run(stop)
