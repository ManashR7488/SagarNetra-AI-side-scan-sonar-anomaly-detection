import numpy as np
import pytest

from app.processing.filters import FilterParams, apply_filters, despeckle, find_dropout_rows, quality_metrics


def test_dropout_detection_and_repair():
    rng = np.random.default_rng(1)
    img = rng.integers(80, 160, (200, 300), dtype=np.uint8)
    img[50:53] = 0
    img[120] = 7
    assert set(find_dropout_rows(img)) == {50, 51, 52, 120}
    out, rep = apply_filters(img, FilterParams(repair_dropouts=True))
    assert rep.repaired_rows == 4 and out[51].mean() > 60


@pytest.mark.parametrize("method", ["lee", "frost", "kuan", "median"])
def test_despeckle_reduces_speckle(method):
    rng = np.random.default_rng(2)
    img = np.clip(120 * rng.gamma(2, 0.5, (256, 256)), 0, 255).astype(np.uint8)
    out = despeckle(img, method, 60)
    assert out.shape == img.shape and out.dtype == np.uint8
    assert quality_metrics(out)["speckle_index"] < quality_metrics(img)["speckle_index"]


def test_invalid_filter_rejected():
    with pytest.raises(ValueError):
        apply_filters(np.zeros((10, 10), np.uint8), FilterParams(denoise="wavelet"))
