"""Small shared helpers."""

import numpy as np


def jsonable(v):
    """numpy scalars / arrays -> plain JSON values (reports are built from numpy results); `_private` keys dropped."""
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items() if not str(k).startswith("_")}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, np.ndarray):
        return jsonable(v.tolist())
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return None if not np.isfinite(v) else float(v)
    if isinstance(v, float) and not np.isfinite(v):
        return None
    return v
