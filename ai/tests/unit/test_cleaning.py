import dataclasses

import numpy as np
import pytest

from app.cleaning import gain as gainmod
from app.cleaning import watercolumn as wc
from app.cleaning.auto import auto_params
from app.cleaning.dropouts import find_bad_pings, repair_pings
from app.cleaning.motion import along_track, compensate
from app.cleaning.params import CleanParams
from app.cleaning.pipeline import clean, diagnose
from app.cleaning.report import measure
from app.cleaning.stress import DISTURBANCES, disturb
from app.readers.xtf import load_xtf
from tests.conftest import make_xtf


def seabed(h=600, w=400, seed=0, level=120.0, looks=4):
    """Speckled seabed with a dark water column around the nadir (w/2)."""
    rng = np.random.default_rng(seed)
    img = level * rng.gamma(looks, 1.0 / looks, (h, w))
    c = w // 2
    img[:, c - 30:c + 30] = 4
    return np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- params

def test_params_reject_unknown_and_bad_values():
    with pytest.raises(ValueError, match="despeckel"):
        CleanParams.from_dict({"despeckel": "lee"})
    with pytest.raises(ValueError):
        CleanParams.from_dict({"despeckle": "wavelet"})
    with pytest.raises(ValueError):
        CleanParams.from_json("{not json")
    p = CleanParams.from_dict({"gain_across": "true", "gain_strength": "250", "target_m_per_px": "0.2"})
    assert p.gain_across is True and p.gain_strength == 100 and p.target_m_per_px == 0.2


# ---------------------------------------------------------------- dropouts

def test_bad_pings_found_and_repaired():
    img = seabed()
    img[100:103] = 1                       # lost pings
    img[200, :200] = 0                     # port channel lost
    img[300] = img[299]                    # repeated ping
    flags = find_bad_pings(img, 200)
    assert set(np.where(flags.blank)[0]) == {100, 101, 102}
    assert flags.partial_port[200] and not flags.partial_stbd[200]
    assert flags.duplicate[300]
    out = repair_pings(img, flags, 200)
    assert out[101].mean() > 60 and out[200, :150].mean() > 60
    assert np.array_equal(out[200, 250:], img[200, 250:])      # the good side is untouched
    assert flags.repaired.sum() == 5


def test_padding_and_enlarged_images_are_not_dropouts():
    img = seabed()
    img[:12] = 0                           # letterbox padding
    img[-10:] = 0
    flags = find_bad_pings(img, 200)
    assert not flags.blank.any() and flags.border.sum() == 22
    enlarged = np.repeat(seabed(300), 2, axis=0)               # every row twice
    f2 = find_bad_pings(enlarged, 200)
    assert not f2.duplicate.any() and any("enlarged" in n for n in f2.notes)


def test_shadows_are_not_partial_dropouts():
    img = seabed()
    img[250:300, 260:400] = (img[250:300, 260:400] * 0.15).astype(np.uint8)   # big dark (but textured) shadow
    flags = find_bad_pings(img, 200)
    assert not flags.partial_stbd.any()


# ---------------------------------------------------------------- gain

def test_range_gain_flattens_a_ramp():
    img = seabed(800, 600).astype(np.float32)
    ramp = np.linspace(1.0, 0.35, 300)                 # far range too dark (TVG error) on both sides
    img[:, 300:] *= ramp
    img[:, :300] *= ramp[::-1]
    img = np.clip(img, 0, 255).astype(np.uint8)
    water = np.full(800, 30.0)
    before = measure(img, 300, water, series=False)["across_imbalance"]
    out, info = gainmod.range_normalize(img, 300, water, strength=100)
    after = measure(out, 300, water, series=False)["across_imbalance"]
    assert info["applied"] and after < before * 0.7


def test_gain_step_detected_and_removed():
    img = seabed(900, 400).astype(np.float32)
    img[450:] *= 1.4                                   # operator gain change on both sides
    img = np.clip(img, 0, 255).astype(np.uint8)
    lp, ls = gainmod.side_levels(img, 200, None)
    steps = gainmod.find_gain_steps(lp, ls, bands=gainmod.band_levels(img, 200, None))
    assert len(steps) == 1 and abs(steps[0]["row"] - 450) <= 3 and 1.3 < steps[0]["ratio"] < 1.5
    out, info = gainmod.ping_normalize(img, 200, None, strength=70)
    lp2, ls2 = gainmod.side_levels(out, 200, None)
    assert abs(np.median(lp2[500:]) / np.median(lp2[:400]) - 1) < 0.08
    assert not gainmod.find_gain_steps(*gainmod.side_levels(seabed(900, 400), 200, None))     # none on plain seabed


