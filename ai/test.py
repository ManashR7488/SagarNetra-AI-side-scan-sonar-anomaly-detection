from pathlib import Path

import numpy as np
import streamlit as st
from PIL import Image


APP_DIR = Path(__file__).resolve().parent
MODEL_PATH = (
	APP_DIR
	/ "models"
	/ "AI4Shipwrecks"
	/ "yolo11n_seg_baseline"
	/ "weights"
	/ "best.pt"
)


st.set_page_config(
	page_title="AI4Shipwrecks Predictor",
	page_icon="🔎",
	layout="wide",
)


@st.cache_resource
def load_model():
	from ultralytics import YOLO

	return YOLO(str(MODEL_PATH))


def render_prediction(result):
	"""Return the Ultralytics annotated image as an RGB array."""
	annotated = result.plot(
		conf=True,
		labels=True,
		boxes=True,
		masks=True,
	)
	return annotated[:, :, ::-1]


st.title("AI4Shipwrecks Predictor")
st.caption("Upload a sonar image and compare it with the YOLO segmentation result.")

if not MODEL_PATH.exists():
	st.error(f"Model weights were not found at: {MODEL_PATH}")
	st.stop()

with st.sidebar:
	st.header("Prediction settings")
	confidence = st.slider(
		"Confidence threshold",
		min_value=0.05,
		max_value=0.90,
		value=0.15,
		step=0.05,
		help="Lower values show more possible shipwrecks; higher values show fewer, more confident detections.",
	)
	image_size = st.select_slider(
		"Inference image size",
		options=[640, 768, 1024, 1280],
		value=1024,
	)

uploaded_file = st.file_uploader(
	"Upload an image",
	type=["png", "jpg", "jpeg", "bmp", "webp"],
)

if uploaded_file is None:
	st.info("Choose a sonar image above to begin.")
	st.stop()

original_image = Image.open(uploaded_file).convert("RGB")

left_panel, right_panel = st.columns(2, gap="large")
with left_panel:
	st.subheader("Original image")
	st.image(original_image, use_container_width=True)

predict_clicked = st.button(
	"Predict",
	type="primary",
	use_container_width=True,
)

if predict_clicked:
	with st.spinner("Running shipwreck segmentation..."):
		try:
			model = load_model()
			results = model.predict(
				source=np.array(original_image),
				imgsz=image_size,
				conf=confidence,
				iou=0.7,
				device="cpu",
				retina_masks=True,
				verbose=False,
			)
			print(f"Prediction results: {results}")
			result = results[0]
			predicted_image = render_prediction(result)
		except Exception as error:
			st.error(f"Prediction failed: {error}")
			st.stop()

	with right_panel:
		st.subheader("Prediction")
		st.image(predicted_image, use_container_width=True)

	detections = 0 if result.boxes is None else len(result.boxes)
	st.success(f"Prediction complete: {detections} shipwreck detection(s) found.")

	if detections:
		confidences = result.boxes.conf.detach().cpu().tolist()
		st.write(
			"Confidence scores: "
			+ ", ".join(f"{score:.2f}" for score in confidences)
		)
