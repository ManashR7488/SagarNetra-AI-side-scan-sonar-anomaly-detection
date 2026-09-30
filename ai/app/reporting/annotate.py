"""Draw detections (boxes, masks, labels) on the sonar image."""

import cv2
import numpy as np

# BGR colours per class
COLORS = {
    "shipwreck": (235, 99, 37),
    "aircraft_wreck": (246, 92, 139),
    "mine_like_object": (38, 38, 220),
    "debris": (6, 119, 217),
    "human_body": (153, 0, 204),
    "marine_life": (105, 150, 5),
}
SUPPRESSED = (140, 140, 140)


def annotate(gray: np.ndarray, detections: list[dict]) -> np.ndarray:
    img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    h, w = gray.shape
    thick = max(2, int(round(max(h, w) / 700)))
    font = max(0.5, max(h, w) / 1800)
    overlay = img.copy()
    for d in detections:
        color = COLORS.get(d["class_name"], (0, 255, 255)) if d["status"] == "confirmed" else SUPPRESSED
        for poly in d.get("polygons") or []:
            pts = np.array(poly, np.int32).reshape(-1, 1, 2)
            cv2.fillPoly(overlay, [pts], color)
    img = cv2.addWeighted(overlay, 0.35, img, 0.65, 0)
    for d in detections:
        confirmed = d["status"] == "confirmed"
        color = COLORS.get(d["class_name"], (0, 255, 255)) if confirmed else SUPPRESSED
        b = d["bbox"]
        cv2.rectangle(img, (b["x1"], b["y1"]), (b["x2"], b["y2"]), color, thick if confirmed else 1)
        label = f'{d["id"]} {d["class_name"]} {d["confidence"]:.0f}%'
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font, max(1, thick // 2))
        y = b["y1"] - 4 if b["y1"] - th - 6 > 0 else b["y2"] + th + 4
        cv2.rectangle(img, (b["x1"], y - th - 4), (b["x1"] + tw + 4, y + 2), color, -1)
        cv2.putText(img, label, (b["x1"] + 2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, font, (255, 255, 255),
                    max(1, thick // 2), cv2.LINE_AA)
    return img
