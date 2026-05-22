"""
Combined server for LandRecon: serves the React frontend (static files)
and the tile server API from a single Flask app on Azure App Service.
"""

import os
import io
import re
from threading import Lock

import mercantile
import numpy as np
from flask import Flask, Response, send_from_directory
from PIL import Image
from rasterio.crs import CRS
from rasterio.warp import transform_bounds
from rio_tiler.io import Reader

# Static files directory (Vite build output)
STATIC_DIR = os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(__file__), "static"))

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")

# Configuration via environment variables
DATA_DIR = os.environ.get("TILE_DATA_DIR") or "/data"
CACHE_DIR = os.environ.get("TILE_CACHE_DIR") or "/app/.tile_cache"
TILE_SIZE = 256
DB_MIN = 45.0
DB_MAX = 70.0

COLOR_STOPS = np.array([
    [45, 34, 139, 34],
    [50, 124, 179, 66],
    [55, 255, 235, 59],
    [60, 255, 152, 0],
    [65, 244, 67, 54],
    [70, 136, 14, 79],
], dtype=np.float32)

STATE_RE = re.compile(r"^([A-Z]{2})_CNE_.*\.tif$", re.IGNORECASE)
_readers: dict = {}
_lock = Lock()


def db_to_rgba(data: np.ndarray, mask: np.ndarray) -> np.ndarray:
    h, w = data.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    valid = mask > 0
    if not np.any(valid):
        return rgba
    clamped = np.clip(data, DB_MIN, DB_MAX)
    db_vals = COLOR_STOPS[:, 0]
    rgb_vals = COLOR_STOPS[:, 1:4]
    norm = (clamped[valid] - DB_MIN) / (DB_MAX - DB_MIN) * (len(db_vals) - 1)
    idx = np.clip(norm.astype(int), 0, len(db_vals) - 2)
    frac = norm - idx
    for c in range(3):
        lo = rgb_vals[idx, c]
        hi = rgb_vals[np.minimum(idx + 1, len(db_vals) - 1), c]
        rgba[valid, c] = (lo + frac * (hi - lo)).astype(np.uint8)
    rgba[valid, 3] = 180
    return rgba


def get_state_files() -> dict:
    state_files = {}
    if not os.path.isdir(DATA_DIR):
        return state_files
    for fname in os.listdir(DATA_DIR):
        m = STATE_RE.match(fname)
        if m:
            state_files[m.group(1).upper()] = os.path.join(DATA_DIR, fname)
    return state_files


def get_reader(path: str):
    with _lock:
        if path not in _readers:
            _readers[path] = Reader(path)
        return _readers[path]


def render_tile(z: int, x: int, y: int) -> bytes:
    tile_bounds = mercantile.xy_bounds(x, y, z)
    state_files = get_state_files()
    composite = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)

    for state, path in state_files.items():
        try:
            reader = get_reader(path)
            src_bounds = transform_bounds(
                reader.dataset.crs, CRS.from_epsg(3857),
                *reader.dataset.bounds
            )
            if (src_bounds[2] < tile_bounds.left or src_bounds[0] > tile_bounds.right or
                    src_bounds[3] < tile_bounds.bottom or src_bounds[1] > tile_bounds.top):
                continue
            img = reader.tile(x, y, z, tilesize=TILE_SIZE)
            data = img.data[0]
            mask = img.mask
            rgba = db_to_rgba(data, mask)
            layer_valid = rgba[:, :, 3] > 0
            composite[layer_valid] = rgba[layer_valid]
        except Exception:
            continue

    img = Image.fromarray(composite, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@app.route("/tiles/airport-noise/<int:z>/<int:x>/<int:y>.png")
def tile(z: int, x: int, y: int):
    cache_path = os.path.join(CACHE_DIR, str(z), str(x), f"{y}.png")
    if os.path.exists(cache_path):
        return send_from_directory(os.path.dirname(cache_path), f"{y}.png", mimetype="image/png")

    png_bytes = render_tile(z, x, y)

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "wb") as f:
        f.write(png_bytes)

    return Response(png_bytes, mimetype="image/png", headers={
        "Cache-Control": "public, max-age=86400",
    })


@app.route("/health")
def health():
    return {"status": "ok", "states": len(get_state_files())}


# Serve React app — all non-API routes fall through to index.html (SPA)
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    file_path = os.path.join(STATIC_DIR, path)
    if path and os.path.isfile(file_path):
        return send_from_directory(STATIC_DIR, path)
    return send_from_directory(STATIC_DIR, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
