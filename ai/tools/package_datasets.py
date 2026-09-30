"""Package the raw sonar datasets into one slim zip for upload to Google Drive.

- Drops files the training notebook does not need (Darknet weights, desktop.ini,
  the duplicate Kaggle copy `my_archive`).
- Re-encodes AquaScan-1K screenshots from PNG to grayscale JPEG (training uses grayscale anyway)
  so the upload is smaller; image size is unchanged so YOLO labels stay valid.

Usage:
    python package_datasets.py "D:/Downloads/Data Sets" "D:/Downloads/sonar_datasets.zip"
"""

import io
import sys
import zipfile
from pathlib import Path

from PIL import Image

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "D:/Downloads/Data Sets")
DST = Path(sys.argv[2] if len(sys.argv) > 2 else "D:/Downloads/sonar_datasets.zip")
ROOT = "sonar_datasets"


def add(zf, path, arcname):
    zf.write(path, f"{ROOT}/{arcname}", compress_type=zipfile.ZIP_STORED)


def main():
    count = 0
    with zipfile.ZipFile(DST, "w") as zf:
        # 1. AI4Shipwrecks: PNG images + binary PNG masks (already compressed).
        for split in ["train", "test", "extras/terrain"]:
            for kind in ["images", "labels"]:
                for p in sorted((SRC / "AI4Shipwrecks" / split / kind).glob("*.png")):
                    add(zf, p, f"ai4shipwrecks/{split}/{kind}/{p.name}")
                    count += 1

        # 2. Roboflow sonar_detect (aircraft / fish / other / shipwreck).
        add(zf, SRC / "archive" / "data.yaml", "roboflow_sonar/data.yaml")
        for split in ["train", "valid", "test"]:
            for kind, ext in [("images", "*.jpg"), ("labels", "*.txt")]:
                for p in sorted((SRC / "archive" / split / kind).glob(ext)):
                    add(zf, p, f"roboflow_sonar/{split}/{kind}/{p.name}")
                    count += 1

        # 3. Figshare 24574879 MILCO / NOMBO mine-like object dataset.
        add(zf, SRC / "24574879" / "Training" / "obj.names.txt", "milco_nombo/obj.names.txt")
        for year in ["2010", "2015", "2017", "2018", "2021"]:
            for p in sorted((SRC / "24574879" / year).iterdir()):
                if p.suffix.lower() in {".jpg", ".txt"}:
                    add(zf, p, f"milco_nombo/{year}/{p.name}")
                    count += 1

        # 4. AquaScan-1K (human / drowning-victim detection) -> JPEG.
        #    Corrupted (truncated) screenshots are skipped together with their label.
        add(zf, SRC / "AquaScan-1K" / "classes.txt", "aquascan/classes.txt")
        for p in sorted((SRC / "AquaScan-1K" / "images").iterdir()):
            if p.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
                continue
            label = SRC / "AquaScan-1K" / "labels" / f"{p.stem}.txt"
            try:
                image = Image.open(p).convert("L")
            except OSError as error:
                print(f"Skipping corrupted image {p.name}: {error}")
                continue
            buf = io.BytesIO()
            image.save(buf, "JPEG", quality=92)
            zf.writestr(f"{ROOT}/aquascan/images/{p.stem}.jpg", buf.getvalue())
            if label.exists():
                add(zf, label, f"aquascan/labels/{label.name}")
            count += 1

    print(f"Wrote {count} files -> {DST} ({DST.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
