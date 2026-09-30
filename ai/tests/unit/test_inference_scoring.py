import numpy as np
import pytest

from app.ml.inference import RawDetection, merge_overlapping, should_tile, tile_origins
from app.processing.scoring import calibrated_score


def test_calibrated_score_maps_threshold_to_50():
    assert calibrated_score(0.3, 0.3) == pytest.approx(50.0)
    assert calibrated_score(1.0, 0.3) == pytest.approx(100.0)
    assert calibrated_score(0.0, 0.3) == pytest.approx(0.0)
    assert calibrated_score(0.15, 0.3) == pytest.approx(25.0)


def test_tiling_rules():
    assert tile_origins(1728, 1024, 0.25) == [0, 704]
    assert should_tile(1929, 1728, 1024)          # tall survey strip
    assert not should_tile(1080, 1920, 1024)      # landscape screenshot (trained whole)
    assert not should_tile(640, 640, 1024)


def test_merge_overlapping_collapses_same_object():
    a = RawDetection("shipwreck", 0.8, np.array([0, 0, 100, 100.0]))
    b = RawDetection("aircraft_wreck", 0.5, np.array([10, 10, 110, 120.0]), source="segmenter")
    c = RawDetection("debris", 0.6, np.array([500, 500, 520, 520.0]))
    out = merge_overlapping([a, b, c])
    assert len(out) == 2
    top = max(out, key=lambda d: d.confidence)
    assert top.class_name == "shipwreck" and top.agreement and list(top.box) == [0, 0, 110, 120]
