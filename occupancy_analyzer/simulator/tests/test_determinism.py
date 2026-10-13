from __future__ import annotations

import hashlib
from pathlib import Path

from conftest import run_generate


def tree_digest(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_same_seed_is_byte_identical(tmp_path):
    run_generate(tmp_path / "a", seed=11)
    run_generate(tmp_path / "b", seed=11)
    a, b = tree_digest(tmp_path / "a"), tree_digest(tmp_path / "b")
    assert a.keys() == b.keys()
    assert a == b


def test_different_seed_differs(tmp_path):
    run_generate(tmp_path / "a", seed=1)
    run_generate(tmp_path / "b", seed=2)
    a, b = tree_digest(tmp_path / "a"), tree_digest(tmp_path / "b")
    assert a["ground_truth/visits.csv"] != b["ground_truth/visits.csv"]
    assert a["manifest.json"] != b["manifest.json"]


def test_regenerate_into_same_folder_replaces_output(tmp_path):
    out = tmp_path / "o"
    run_generate(out, seed=3)
    run_generate(out, seed=4)  # allowed: folder holds an occsim manifest
    run_generate(tmp_path / "fresh", seed=4)
    assert tree_digest(out) == tree_digest(tmp_path / "fresh"), "stale files from the first run remain"
