"""Auto clean: measure the noise first, then switch on only the steps the measurements call for.

  ai       a step is used when the noise it fixes is present AND the benchmark (profile.json) showed it improves
           detection; otherwise it stays off (the detector was trained on raw, speckled sonar).
  analyst  every step whose noise is present is used, with strengths scaled to the measured severity.
Every decision comes with the measured value that triggered it ("why").
"""

import dataclasses

from app.cleaning.params import CleanParams, load_profile_file


def _fmt(v, digits=2):
    return "n/a" if v is None else f"{v:.{digits}f}"


def needs(diag: dict) -> dict:
    """Which kinds of noise are present, from a diagnosis (see pipeline.diagnose)."""
    m, pings = diag["metrics"], diag["pings"]
    bad = pings.get("blank", 0) + pings.get("partial", 0) + pings.get("duplicate", 0)
    return {
        "dropouts": bad > 0,
        "motion": bool(diag.get("xtf_navigation")),
        "stripes": (m.get("stripe_fraction") or 0) > 2e-4,
        "ping_gain": (m.get("ping_jitter") or 0) > 0.02 or (m.get("gain_steps") or 0) > 0,
        "range_gain": (m.get("across_imbalance") or 1) > 1.25
                      or not 0.85 <= (m.get("port_stbd_ratio") or 1) <= 1.18,
        "water_column": bool(diag.get("water_column")),
        "surface": bool(diag.get("sensor_depth")),
        "speckle": (m.get("enl") or 99) < 60,
        "scale_known": bool(diag.get("across_m_per_px")),
    }


def auto_params(diag: dict, profile: str) -> tuple[CleanParams, list[dict]]:
    m, pings = diag["metrics"], diag["pings"]
    need = needs(diag)
    decisions: list[dict] = []
    p = CleanParams(repair_dropouts=False, motion=False)

    def decide(step: str, on: bool, why: str, **settings):
        decisions.append({"step": step, "enabled": bool(on), "why": why})
        if on:
            for k, v in settings.items():
                setattr(p, k, v)

    bad = pings.get("blank", 0) + pings.get("partial", 0) + pings.get("duplicate", 0)
    decide("dropouts", need["dropouts"], f"{bad} blank / partial / duplicated pings found" if bad else
           "no lost pings found", repair_dropouts=True)
    decide("motion", need["motion"], "XTF log with navigation: rows re-spaced by distance travelled, yaw and pitch "
           "corrected" if need["motion"] else "no motion records (only XTF logs carry them)", motion=True)

    if profile == "analyst":
        sev = (m.get("across_imbalance") or 1.0)
        strength = int(min(95, max(60, 40 + 30 * (sev - 1.0))))
        sf = 100 * (m.get("stripe_fraction") or 0)
        decide("stripes", need["stripes"], f"interference lines on {sf:.3f}% of pixels" + ("" if need["stripes"] else
               " (below 0.02%: nothing to remove)"), destripe=True)
        decide("ping_gain", need["ping_gain"], f"ping jitter {_fmt(m.get('ping_jitter'), 3)}, "
               f"{m.get('gain_steps', 0)} gain step(s)" + ("" if need["ping_gain"] else " (stable)"),
               gain_along=True, gain_strength=strength)
        decide("range_gain", need["range_gain"], f"across-track imbalance {_fmt(m.get('across_imbalance'))} "
               f"(1 = uniform), port/starboard {_fmt(m.get('port_stbd_ratio'))}"
               + ("" if need["range_gain"] else " (uniform enough)"), gain_across=True, gain_strength=strength)
        decide("water_column", need["water_column"], "water column found: masked and corrected to ground range"
               if need["water_column"] else "no water column in the image (crop or already ground range)",
               mask_water_column=True, slant_correct=True)
        decide("surface", need["surface"], "sonar depth logged: sea-surface echo line checked" if need["surface"]
               else "no sonar depth (only XTF logs record it)", suppress_surface=True)
        enl = m.get("enl")
        strength = 70 if (enl or 99) < 5 else 55 if (enl or 99) < 20 else 35
        decide("speckle", need["speckle"], f"equivalent number of looks {_fmt(enl, 1)} (raw sonar ~1-10; higher = "
               "smoother)" + ("" if need["speckle"] else ": already smooth"), despeckle="lee",
               despeckle_strength=strength)
        decide("display", True, "analyst view: mild shadow emphasis and local contrast", shadow_gamma=1.2, clahe=True,
               clahe_strength=30)
        return p.validate(), decisions

    # ai: needed AND proven by the benchmark
    prof = load_profile_file()
    proven = prof.get("ai") or {}
    evidence = prof.get("evidence") or {}
    combination = evidence.get("combination") or {}

    def proven_why(key: str, setting: str) -> tuple[bool, str]:
        ev = evidence.get(key) or {}
        ok = bool(proven.get(setting))
        note = ev.get("summary") or ("benchmark: helps detection" if ok else "no benchmark evidence yet, so it stays "
                                     "off for the AI input (tools/benchmark_cleaning.py)")
        if ev.get("helps") and not ok and combination.get("helps") is False:
            note += "; " + combination.get("summary", "not used together with the other steps")
        return ok, note

    for key, setting, need_key, why_need, extra in (
        ("stripes", "destripe", "stripes", f"interference on {100 * (m.get('stripe_fraction') or 0):.3f}% of pixels", {}),
        ("ping_gain", "gain_along", "ping_gain", f"ping jitter {_fmt(m.get('ping_jitter'), 3)}, "
                                                 f"{m.get('gain_steps', 0)} gain step(s)", {"gain_strength": proven.get("gain_strength", 70)}),
        ("range_gain", "gain_across", "range_gain", f"across-track imbalance {_fmt(m.get('across_imbalance'))}",
         {"gain_strength": proven.get("gain_strength", 70)}),
        ("water_column", "mask_water_column", "water_column", "water column found", {}),
        ("ground_range", "slant_correct", "water_column", "water column found", {}),
        ("surface", "suppress_surface", "surface", "sonar depth logged", {}),
        ("speckle", "despeckle", "speckle", f"ENL {_fmt(m.get('enl'), 1)}",
         {"despeckle_strength": proven.get("despeckle_strength", 50)}),
        ("resolution", "normalize_resolution", "scale_known", "pixel size known",
         {"target_m_per_px": proven.get("target_m_per_px", 0.1)}),
    ):
        ok, note = proven_why(key, setting)
        present = need[need_key]
        value = proven.get(setting) if setting == "despeckle" else True
        on = ok and present and value not in (None, False, "none")
        why = f"{why_need if present else 'not needed: ' + why_need}; {note}"
        decide(key, on, why, **{setting: value}, **extra)
    return p.validate(), decisions


def merge(base: CleanParams, overrides: dict | None) -> CleanParams:
    if not overrides:
        return base
    data = dataclasses.asdict(base)
    data.update(overrides)
    return CleanParams.from_dict(data)