def test_destripe_removes_bursts_but_keeps_objects():
    img = seabed(600, 400, seed=3, looks=8)
    rng = np.random.default_rng(1)
    for r0 in (120, 330, 480):                         # thin, slightly slanted, dashed interference bursts
        cols = np.arange(220, 380)
        rows = r0 + ((cols - 220) * 0.04).astype(int)
        img[rows, cols] = np.where(rng.random(len(cols)) < 0.85, 250, img[rows, cols])
    img[250:270, 260:330] = 240                        # a real object, 20 pings long
    out, info = gainmod.destripe(img)
    assert info["bursts"] >= 3
    assert out[120:124, 230:370].mean() < img[120:124, 230:370].mean() - 15
    assert out[255:265, 270:320].mean() > 200          # the object survives


# ---------------------------------------------------------------- water column / geometry

def test_water_column_mask_and_ground_range():
    img = seabed(300, 400)
    img[100:110, 180:190] = 200                        # a fish school in the (dark) water column
    img[200:204, 205:215] = 180
    water = np.full(300, 30.0)
    out, info = wc.mask_water_column(img, 200, water)
    assert info["applied"] and out[:, 175:225].max() < 20
    g, ginfo = wc.slant_to_ground(img, 200, water)
    assert g.shape == img.shape and ginfo["applied"]
    # ground column 260 (60.5 px ground range) comes from slant range sqrt(60.5^2 + 30^2) = 67.5 px -> column 267
    assert np.abs(g[:, 260].astype(int) - img[:, 267].astype(int)).mean() < 3
    # the water column is gone: right next to the nadir there is seabed now
    assert g[:, 203:210].mean() > 40 and img[:, 203:210].mean() < 10


# ---------------------------------------------------------------- motion (XTF)

def test_motion_compensation_on_xtf():
    data = make_xtf(n_pings=300)
    img, track, info, geom, log = load_xtf(data, with_geometry=True, with_log=True)
    s, course, src = along_track(log)
    assert s[-1] == pytest.approx(29.9, rel=0.1) and np.all(np.diff(s) >= 0)
    assert np.allclose(((course + 180) % 360) - 180, 0, atol=1.0)        # due north
    res = compensate(log.raw, log)
    assert res is not None and np.all(np.diff(res.row_of_ping) >= 0)
    assert res.image.shape[1] == log.raw.shape[1]
    assert res.along_m_per_px == pytest.approx(log.across_m_per_px, rel=0.05)


def test_clean_xtf_moves_track_with_the_image():
    data = make_xtf(n_pings=300)
    img, track, info, geom, log = load_xtf(data, with_geometry=True, with_log=True)
    r = clean(img, CleanParams(motion=True, slant_correct=True), xtf=log)
    assert r.frame.geometry_changed and r.frame.ground_corrected and not r.frame.slant
    t2 = r.frame.transform_track(track)
    assert not t2.slant_range and t2.nadir_col == pytest.approx(r.frame.nadir_col)
    assert t2.rows[-1] == pytest.approx(r.frame.row_of_ping[-1] * r.frame.row_scale, rel=0.02)
    # the object (pings 180-240, 200-260 samples out on starboard) keeps its geotag within a metre
    geo_before = track.pixel_to_geo(512 + 230, track.rows[0] + (track.rows[-1] - track.rows[0]) * 210 / 299)
    row_after = float(np.interp(210, np.arange(log.n), r.frame.row_of_ping)) * r.frame.row_scale
    ground_col = r.frame.nadir_col + np.sqrt((230 * log.across_m_per_px) ** 2 - 25) / log.across_m_per_px
    geo_after = t2.pixel_to_geo(ground_col, row_after)
    from app.geo.geotagging import haversine_m
    assert haversine_m(geo_before["latitude"], geo_before["longitude"], geo_after["latitude"], geo_after["longitude"]) < 1.0


def test_clean_without_changes_keeps_the_frame():
    img = seabed()
    r = clean(img, CleanParams(repair_dropouts=False, motion=False))
    assert not r.frame.geometry_changed and r.image.shape == img.shape
    assert np.array_equal(r.frame.map_rows([0, 10, 599]), [0, 10, 599])
    q = r.quality.at_box((190, 100, 210, 120))
    assert q["in_water_column"] and "in_water_column" in q["flags"]


