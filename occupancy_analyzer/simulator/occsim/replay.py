"""`occsim replay`: push sim_out/ to Supabase in release order.

Talks to Supabase REST directly with httpx (no supabase-py):
  Storage  POST /storage/v1/object/<bucket>/<event_id>.jpg   (x-upsert: true)
  Events   POST /rest/v1/events?on_conflict=event_id         (Prefer: resolution=merge-duplicates)
  Beats    POST /rest/v1/rpc/report_heartbeat                {"hb": {...}}
  Actions  reconcile_preview / reconcile_commit / resolve_match / lots PATCH / any rpc

Pacing: --fast (no sleeps), --speed N (N sim-seconds per real second), or
--rebase-now X (shift every timestamp so the first event lands at now − X,
send what is already in the past immediately, then pace in real time).
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

import httpx

from .config import REPO_ENV_PATH
from .contract import db_row
from .timeutil import UTC, iso, parse_iso

LOCAL_URL = "http://127.0.0.1:54321"
KIND_PRIORITY = {"event": 0, "heartbeat": 1, "action": 2}
STALE_HEARTBEAT = timedelta(minutes=5)
NEW_ID_NAMESPACE = uuid.UUID("6f1d3c3e-5f7a-4f43-9b7e-0c2a7d9b8e11")


class ReplayError(RuntimeError):
    pass


# --------------------------------------------------------------------------- target


def resolve_target(target: str, url: str | None = None, key: str | None = None) -> tuple[str, str]:
    """(base_url, service_key) for --target local|hosted."""
    if target == "hosted":
        try:
            from dotenv import load_dotenv
            load_dotenv(REPO_ENV_PATH)
        except ImportError:  # pragma: no cover
            pass
        base = url or os.environ.get("SUPABASE_URL")
        k = key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SECRET_KEY")
        if not base:
            raise ReplayError(f"--target hosted needs SUPABASE_URL (env or {REPO_ENV_PATH})")
    elif target == "local":
        base = url or LOCAL_URL
        k = key or os.environ.get("LOCAL_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    else:
        raise ReplayError(f"unknown target {target!r}")
    if not k:
        raise ReplayError("no service key: pass --key, or set LOCAL_SERVICE_ROLE_KEY "
                          "(local; `supabase status -o env` prints SERVICE_ROLE_KEY) / "
                          "SUPABASE_SERVICE_ROLE_KEY")
    return base.rstrip("/"), k


def make_client(base_url: str, key: str, transport: httpx.BaseTransport | None = None,
                timeout: float = 30.0) -> httpx.Client:
    return httpx.Client(base_url=base_url, transport=transport, timeout=timeout,
                        headers={"apikey": key, "Authorization": f"Bearer {key}"})


class SupabaseREST:
    """Thin PostgREST / Storage wrapper with retries on 5xx and transport errors."""

    def __init__(self, client: httpx.Client, bucket: str = "event-snapshots",
                 sleep: Callable[[float], None] = time.sleep, retries: int = 3,
                 admin_token: str | None = None):
        self.client = client
        self.bucket = bucket
        self.sleep = sleep
        self.retries = retries
        self.admin_token = admin_token

    def _request(self, method: str, url: str, **kw) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self.retries):
            try:
                r = self.client.request(method, url, **kw)
            except httpx.TransportError as e:
                last = e
            else:
                if r.status_code < 500:
                    if r.status_code >= 400:
                        raise ReplayError(f"{method} {url} -> {r.status_code}: {r.text[:300]}")
                    return r
                last = ReplayError(f"{method} {url} -> {r.status_code}: {r.text[:300]}")
            self.sleep(0.5 * 2 ** attempt)
        raise ReplayError(str(last))

    def upload_image(self, name: str, data: bytes) -> None:
        self._request("POST", f"/storage/v1/object/{self.bucket}/{name}", content=data,
                      headers={"content-type": "image/jpeg", "x-upsert": "true"})

    def upsert_event(self, row: dict) -> None:
        self._request("POST", "/rest/v1/events", params={"on_conflict": "event_id"}, json=row,
                      headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def rpc(self, name: str, params: dict, admin: bool = False):
        headers = {}
        if admin and self.admin_token:
            headers["Authorization"] = f"Bearer {self.admin_token}"
        r = self._request("POST", f"/rest/v1/rpc/{name}", json=params, headers=headers)
        return r.json() if r.content else None

    def heartbeat(self, hb: dict) -> None:
        self.rpc("report_heartbeat", {"hb": hb})

    def select(self, table: str, params: dict | None = None, page: int = 1000) -> list[dict]:
        rows, offset = [], 0
        while True:
            p = {"select": "*", **(params or {}), "limit": str(page), "offset": str(offset)}
            chunk = self._request("GET", f"/rest/v1/{table}", params=p).json()
            rows.extend(chunk)
            if len(chunk) < page:
                return rows
            offset += page

    def patch(self, table: str, filters: dict, body: dict) -> None:
        self._request("PATCH", f"/rest/v1/{table}", params=filters, json=body,
                      headers={"Prefer": "return=minimal"})

    def insert(self, table: str, body: dict, upsert: bool = True) -> None:
        prefer = "return=minimal" + (",resolution=merge-duplicates" if upsert else "")
        self._request("POST", f"/rest/v1/{table}", json=body, headers={"Prefer": prefer})


# --------------------------------------------------------------------------- schedule


@dataclass
class Item:
    at: datetime  # sim time at which to deliver
    kind: str  # event | heartbeat | action
    order: int
    data: dict = field(default_factory=dict)


def load_manifest(sim_dir: Path) -> dict:
    p = Path(sim_dir) / "manifest.json"
    if not p.exists():
        raise ReplayError(f"{p} not found (is this an occsim output folder?)")
    return json.loads(p.read_text())


def load_schedule(sim_dir: Path, manifest: dict, *, heartbeats: bool = True) -> list[Item]:
    items: list[Item] = []
    for r in manifest["release_schedule"]:
        items.append(Item(parse_iso(r["release_at"]), "event", r["order"], r))
    if heartbeats:
        n = 0
        for cam in manifest["lot"]["cameras"]:
            f = Path(sim_dir) / cam["camera_id"] / "heartbeats.jsonl"
            if not f.exists():
                continue
            for line in f.read_text().splitlines():
                if line.strip():
                    hb = json.loads(line)
                    items.append(Item(parse_iso(hb["sent_at_utc"]), "heartbeat", n, hb))
                    n += 1
    for i, a in enumerate(manifest.get("actions") or []):
        items.append(Item(parse_iso(a["at"]), "action", i, a))
    items.sort(key=lambda it: (it.at, KIND_PRIORITY[it.kind], it.order))
    return items


def _shift(ts: str | None, offset: timedelta) -> str | None:
    return iso(parse_iso(ts) + offset) if ts else ts


def shift_event(payload: dict, offset: timedelta) -> dict:
    p = dict(payload)
    for k in ("captured_at_utc", "timestamp_utc"):
        if isinstance(p.get(k), str):
            p[k] = _shift(p[k], offset)
    return p


def shift_heartbeat(hb: dict, offset: timedelta) -> dict:
    h = dict(hb)
    h["sent_at_utc"] = _shift(h["sent_at_utc"], offset)
    h["last_event_at_utc"] = _shift(h.get("last_event_at_utc"), offset)
    return h


def rebase_offset(manifest: dict, now: datetime, lead: timedelta) -> timedelta:
    """Offset so the first event is captured at (now − lead), floored to a
    whole minute so heartbeats stay minute-aligned."""
    caps = [parse_iso(r["captured_at_utc"]) for r in manifest["release_schedule"] if r.get("captured_at_utc")]
    first = min(caps) if caps else parse_iso(manifest["time_range"]["start_utc"])
    raw = (now - lead) - first
    return timedelta(minutes=raw // timedelta(minutes=1))


# --------------------------------------------------------------------------- replayer


@dataclass
class ReplayOptions:
    speed: float = 60.0
    fast: bool = False
    rebase_lead: timedelta | None = None  # None = no rebase
    shuffle_seed: int | None = None
    heartbeats: bool = True
    new_ids: bool = False
    dry_run: bool = False
    stop_on_error: bool = False
    lot_id: str = "gatf_main"
    until: datetime | None = None  # sim time; stop after this


class Replayer:
    def __init__(self, sim_dir: str | Path, api: SupabaseREST | None, opts: ReplayOptions, *,
                 now: Callable[[], datetime] = lambda: datetime.now(UTC),
                 sleep: Callable[[float], None] = time.sleep,
                 log: Callable[[str], None] = lambda m: print(m, file=sys.stderr)):
        self.sim_dir = Path(sim_dir)
        self.api = api
        self.opts = opts
        self.now = now
        self.sleep = sleep
        self.log = log
        self.manifest = load_manifest(self.sim_dir)
        self.stats = {"events": 0, "images": 0, "heartbeats": 0, "heartbeats_skipped_stale": 0,
                      "actions": 0, "actions_failed": 0, "errors": 0}
        self._image_cache: dict[str, bytes] = {}

    # ----- id remap (lets the same sim day be replayed again as new rows)
    def _event_id(self, eid: str, offset: timedelta) -> str:
        if not self.opts.new_ids:
            return eid
        return str(uuid.uuid5(NEW_ID_NAMESPACE, f"{eid}:{int(offset.total_seconds())}"))

    def _send_event(self, item: Item, offset: timedelta) -> None:
        r = item.data
        folder = self.sim_dir / r["path"]
        payload = json.loads((folder / "event.json").read_text())
        payload = shift_event(payload, offset)
        payload["event_id"] = self._event_id(payload["event_id"], offset)
        row = db_row(payload)
        image = folder / payload.get("image_filename", "plate.jpg")
        if self.opts.dry_run:
            self.log(f"[dry-run] event {row['event_id']} {row['camera_id']} {row['plate_text']} "
                     f"captured {row['captured_at_utc']}")
        else:
            data = self._image_cache.get(str(image))
            if data is None:
                data = image.read_bytes()
                self._image_cache[str(image)] = data
            self.api.upload_image(row["image_path"], data)
            self.stats["images"] += 1
            self.api.upsert_event(row)
        self.stats["events"] += 1

    def _send_heartbeat(self, item: Item, offset: timedelta) -> None:
        hb = shift_heartbeat(item.data, offset)
        if not self.opts.dry_run:
            self.api.heartbeat(hb)
        self.stats["heartbeats"] += 1

    def _find_pass(self, plate: str, direction: str) -> str:
        rows = self.api.select("passes", {"select": "pass_id,event_at", "lot_id": f"eq.{self.opts.lot_id}",
                                          "plate_norm": f"eq.{plate}", "direction": f"eq.{direction}",
                                          "order": "event_at.desc"})
        if not rows:
            raise ReplayError(f"no {direction} pass with plate_norm={plate}")
        return rows[0]["pass_id"]

    def _run_action(self, item: Item, offset: timedelta) -> None:
        a = dict(item.data)
        kind = a.get("action")
        lot = a.get("lot", self.opts.lot_id)
        if self.opts.dry_run:
            self.log(f"[dry-run] action {kind} {a}")
            self.stats["actions"] += 1
            return
        if kind == "reconcile":
            prev = self.api.rpc("reconcile_preview", {"p_lot": lot, "p_visual_count": int(a["visual_count"])},
                                admin=True)
            proposed = [p["session_id"] for p in (prev or {}).get("proposed", [])]
            n = int(a.get("close", len(proposed)))
            res = self.api.rpc("reconcile_commit", {
                "p_lot": lot, "p_visual_count": int(a["visual_count"]), "p_close": proposed[:n],
                "p_note": a.get("note", "occsim scenario reconcile")}, admin=True)
            self.log(f"[action] reconcile visual={a['visual_count']} closed={len(proposed[:n])} -> {res}")
        elif kind == "resolve_match":
            exit_pass = self._find_pass(a["exit_plate"], "out")
            entry_pass = self._find_pass(a["entry_plate"], "in") if a.get("entry_plate") else None
            res = self.api.rpc("resolve_match", {"p_exit_pass": exit_pass, "p_entry_pass": entry_pass,
                                                 "p_note": a.get("note")}, admin=True)
            self.log(f"[action] resolve_match {a['exit_plate']} -> {a.get('entry_plate')}: {res}")
        elif kind == "set_capacity":
            at = iso(item.at + offset)
            self.api.patch("lots", {"lot_id": f"eq.{lot}"}, {"capacity": int(a["capacity"])})
            self.api.insert("lot_capacity_history", {"lot_id": lot, "capacity": int(a["capacity"]),
                                                     "valid_from": at})
            self.log(f"[action] capacity {lot} -> {a['capacity']} from {at}")
        elif kind == "rpc":
            res = self.api.rpc(a["name"], a.get("params") or {}, admin=True)
            self.log(f"[action] rpc {a['name']} -> {res}")
        else:
            raise ReplayError(f"unknown action {kind!r}")
        self.stats["actions"] += 1

    def run(self) -> dict:
        o = self.opts
        items = load_schedule(self.sim_dir, self.manifest, heartbeats=o.heartbeats)
        if o.until is not None:
            items = [it for it in items if it.at <= o.until]
        if o.shuffle_seed is not None:
            # engine robustness check: same rows, random arrival order (heartbeats/actions keep time order)
            evs = [it for it in items if it.kind == "event"]
            random.Random(o.shuffle_seed).shuffle(evs)
            others = [it for it in items if it.kind != "event"]
            items = evs + others
        if not items:
            self.log("nothing to replay")
            return self.stats

        wall0 = self.now()
        offset = rebase_offset(self.manifest, wall0, o.rebase_lead) if o.rebase_lead is not None else timedelta(0)
        sim0 = items[0].at
        if o.rebase_lead is not None:
            self.log(f"rebase: +{offset} (first event at {iso(sim0 + offset)}); "
                     f"{'no pacing' if o.fast else 'pacing in real time'}")
            future = sum(1 for it in items if it.kind != "heartbeat" and it.at + offset > wall0)
            if o.fast and future:
                self.log(f"[warn] --fast with --rebase-now: {future} events/actions are future-dated and will be "
                         f"sent now (the DB flags >5 min ahead as clock skew). Use a larger LEAD, e.g. "
                         f"--rebase-now {int((items[-1].at - sim0).total_seconds() // 3600) + 1}h")
        rebase = {"offset_seconds": offset.total_seconds(), "applied_at": iso(wall0),
                  "new_ids": o.new_ids, "shuffled": o.shuffle_seed is not None}

        for n, it in enumerate(items):
            # ---- pacing
            if o.rebase_lead is not None:
                due = it.at + offset
                if it.kind == "heartbeat" and due < self.now() - STALE_HEARTBEAT:
                    self.stats["heartbeats_skipped_stale"] += 1
                    continue
                if not o.fast:
                    wait = (due - self.now()).total_seconds()
                    if wait > 0:
                        self.sleep(wait)
            elif not o.fast and o.shuffle_seed is None:
                due_wall = wall0 + (it.at - sim0) / max(o.speed, 1e-9)
                wait = (due_wall - self.now()).total_seconds()
                if wait > 0:
                    self.sleep(wait)
            # ---- delivery
            try:
                if it.kind == "event":
                    self._send_event(it, offset)
                elif it.kind == "heartbeat":
                    self._send_heartbeat(it, offset)
                else:
                    self._run_action(it, offset)
            except (ReplayError, httpx.HTTPError, OSError, KeyError) as e:
                self.stats["errors"] += 1
                if it.kind == "action":
                    self.stats["actions_failed"] += 1
                self.log(f"[error] {it.kind} @ {iso(it.at)}: {e}")
                if o.stop_on_error:
                    break
            if (n + 1) % 500 == 0:
                self.log(f"... {n + 1}/{len(items)} items, sim time {iso(it.at)}")

        if not o.dry_run:
            self._record(rebase)
        return self.stats

    def _record(self, rebase: dict) -> None:
        """Persist the time offset so `occsim evaluate` can map DB times back."""
        m = load_manifest(self.sim_dir)
        m["rebase"] = rebase
        m.setdefault("replays", []).append({**rebase, "stats": dict(self.stats)})
        (self.sim_dir / "manifest.json").write_text(json.dumps(m, indent=2, default=str))
