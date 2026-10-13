"""Track consensus — a verbatim copy of the algorithm in scripts/plate_ocr_reader.py.

Copied (not imported) because that module pulls in cv2 / fast_alpr /
ultralytics at import time. Keep this in sync with the producer: the whole
point is that a simulated consensus error only happens when the simulated
per-frame noise genuinely outvotes the truth, exactly as on the real camera.

Source functions: normalize_read, is_clean_read, validate_plate, best_reading.
"""

import re
from collections import Counter, defaultdict

# A plate read is only trusted if it is pure A-Z0-9. The OCR model emits "_" as
# its blank/pad token, so reads like "1_1", "5__33" or "41_7" are partial
# decodes leaking the pad character - not plates.
CLEAN_READ_RE = re.compile(r"^[A-Z0-9]+$")

DEFAULT_MIN_PLATE_CHARS = 5


def normalize_read(text):
    return (text or "").strip().upper()


def is_clean_read(text):
    return bool(CLEAN_READ_RE.match(normalize_read(text)))


def validate_plate(text, min_chars=DEFAULT_MIN_PLATE_CHARS):
    """Gate a track's consensus text. Returns (ok, reason).

    Deliberately has NO confidence floor (see the producer).
    """
    t = normalize_read(text)
    if not t:
        return False, "no_readable_text"
    if not CLEAN_READ_RE.match(t):
        bad = "".join(sorted({c for c in t if not c.isalnum()}))
        return False, f"invalid_characters: {bad!r} in {t!r}"
    if len(t) < min_chars:
        return False, f"too_short: {t!r} ({len(t)} chars, minimum {min_chars})"
    return True, None


def best_reading(readings):
    """Combine a track's buffered per-frame reads into one consensus reading.

    Reads are grouped by their most common text length, then each character
    position is decided by a confidence-weighted vote within that group.

    Each reading is a dict with at least: text, confidence,
    confidence_per_char (list or None), detection_confidence, frame_index.
    """
    # Only fully-alphanumeric reads vote. See CLEAN_READ_RE above.
    texted = [r for r in readings if is_clean_read(r["text"])]
    if not texted:
        representative = max(readings, key=lambda r: r["detection_confidence"])
        return {
            "plate_text": None,
            "plate_confidence": None,
            "plate_confidence_per_char": None,
            "representative": representative,
            "num_frames_used_for_consensus": 0,
        }

    mode_length, _ = Counter(len(normalize_read(r["text"])) for r in texted).most_common(1)[0]
    candidates = [r for r in texted if len(normalize_read(r["text"])) == mode_length]

    consensus_chars, consensus_conf = [], []
    for pos in range(mode_length):
        weight_by_char = defaultdict(float)
        votes_by_char = Counter()
        for r in candidates:
            ch = normalize_read(r["text"])[pos]
            weight = r["confidence_per_char"][pos] if r["confidence_per_char"] else (r["confidence"] or 0.0)
            weight_by_char[ch] += weight
            votes_by_char[ch] += 1
        winner = max(weight_by_char, key=weight_by_char.get)
        consensus_chars.append(winner)
        consensus_conf.append(weight_by_char[winner] / votes_by_char[winner])

    consensus_text = "".join(consensus_chars)
    # prefer a frame that actually read the consensus text verbatim
    exact_matches = [r for r in candidates if normalize_read(r["text"]) == consensus_text]
    representative = max(exact_matches or candidates, key=lambda r: r["confidence"] or 0.0)

    return {
        "plate_text": consensus_text,
        "plate_confidence": sum(consensus_conf) / len(consensus_conf),
        "plate_confidence_per_char": consensus_conf,
        "representative": representative,
        "num_frames_used_for_consensus": len(candidates),
    }
