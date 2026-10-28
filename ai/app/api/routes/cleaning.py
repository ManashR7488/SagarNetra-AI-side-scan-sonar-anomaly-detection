import json
from typing import Annotated, Literal

import numpy as np
from fastapi import APIRouter, Form, HTTPException, Query
from fastapi.responses import Response

from app.api.deps import load_sonar
from app.cleaning.auto import auto_params, merge
from app.cleaning.params import CleanParams, load_profile_file, profile_params
from app.cleaning.pipeline import STEP_NAMES, clean, diagnose, preview_scale
from app.cleaning.stress import SEVERITY, stress_test
from app.seabed.bottom import track_bottom
from app.core.config import settings
from app.readers.image import encode_jpeg, to_data_url
from app.schemas.forms import CleanRequest, StressRequest
from app.utils import jsonable

router = APIRouter(prefix="/v1", tags=["noise filtration"])


def _params(form: CleanRequest, diag) -> tuple[CleanParams, list[dict]]:
    try:
        if form.auto:
            params, decisions = auto_params(diag.to_dict(), form.profile)
            if form.params:   # only the keys actually sent override Auto
                sent = CleanParams.from_json(form.params).to_dict()
                params = merge(params, {k: sent[k] for k in json.loads(form.params)})
            return params, decisions
        return (CleanParams.from_json(form.params) if form.params else profile_params(form.profile)), []
    except ValueError as e:
        raise HTTPException(422, str(e))


def _benchmark() -> dict | None:
    """The benchmark behind the AI profile: one row per step with its effect on detection vs no cleaning."""
    prof = load_profile_file()
    if not prof:
        return None
    results = prof.get("results") or {}
    steps = []
    for key, ev in (prof.get("evidence") or {}).items():
        r = results.get(ev.get("config")) or {}
        steps.append({"step": key, "config": ev.get("config"), "helps": bool(ev.get("helps")),
                      "summary": ev.get("summary"), "delta": r.get("delta")})
    out = {k: prof.get(k) for k in ("generated", "summary", "datasets", "ai") if k in prof}
    out["baseline"] = (prof.get("baseline") or {}).get("config", "none")
    out["steps"] = steps
    return out


@router.post("/clean")
def clean_preview(
    form: Annotated[CleanRequest, Form()],
    output: Literal["json", "jpeg"] = Query("json", description="json = steps + noise report, jpeg = one step image"),
    step: str | None = Query(None, description="jpeg output: step id (default: the final image)"),
):
    """Noise-filtering stage 1: measure the noise, clean the signal step by step, report before / after."""
    sonar = load_sonar(form.file, form.file_url, form.filename)
    w = sonar.gray.shape[1]
    across = form.across_m_per_px or (form.swath_width_m / w if form.swath_width_m else None)
    diag = diagnose(sonar.gray, sonar.xtf, across)
    params, decisions = _params(form, diag)
    if output == "jpeg" and step is not None and step not in STEP_NAMES:
        raise HTTPException(422, f"step must be one of {', '.join(STEP_NAMES)}")
    result = clean(sonar.gray, params, sonar.xtf, across, keep_steps=True, measure_noise=output == "json", diag=diag)

    if output == "jpeg":
        img = result.image
        if step is not None:
            match = next((s for s in result.steps if s.id == step and s.image is not None), None)
            if match is None:
                raise HTTPException(404, f"step '{step}' did not run with these settings")
            img = match.image
        return Response(encode_jpeg(img, 85, 4096), media_type="image/jpeg",
                        headers={"X-Image-Size": f"{img.shape[1]}x{img.shape[0]}"})

    # One preview per step that changed the image (plus the raw input), sized to stay inside the response budget
    # (serverless hosts cap responses at 4.5 MB; speckled sonar compresses poorly).
    shown = [s for s in result.steps if s.image is not None and (s.applied or s.id == "raw")]
    side = min(form.preview_side or settings.clean_preview_side, 4096)
    budget = settings.clean_response_budget_mb * 1e6
    for _ in range(4):
        previews = {s.id: to_data_url(encode_jpeg(preview_scale(s.image, side), settings.clean_preview_quality))
                    for s in shown}
        total = sum(len(v) for v in previews.values())
        if total <= budget or side <= 512:
            break
        side = max(512, int(side * (budget / total) ** 0.5 * 0.95))
    steps = []
    for s in result.steps:
        entry = {"id": s.id, "name": s.name, "applied": bool(s.applied), "ms": s.ms, "info": jsonable(s.info),
                 "notes": s.notes}
        if s.id in previews:
            entry["size"] = [int(s.image.shape[1]), int(s.image.shape[0])]
            entry["image"] = previews[s.id]
        steps.append(entry)
    final = next(s["id"] for s in reversed(steps) if "image" in s)
    return {
        "source": {**sonar.source, "width": int(w), "height": int(sonar.gray.shape[0])},
        "profile": form.profile,
        "auto": form.auto,
        "decisions": decisions,
        "params": params.to_dict(),
        "steps": steps,
        "final_step": final,
        "frame": jsonable(result.frame.summary()),
        "report": jsonable({k: v for k, v in result.report.items() if k != "frame"}),
        "diagnosis": {"ms": diag.ms, **jsonable(diag.info)},
        "preview_side": side,
        "benchmark": _benchmark(),
    }


@router.post("/stress-test")
def stress(form: Annotated[StressRequest, Form()]):
    """Noise-filtering stage 3: robustness of detection to one disturbance at increasing levels, raw vs cleaned."""
    sonar = load_sonar(form.file, form.file_url, form.filename)
    roles = form.model_roles()
    if not roles:
        raise HTTPException(422, "models must include 'detector' and/or 'segmenter'")
    try:
        roi = form.roi_box()
    except ValueError as e:
        raise HTTPException(422, str(e))
    gray = sonar.gray
    if sonar.xtf is not None:
        nadir = sonar.xtf.nadir_col
    else:
        b = track_bottom(gray, None)
        nadir = b.nadir_col if b else gray.shape[1] / 2
    try:
        result = stress_test(gray, form.disturbance, form.levels or settings.stress_levels,
                             form.max_side or settings.stress_max_side, nadir, roles, roi)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"source": {**sonar.source, "width": int(gray.shape[1]), "height": int(gray.shape[0])},
            "severity_scale": [label for label, _ in SEVERITY[form.disturbance]], **result}