# ---------------------------------------------------------------- Auto

def test_auto_decisions_follow_the_measured_noise():
    img = seabed(700, 500).astype(np.float32)
    img[:, 250:] *= np.linspace(1.0, 0.3, 250)             # gain imbalance
    img[300:303] = 0                                       # lost pings
    img = np.clip(img, 0, 255).astype(np.uint8)
    diag = diagnose(img)
    p, decisions = auto_params(diag.to_dict(), "analyst")
    on = {d["step"] for d in decisions if d["enabled"]}
    assert {"dropouts", "range_gain"} <= on and p.repair_dropouts and p.gain_across
    assert "motion" not in on and all(d["why"] for d in decisions)
    p_ai, dec_ai = auto_params(diag.to_dict(), "ai")
    assert p_ai.repair_dropouts                          # data faults are always repaired when present
    assert all("benchmark" in d["why"] or not d["enabled"] or d["step"] in ("dropouts", "motion") for d in dec_ai)


# ---------------------------------------------------------------- stress test

@pytest.mark.parametrize("kind", DISTURBANCES)
def test_disturbances_are_deterministic_and_grow(kind):
    img = seabed(256, 256, seed=5)
    a, b = disturb(img, kind, 1, 128), disturb(img, kind, 1, 128)
    assert np.array_equal(a, b)
    d1 = np.abs(disturb(img, kind, 1, 128).astype(float) - img).mean()
    d4 = np.abs(disturb(img, kind, 4, 128).astype(float) - img).mean()
    assert d4 > d1 > 0


# ---------------------------------------------------------------- classifier runtime

def test_classifier_scores_and_explains():
    from app.processing.features import FEATURES
    from app.processing.fp_classifier import FPClassifier

    n = len(FEATURES)
    coef = np.zeros(n)
    coef[FEATURES.index("shadow_found")] = 2.0
    coef[FEATURES.index("periodicity")] = -1.5
    clf = FPClassifier({"features": list(FEATURES), "mean": [0.0] * n, "std": [1.0] * n,
                        "binary": {"coef": coef.tolist(), "intercept": 0.0}, "decision_threshold": 0.4,
                        "subtype": {"classes": ["rock", "sand_ripple"], "coef": [[0.0] * n, (-coef).tolist()],
                                    "intercept": [0.0, 0.0]}})
    v = np.zeros(n)
    v[FEATURES.index("periodicity")] = 3.0                 # periodic texture, no shadow -> natural, ripples
    pred = clf.predict(v)
    assert pred["p_man_made"] < 0.4 and pred["subtype"] == "sand_ripple"
    assert clf.reasons(pred["contributions"], towards_natural=True)[0] == "periodic ripple pattern"
    assert clf.score(0.4) == pytest.approx(50.0) and clf.score(1.0) == pytest.approx(100.0)
    assert clf.score(0.2) == pytest.approx(25.0)
    assert clf.summary()["decision_threshold"] == 0.4 and clf.summary()["cross_validated"] is None


def test_classifier_blends_with_the_rule_score():
    from app.processing.features import FEATURES
    from app.processing.fp_classifier import FPClassifier
    from app.processing.scoring import rule_score

    n = len(FEATURES)
    clf = FPClassifier({"features": list(FEATURES), "mean": [0.0] * n, "std": [1.0] * n,
                        "binary": {"coef": [0.0] * n, "intercept": 0.0}, "blend": {"classifier_weight": 0.5}})
    pred = clf.predict(np.zeros(n), 80.0)                  # classifier 0.5, rules 0.8
    assert pred["p_classifier"] == pytest.approx(0.5) and pred["p_man_made"] == pytest.approx(0.65)
    assert clf.predict(np.zeros(n))["p_man_made"] == pytest.approx(0.5)      # no rule score given
    # the rule score is the one the rule-based filter uses: calibrated confidence + evidence + agreement bonus
    assert rule_score(50.0, 0.35, 0.35, 0.35, False) == pytest.approx(50.0)
    assert rule_score(50.0, 1.0, 1.0, 1.0, True) == pytest.approx(79.5)
    assert rule_score(99.0, 1.0, 1.0, 1.0, True) == 100.0


def test_report_names_the_false_alarm_filter():
    from app.processing.scoring import ScoreParams, fp_filter_info

    assert fp_filter_info(ScoreParams(fp_filter=False)) == {"method": "off"}
    assert fp_filter_info(ScoreParams(fp_method="rules")) == {"method": "rules"}
