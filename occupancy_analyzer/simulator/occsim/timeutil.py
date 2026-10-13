"""Time helpers: ISO formatting identical to the producer, duration parsing."""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc

_DUR_PART = re.compile(r"(\d+(?:\.\d+)?)(ms|d|h|m|s)?")
_DUR_UNITS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, None: 1}


def parse_duration(text) -> timedelta:
    """'3h', '20m', '90s', '1.5h', '250ms', '1h30m', '-2s'; bare number = seconds."""
    if isinstance(text, timedelta):
        return text
    if isinstance(text, (int, float)):
        return timedelta(seconds=float(text))
    s = str(text).strip().replace(" ", "")
    sign = -1.0 if s.startswith("-") else 1.0
    s = s.lstrip("+-")
    if not s:
        raise ValueError(f"bad duration: {text!r}")
    pos, total = 0, 0.0
    while pos < len(s):
        m = _DUR_PART.match(s, pos)
        if not m:
            raise ValueError(f"bad duration: {text!r}")
        total += float(m.group(1)) * _DUR_UNITS[m.group(2)]
        pos = m.end()
    return timedelta(seconds=sign * total)


def iso(dt: datetime) -> str:
    """Producer format: datetime.isoformat() of an aware UTC datetime, always
    with microseconds (e.g. 2026-08-14T14:24:47.042426+00:00)."""
    return dt.astimezone(UTC).isoformat(timespec="microseconds")


def parse_iso(text: str) -> datetime:
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError(f"timestamp without offset: {text!r}")
    return dt.astimezone(UTC)


def folder_stamp(dt: datetime) -> str:
    """Producer folder prefix: %Y%m%dT%H%M%S%f + 'Z'."""
    return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%S%f") + "Z"


def local_midnight(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=tz).astimezone(UTC)


def parse_local_or_iso(text: str, tz: ZoneInfo, base_date: date | None = None) -> datetime:
    """Parse '2026-10-14T10:00' (lot-local when no offset), a full ISO string
    with offset, or 'HH:MM[:SS]' on base_date (lot-local)."""
    text = str(text).strip()
    if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?", text):
        if base_date is None:
            raise ValueError(f"time-of-day {text!r} needs a base date")
        t = time.fromisoformat(text if text.count(":") == 2 else text + ":00")
        return datetime.combine(base_date, t, tzinfo=tz).astimezone(UTC)
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(UTC)


def covers_local_hour(start: datetime, end: datetime, tz: ZoneInfo, hour: int = 3) -> bool:
    """True if [start, end] contains a local `hour`:00 instant (overnight flag)."""
    if end < start:
        return False
    local = start.astimezone(tz)
    d = local.date()
    while True:
        candidate = datetime.combine(d, time(hour, 0), tzinfo=tz).astimezone(UTC)
        if candidate > end:
            return False
        if candidate >= start:
            return True
        d = d + timedelta(days=1)
