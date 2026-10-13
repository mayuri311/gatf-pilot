"""Plate pool (jurisdiction formats) and OCR confusion-pair noise."""

from __future__ import annotations

import random
import string

LETTERS = string.ascii_uppercase
DIGITS = string.digits

# Confusion groups observed in the real producer data (doc 14 §3.4).
CONFUSION_GROUPS = ["0ODQ", "1IL", "2Z", "5S", "8B", "6G", "PFR", "VWNMU"]
CONFUSABLE: dict[str, str] = {}
for _g in CONFUSION_GROUPS:
    for _c in _g:
        CONFUSABLE[_c] = CONFUSABLE.get(_c, "") + _g.replace(_c, "")

# Jurisdiction mix (doc 14 §3.3): weights must sum to 1.
JURISDICTIONS = [
    ("PA", 0.75),
    ("NJ", 0.10),
    ("NY", 0.08),
    ("MD", 0.04),
    ("VANITY", 0.03),
]

# PA plates avoid I/O/Q in the serial letters; harmless to mirror.
_SERIAL_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"


def make_plate(rng: random.Random, jurisdiction: str) -> str:
    L = lambda n: "".join(rng.choice(_SERIAL_LETTERS) for _ in range(n))  # noqa: E731
    D = lambda n: "".join(rng.choice(DIGITS) for _ in range(n))  # noqa: E731
    if jurisdiction in ("PA", "NY"):
        return L(3) + D(4)  # ABC1234
    if jurisdiction == "NJ":
        return L(1) + D(2) + L(3)  # A12BCD
    if jurisdiction == "MD":
        return D(1) + L(2) + D(4)  # 1AB2345
    if jurisdiction == "VANITY":
        n = rng.randint(4, 7)
        # mostly letters, the odd digit
        return "".join(rng.choice(LETTERS) if rng.random() < 0.8 else rng.choice(DIGITS) for _ in range(n))
    raise ValueError(jurisdiction)


def pick_jurisdiction(rng: random.Random) -> str:
    x = rng.random()
    acc = 0.0
    for name, w in JURISDICTIONS:
        acc += w
        if x < acc:
            return name
    return JURISDICTIONS[-1][0]


class PlatePool:
    """Unique-plate generator with a fixed pool of regulars."""

    def __init__(self, rng: random.Random, n_regulars: int):
        self.rng = rng
        self.used: set[str] = set()
        self.jurisdiction: dict[str, str] = {}
        self.regulars: list[str] = [self.new_plate() for _ in range(n_regulars)]
        self.regular_set = set(self.regulars)

    def new_plate(self) -> str:
        for _ in range(1000):
            j = pick_jurisdiction(self.rng)
            p = make_plate(self.rng, j)
            if p not in self.used:
                self.used.add(p)
                self.jurisdiction[p] = j
                return p
        raise RuntimeError("plate space exhausted")


def confusable_positions(plate: str) -> list[int]:
    return [i for i, c in enumerate(plate) if c in CONFUSABLE]


def confuse_one(rng: random.Random, plate: str, pos: int | None = None) -> str:
    """Swap one confusable character for a partner. Returns the plate
    unchanged if no character is confusable."""
    positions = confusable_positions(plate)
    if not positions:
        return plate
    if pos is None or pos not in positions:
        pos = rng.choice(positions)
    return plate[:pos] + rng.choice(CONFUSABLE[plate[pos]]) + plate[pos + 1:]


def drop_edge(rng: random.Random, plate: str, leading_bias: float = 0.7) -> str:
    """'Z94PVE' -> '94PVE' (leading, more common) or 'Z94PV' (trailing)."""
    if len(plate) <= 1:
        return plate
    return plate[1:] if rng.random() < leading_bias else plate[:-1]


def garbage_read(rng: random.Random, plate: str) -> str:
    """A partial decode leaking the OCR pad token '_' (never 'clean')."""
    chars = list(plate)
    for _ in range(rng.randint(1, 2)):
        chars[rng.randrange(len(chars))] = "_"
    if rng.random() < 0.5 and len(chars) > 3:
        chars = chars[: rng.randint(2, len(chars) - 1)]
    return "".join(chars)


def random_junk(rng: random.Random) -> str:
    """A clean but unrelated short read, like '191316' in the real sample."""
    n = rng.randint(3, 7)
    return "".join(rng.choice(LETTERS + DIGITS) for _ in range(n))
