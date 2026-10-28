import base64

import numpy as np
import pytest

from app.geo.geotagging import from_simple, parse_metadata
from app.readers.xtf import load_xtf
from app.seabed.bottom import track_bottom
from app.seabed.geometry import SwathGeometry, choose_altitude
from app.seabed.model import build_seabed
from app.seabed.relief import estimate_relief
from app.seabed.shadows import measure_shadow
from tests.conftest import make_xtf


def _ground_geometry(h: int, w: int, m_per_px: float, altitude: float) -> SwathGeometry:
    rows = np.array([0.0, h - 1.0])
    return SwathGeometry(h, w, 0.0, m_per_px, False, rows, rows * m_per_px, np.array([altitude, altitude]), None)


def _scene_with_target(height_m: float, altitude: float = 10.0, rt: float = 22.0, mpp: float = 0.05):
    """Starboard-only ground-range strip: speckled seabed, a 2 m wide object ending at rt with its true shadow."""
    rng = np.random.default_rng(1)
    h, w = 400, 800
    img = np.clip(rng.gamma(9, 13, (h, w)), 0, 255).astype(np.uint8)
    ls = height_m * rt / (altitude - height_m)            # similar triangles
    x_obj, x_rt, x_end = int((rt - 2) / mpp), int(rt / mpp), int((rt + ls) / mpp)
    img[150:250, x_obj:x_rt] = 245
    img[150:250, x_rt:x_end] = 8
    bbox = {"x1": x_obj, "y1": 150, "x2": x_rt, "y2": 250}
    return img, bbox, _ground_geometry(h, w, mpp, altitude)


@pytest.mark.parametrize("height", [0.5, 1.0, 2.5])
def test_shadow_length_gives_target_height(height):
    img, bbox, geom = _scene_with_target(height)
    m = measure_shadow(img, bbox, geom)
    assert m is not None and m["height_m"] == pytest.approx(height, rel=0.2)


def test_no_shadow_no_height():
    img, bbox, geom = _scene_with_target(1.0)
    img[150:250, bbox["x2"]:] = 120                       # paint the shadow over with seabed
    assert measure_shadow(img, bbox, geom) is None


def test_slant_range_geometry_roundtrip():
    img, track, _ = load_xtf(make_xtf())
    geom = SwathGeometry.build(*img.shape, track)
    assert geom.slant and geom.altitude_at(10.0) == pytest.approx(5.0)
    u = geom.ground_u(np.array([geom.nadir - 300, geom.nadir + 300]), 10.0)
    assert u[0] < 0 < u[1]                                # port negative, starboard positive
    assert geom.col_at(u, 10.0) == pytest.approx([geom.nadir - 300, geom.nadir + 300])
    assert geom.y_at(geom.s_at(120.0) - geom.s_at(0)) == pytest.approx(120.0, abs=0.5)


def test_relief_is_bounded_on_flat_seabed():
    rng = np.random.default_rng(2)
    ground = rng.gamma(4, 30, (300, 400)).astype(np.float32)
    u = np.linspace(-50, 50, 400)
    z = estimate_relief(ground, np.ones_like(ground, bool), u, np.full(300, 8.0), du=u[1] - u[0])
    assert np.abs(z).max() <= 2.0 and np.sqrt(np.mean(z ** 2)) < 0.2


def _decode(sb):
    e, g = sb["elevation"], sb["grid"]
    q = np.frombuffer(base64.b64decode(e["data"]), "<u2")
    assert q.size == g["nx"] * g["nz"]
    return q.reshape(g["nz"], g["nx"]) * e["scale"] + e["offset"]


def test_seabed_from_xtf_with_measured_depth():
    nav = "ping,lat,lon,heading,altitude,towfish_depth\n0,13.08,80.38,0,5,20\n399,13.0804,80.38,0,5,21\n"
    img, _, _ = load_xtf(make_xtf())
    track = parse_metadata(nav.encode(), "nav.csv", *img.shape)
    det = {"id": "DET-001", "class_name": "debris", "status": "confirmed", "polygons": [],
           "bbox": {"x1": 300, "y1": 180, "x2": 360, "y2": 240}, "centroid_px": {"x": 330, "y": 210}}
    sb = build_seabed(img, track, [det], max_cells=20000)
    assert sb["available"] and sb["kind"] == "measured"
    assert sb["depth"]["min_m"] == pytest.approx(25, abs=0.2) and sb["depth"]["max_m"] == pytest.approx(26, abs=0.2)
    z = _decode(sb)
    assert z.size <= 20000 * 1.1 and -27 < z.min() < z.max() < -23
    assert sb["texture"].startswith("data:image/jpeg;base64,") and len(sb["track"]["lat"]) == len(sb["track"]["s"])
    assert sb["targets"][0]["detection_id"] == "DET-001" and "height" in det


