from datetime import datetime, timezone

import pytest

from app.readers.xtf import XTFError, load_xtf
from tests.conftest import make_xtf


def test_xtf_waterfall_and_navigation():
    img, track, info = load_xtf(make_xtf())
    assert info["pings"] == 400 and info["georeferenced"] and info["sonar_name"] == "SynthSSS"
    assert img.shape[1] == 1024 and track.nadir_col == pytest.approx(512)
    assert track.source == "xtf_ping_headers" and track.slant_range
    # object is 200-260 samples out on starboard -> ~20-25 m slant, ground range slightly less (altitude 5 m)
    geo = track.pixel_to_geo(512 + 230, img.shape[0] * 210 / 400)
    assert geo["side"] == "starboard" and 20 < geo["across_track_m"] < 23
    t = datetime.fromisoformat(geo["timestamp"].replace("Z", "+00:00"))   # ping 210 -> 10:00:21
    assert abs((t - datetime(2026, 9, 29, 10, 0, 21, tzinfo=timezone.utc)).total_seconds()) < 0.1


def test_xtf_without_latlon_is_not_georeferenced():
    _, track, info = load_xtf(make_xtf(n_pings=50, latlon=False))
    assert track is None and not info["georeferenced"] and "georeference_note" in info


def test_xtf_garbage_rejected():
    with pytest.raises(XTFError):
        load_xtf(b"not an xtf file" * 100)
