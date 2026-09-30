import csv
import io

from tests.conftest import SMALL_IMAGE, WRECK_STRIP, make_xtf


def _upload(path):
    return {"file": (path.name, path.read_bytes())}


def test_health_and_models(client):
    h = client.get("/health").json()
    assert h["status"] == "ok" and set(h["models_loaded"]) == {"detector", "segmenter"}
    m = client.get("/v1/models").json()
    assert m["detector"]["classes"][0] == "shipwreck"
    assert "thresholds" in m["detector"] and "test_metrics" in m["segmenter"]
    assert "datasets" not in m["detector"]


def test_analyze_wreck_strip_with_georeference(client):
    r = client.post("/v1/analyze", files=_upload(WRECK_STRIP),
                    data={"latitude": 13.0842, "longitude": 80.3824, "heading_deg": 142.5, "swath_width_m": 150})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["processing"]["tiled"] and j["georeference"]["available"]
    confirmed = [d for d in j["detections"] if d["status"] == "confirmed"]
    assert confirmed and confirmed[0]["class_name"] == "shipwreck"
    top = confirmed[0]
    assert 0 <= top["confidence"] <= 100 and top["polygons"]           # mask from the segmenter
    assert abs(top["location"]["latitude"] - 13.084) < 0.01
    assert top["dimensions"]["along_track_m"] > 0
    assert set(top["bbox_pct"]) == {"x", "y", "width", "height"}
    assert j["images"]["annotated"].startswith("data:image/jpeg;base64,")

    aid = j["analysis_id"]
    rows = list(csv.DictReader(io.StringIO(client.get(f"/v1/analyses/{aid}/report.csv").text)))
    assert len(rows) == len(j["detections"]) and rows[0]["latitude"]
    rep = client.get(f"/v1/analyses/{aid}/report.json")
    assert rep.headers["content-disposition"].startswith("attachment") and rep.json()["analysis_id"] == aid
    for img in ("annotated", "filtered"):
        resp = client.get(f"/v1/analyses/{aid}/{img}.jpg")
        assert resp.headers["content-type"] == "image/jpeg" and resp.content[:2] == b"\xff\xd8"


def test_analyze_without_georeference_and_options(client):
    r = client.post("/v1/analyze", files=_upload(SMALL_IMAGE),
                    data={"models": "detector", "denoise": "lee", "clahe": "true", "return_images": "false",
                          "include_suppressed": "false", "min_score": 0})
    assert r.status_code == 200, r.text
    j = r.json()
    assert not j["georeference"]["available"] and "images" not in j
    assert not j["processing"]["tiled"] and list(j["processing"]["models"]) == ["detector"]
    assert all(d["location"] is None and d["status"] == "confirmed" for d in j["detections"])
    assert j["processing"]["filters"]["params"]["denoise"] == "lee"


def test_analyze_with_navigation_csv(client):
    nav = "row,lat,lon,heading\n0,13.10,80.30,90\n1928,13.10,80.3015,90\n"
    r = client.post("/v1/analyze", files={**_upload(WRECK_STRIP), "metadata": ("nav.csv", nav.encode())},
                    data={"swath_width_m": 150, "return_images": "false"})
    j = r.json()
    assert j["georeference"]["source"] == "navigation_csv" and j["source"]["metadata_file"] == "nav.csv"


def test_bad_metadata_does_not_fail_analysis(client):
    r = client.post("/v1/analyze", files={**_upload(SMALL_IMAGE), "metadata": ("nav.csv", b"a,b\n1,2\n")},
                    data={"return_images": "false"})
    assert r.status_code == 200
    assert not r.json()["georeference"]["available"] and "lat/lon" in r.json()["georeference"]["reason"]


def test_analyze_xtf_log(client):
    r = client.post("/v1/analyze", files={"file": ("survey.xtf", make_xtf())}, data={"return_images": "false"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["source"]["format"] == "xtf" and j["georeference"]["source"] == "xtf_ping_headers"
    assert j["georeference"]["start_time"].startswith("2026-09-29T10:00")


def test_filter_endpoint(client):
    r = client.post("/v1/filter", files=_upload(SMALL_IMAGE), data={"denoise": "frost", "denoise_strength": 70})
    j = r.json()
    assert r.status_code == 200 and j["params"]["denoise"] == "frost"
    assert j["quality_after"]["speckle_index"] < j["quality_before"]["speckle_index"]
    img = client.post("/v1/filter?output=jpeg", files=_upload(SMALL_IMAGE))
    assert img.headers["content-type"] == "image/jpeg"


def test_rejects_bad_inputs(client):
    assert client.post("/v1/analyze", files={"file": ("x.pdf", b"%PDF")}).status_code == 415
    assert client.post("/v1/analyze", files={"file": ("x.png", b"not a png")}).status_code == 422
    assert client.post("/v1/analyze", files={"file": ("x.xtf", b"junk" * 50)}).status_code == 422
    assert client.post("/v1/analyze", files=_upload(SMALL_IMAGE), data={"models": "foo"}).status_code == 400
    assert client.post("/v1/analyze", files=_upload(SMALL_IMAGE), data={"denoise": "wavelet"}).status_code == 422
    assert client.get("/v1/analyses/doesnotexist").status_code == 404


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_analyze_by_url_from_allowed_host(client, monkeypatch):
    """Large files reach the service as a Cloudinary URL instead of a multipart upload."""
    fetched = []

    def fake_urlopen(url, timeout):
        fetched.append(url)
        return _FakeResponse(SMALL_IMAGE.read_bytes())

    monkeypatch.setattr("app.api.deps.urllib.request.urlopen", fake_urlopen)
    url = "https://res.cloudinary.com/demo/image/upload/v1/sonarscan/incoming/scan.jpg"
    r = client.post("/v1/analyze", data={"file_url": url, "models": "detector", "return_images": "false"})
    assert r.status_code == 200, r.text
    assert fetched == [url] and r.json()["source"]["filename"] == "scan.jpg"


def test_url_inputs_are_restricted(client):
    for url in ("http://res.cloudinary.com/x.png", "https://169.254.169.254/latest/meta-data", "https://evil.example/x.png"):
        r = client.post("/v1/analyze", data={"file_url": url})
        assert r.status_code == 400, (url, r.text)
    assert client.post("/v1/analyze", data={"models": "detector"}).status_code == 422


def test_api_key_protects_inference(client, monkeypatch):
    from dataclasses import replace

    from app.core.config import settings

    monkeypatch.setattr("app.api.router.settings", replace(settings, api_key="s3cret"))
    assert client.post("/v1/filter", files=_upload(SMALL_IMAGE)).status_code == 401
    assert client.post("/v1/filter", files=_upload(SMALL_IMAGE), headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.post("/v1/filter", files=_upload(SMALL_IMAGE), headers={"X-API-Key": "s3cret"}).status_code == 200
    assert client.get("/health").status_code == 200  # monitoring stays open
