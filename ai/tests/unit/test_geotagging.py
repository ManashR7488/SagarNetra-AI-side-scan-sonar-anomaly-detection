import json

import pytest

from app.geo.geotagging import GeoreferenceError, destination, from_simple, haversine_m, parse_metadata


def test_destination_and_haversine_roundtrip():
    lat, lon = destination(13.0, 80.0, 90.0, 1000.0)
    assert haversine_m(13.0, 80.0, lat, lon) == pytest.approx(1000.0, rel=1e-6)
    assert lat == pytest.approx(13.0, abs=1e-4) and lon > 80.0


def test_simple_track_sides_and_anchor():
    t = from_simple(1000, 1000, 13.0, 80.0, heading_deg=0.0, swath_width_m=100.0)
    centre = t.pixel_to_geo(500, 499.5)
    assert centre["latitude"] == pytest.approx(13.0, abs=1e-6)       # anchor = image centre
    stbd, port = t.pixel_to_geo(900, 500), t.pixel_to_geo(100, 500)
    assert stbd["side"] == "starboard" and stbd["longitude"] > 80.0  # heading north -> starboard is east
    assert port["side"] == "port" and port["longitude"] < 80.0
    assert stbd["across_track_m"] == pytest.approx(40.0, abs=0.01)   # 400 px * 0.1 m
    # row 0 is the first ping; heading north, so later pings (higher rows) are further north
    assert t.pixel_to_geo(500, 0)["latitude"] < t.pixel_to_geo(500, 999)["latitude"]
    assert "nadir assumed at the image centre column" in t.assumptions


def test_nav_csv_with_pings_and_derived_heading():
    csv_text = "ping,latitude,longitude\n0,13.0000,80.0\n50,13.0005,80.0\n100,13.0010,80.0\n"
    t = parse_metadata(csv_text.encode(), "nav.csv", 200, 400, swath_width_m=80.0)
    assert t.source == "navigation_csv"
    assert t.heading[0] == pytest.approx(0.0, abs=0.01)
    assert t.across_m_per_px == pytest.approx(0.2)
    assert t.pixel_to_geo(200, 199)["vehicle_latitude"] == pytest.approx(13.001, abs=1e-6)


def test_json_simple_and_errors():
    t = parse_metadata(json.dumps({"lat": 13.1, "lon": 80.3, "heading": 45, "swath_width_m": 60}).encode(),
                       "geo.json", 100, 600)
    assert t.source == "simple" and t.across_m_per_px == pytest.approx(0.1)
    with pytest.raises(GeoreferenceError):
        parse_metadata(b'{"foo": 1}', "bad.json", 100, 100)
    with pytest.raises(GeoreferenceError):
        parse_metadata(b"lat,lon\n13,80\n", "one_fix.csv", 100, 100)
