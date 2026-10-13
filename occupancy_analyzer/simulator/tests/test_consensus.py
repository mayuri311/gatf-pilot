from __future__ import annotations

import random

from occsim.camera import CameraModel, NoiseParams
from occsim.config import SimConfig
from occsim.consensus import best_reading, is_clean_read, normalize_read, validate_plate
from occsim.timeutil import UTC
from datetime import datetime


def R(text, conf=0.9, per_char=None, det=0.8, frame=0):
    return {"text": text, "confidence": conf, "confidence_per_char": per_char,
            "detection_confidence": det, "frame_index": frame}


def test_normalize_and_clean():
    assert normalize_read("  z94pve ") == "Z94PVE"
    assert is_clean_read("Z94PVE")
    assert not is_clean_read("Z9_PVE")
    assert not is_clean_read("")


def test_validate_plate():
    assert validate_plate("Z94PVE") == (True, None)
    assert validate_plate("")[1] == "no_readable_text"
    assert validate_plate("AB_12")[1].startswith("invalid_characters")
    assert validate_plate("ABCD")[1].startswith("too_short")
    assert validate_plate("ABCD", min_chars=4) == (True, None)


def test_majority_wins_and_modal_length():
    reads = [R("Z94PVE", 0.95)] * 5 + [R("Z94PWE", 0.9)] * 2 + [R("94PVE", 0.99)] * 3 + [R("", 0.99)]
    c = best_reading(reads)
    assert c["plate_text"] == "Z94PVE"
    assert c["num_frames_used_for_consensus"] == 7
    assert len(c["plate_confidence_per_char"]) == 6


def test_confidence_weighting_can_beat_raw_votes():
    # 2 low-confidence 'W' votes vs 1 very confident 'V' at position 4
    reads = [R("Z94PWE", 0.3), R("Z94PWE", 0.3), R("Z94PVE", 0.99)]
    assert best_reading(reads)["plate_text"] == "Z94PVE"


def test_per_char_confidence_used_when_present():
    reads = [R("AB", per_char=[0.9, 0.1]), R("AC", per_char=[0.9, 0.9])]
    c = best_reading(reads)
    assert c["plate_text"] == "AC"
    assert abs(c["plate_confidence_per_char"][0] - 0.9) < 1e-9


def test_unclean_reads_do_not_vote():
    reads = [R("Z9_PVE", 0.99)] * 10 + [R("Z94PVE", 0.5)]
    assert best_reading(reads)["plate_text"] == "Z94PVE"


def test_no_clean_reads_gives_none_and_best_detection():
    reads = [R("", det=0.4), R("__", det=0.9, frame=7)]
    c = best_reading(reads)
    assert c["plate_text"] is None and c["representative"]["frame_index"] == 7


def test_simulated_tracks_recover_observed_plate():
    """With default per-frame noise, consensus returns the observed plate:
    errors only appear when injected at the observed level."""
    cam = CameraModel(SimConfig(), NoiseParams(), seed=5, origin=datetime(2026, 10, 13, tzinfo=UTC))
    rng = random.Random(0)
    wrong = 0
    for _ in range(300):
        plate = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(3)) + str(rng.randint(1000, 9999))
        reads = cam.render_reads(plate, plate, rng.randint(60, 200), noisy=True)
        wrong += best_reading(reads)["plate_text"] != plate
    assert wrong <= 3  # spontaneous consensus errors are rare


def test_injected_error_outvotes_truth():
    cam = CameraModel(SimConfig(), NoiseParams(), seed=9, origin=datetime(2026, 10, 13, tzinfo=UTC))
    reads = cam.render_reads("Z94PWE", "Z94PVE", 150, noisy=True)
    texts = [r["text"] for r in reads]
    assert "Z94PVE" in texts  # the truth is present...
    assert best_reading(reads)["plate_text"] == "Z94PWE"  # ...but outvoted
