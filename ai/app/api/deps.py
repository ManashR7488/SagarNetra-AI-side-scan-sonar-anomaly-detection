"""Shared request helpers: upload reading, sonar decoding, cached-analysis lookup."""

import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse

from fastapi import HTTPException, UploadFile

from app.core.config import settings
from app.readers.image import IMAGE_EXTENSIONS, ImageDecodeError, decode_gray
from app.readers.xtf import XTFError, load_xtf
from app.services.analysis import MetadataFile, SonarInput
from app.storage.cache import StoredAnalysis, analysis_cache


def read_upload(upload: UploadFile, kind: str) -> bytes:
    limit = settings.max_upload_mb * 1024 * 1024
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"{kind} larger than {settings.max_upload_mb} MB")
    if not data:
        raise HTTPException(400, f"{kind} is empty")
    return data


def fetch_url(url: str, kind: str) -> bytes:
    """Download an input from an allowed https host (see SONAR_FETCH_HOSTS)."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(host == h or host.endswith("." + h) for h in settings.fetch_hosts):
        raise HTTPException(400, f"{kind} URL must be https on an allowed host ({', '.join(settings.fetch_hosts)})")
    limit = settings.max_upload_mb * 1024 * 1024
    try:
        with urllib.request.urlopen(url, timeout=settings.fetch_timeout_s) as res:  # host is allow-listed above
            data = res.read(limit + 1)
    except Exception as e:
        raise HTTPException(400, f"Could not download {kind.lower()}: {e}")
    if len(data) > limit:
        raise HTTPException(413, f"{kind} larger than {settings.max_upload_mb} MB")
    if not data:
        raise HTTPException(400, f"{kind} is empty")
    return data


def _url_name(url: str) -> str:
    return unquote(PurePosixPath(urlparse(url).path).name) or "upload"


def _has_file(upload: UploadFile | None) -> bool:
    return upload is not None and bool(upload.filename)


def load_sonar(upload: UploadFile | None, url: str | None = None, filename: str | None = None) -> SonarInput:
    """Decode an uploaded (or URL-fetched) image or XTF log into grayscale (+ navigation track for XTF)."""
    if not _has_file(upload) and not url:
        raise HTTPException(422, "Provide the sonar file as `file` or `file_url`")
    name = filename or (upload.filename if _has_file(upload) else _url_name(url))
    ext = Path(name).suffix.lower()
    if ext and ext != ".xtf" and ext not in IMAGE_EXTENSIONS:
        raise HTTPException(415, f"Unsupported file type {ext}. Use an image "
                                 f"({', '.join(sorted(IMAGE_EXTENSIONS))}) or .xtf")
    data = read_upload(upload, "Sonar file") if _has_file(upload) else fetch_url(url, "Sonar file")
    if ext == ".xtf":
        try:
            gray, track, info, geometry, log = load_xtf(data, with_geometry=True, with_log=True)
        except XTFError as e:
            raise HTTPException(422, str(e))
        return SonarInput(gray, track, {"filename": name, **info}, geometry, log)
    try:
        gray = decode_gray(data)
    except ImageDecodeError as e:
        raise HTTPException(422, str(e))
    return SonarInput(gray, None, {"filename": name, "format": ext.lstrip(".") or "image"})


def load_metadata(upload: UploadFile | None, url: str | None = None,
                  filename: str | None = None) -> MetadataFile | None:
    if _has_file(upload):
        return MetadataFile(read_upload(upload, "Metadata"), upload.filename)
    if url:
        return MetadataFile(fetch_url(url, "Metadata"), filename or _url_name(url))
    return None


def get_stored(analysis_id: str) -> StoredAnalysis:
    item = analysis_cache.get(analysis_id)
    if item is None:
        raise HTTPException(404, "Analysis not found (expired from the service cache; re-run /v1/analyze)")
    return item