def test_seabed_without_navigation_is_relative():
    img = np.random.default_rng(3).integers(60, 200, (300, 400), dtype=np.uint8)
    sb = build_seabed(img, None, [])
    assert sb["kind"] == "relative" and sb["depth"] is None and sb["altitude"]["assumed"]
    assert sb["grid"]["width_m"] == pytest.approx(100.0, rel=0.02)
    assert any("swath width unknown" in a for a in sb["assumptions"])
    sb2 = build_seabed(img, from_simple(300, 400, 13.0, 80.0, swath_width_m=60.0), [])
    assert sb2["grid"]["width_m"] == pytest.approx(60.0, rel=0.02) and "lat" in sb2["track"]


def _waterfall(nadir=320, w=600, h=500, seed=4):
    """Slant-range waterfall: dark water column either side of an off-centre nadir, altitude varying 40-60 px."""
    rng = np.random.default_rng(seed)
    img = np.clip(rng.gamma(6, 22, (h, w)), 0, 255).astype(np.uint8)
    alt = 50 + 10 * np.sin(np.arange(h) / 60)
    for y in range(h):
        a = int(round(alt[y]))
        img[y, nadir - a:nadir + a] = rng.integers(0, 12, 2 * a)
    return img, alt, nadir


def test_bottom_track_finds_nadir_and_altitude():
    img, alt, nadir = _waterfall()
    bt = track_bottom(img, None)
    assert bt is not None and abs(bt.nadir_col - nadir) <= 3
    assert np.median(np.abs(bt.altitude_px - alt)) < 2.0 and bt.confidence > 0.9
    bt_known = track_bottom(img, float(nadir))
    assert np.median(np.abs(bt_known.altitude_px - alt)) < 2.0


def test_bottom_track_rejects_images_without_water_column():
    rng = np.random.default_rng(5)
    assert track_bottom(np.clip(rng.gamma(6, 22, (400, 400)), 0, 255).astype(np.uint8), None) is None


def test_wrong_logged_altitude_is_replaced_by_the_image():
    img, alt, nadir = _waterfall()
    bt = track_bottom(img, float(nadir))
    rows = np.arange(0, 500, 10, dtype=float)
    true_m = np.interp(rows, np.arange(500), alt) * 0.1
    ok = choose_altitude(rows, true_m + 0.05, bt, 0.1)
    assert ok.source == "logged+image" and ok.check_m < 0.3
    # a disagreeing logged altitude is kept (sonar altimeter) but flagged
    wrong = choose_altitude(rows, true_m * 2, bt, 0.1)
    assert wrong.source == "logged" and wrong.check_m > 1 and "differs" in wrong.note
    missing = choose_altitude(rows, np.zeros_like(rows), bt, 0.1)
    assert missing.source == "image" and np.median(np.abs(missing.values - alt * 0.1)) < 0.3
    constant = choose_altitude(rows, np.full_like(rows, 10.0), bt, 0.1)
    assert constant.source == "image"


def test_xtf_without_latlon_still_gets_a_3d_geometry():
    img, track, info, ping = load_xtf(make_xtf(n_pings=120, latlon=False), with_geometry=True)
    assert track is None and ping is not None and ping.altitude is not None
    sb = build_seabed(img, None, [], ping=ping, bottom=track_bottom(img, ping.nadir_col))
    assert sb["slant_range_corrected"] and not sb["altitude"]["assumed"]
    assert sb["geometry"]["sources"]["scale"] == "XTF slant range"


def test_image_water_column_sets_nadir_and_slant_correction():
    img, alt, nadir = _waterfall()
    sb = build_seabed(img, None, [], bottom=track_bottom(img, None), swath_width_m=60.0)
    assert sb["slant_range_corrected"] and sb["altitude"]["source"] == "image"
    assert sb["geometry"]["nadir_column"] == pytest.approx(nadir, abs=3)
    assert sb["altitude"]["min_m"] == pytest.approx(40 * 0.1, abs=0.4)       # 60 m / 600 px
