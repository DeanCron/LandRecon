"""
Lightweight tile server for Airport Noise raster overlays.

Reads state-level GeoTIFFs (ideally COGs) from the CONUS aviation noise dataset
and serves XYZ PNG tiles with a dB color ramp. Tiles are cached to disk after
first generation. Handles state-border mosaics automatically.

Usage:
    python tile_server.py [--port 8001] [--data-dir PATH] [--cache-dir PATH]
"""

import argparse
import hashlib
import io
import os
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from threading import Lock

import mercantile
import numpy as np
from PIL import Image
from rasterio.crs import CRS
from rasterio.warp import transform_bounds
from rio_tiler.io import Reader


DEFAULT_DATA_DIR = r"C:\Temp\CONUS_aviation_noise_2020\State_rasters"
DEFAULT_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".tile_cache")
TILE_SIZE = 256
DB_MIN = 45.0
DB_MAX = 70.0

# Color ramp: green → yellow → orange → red (for 45 → 70 dB)
COLOR_STOPS = np.array([
    [45, 34, 139, 34],
    [50, 124, 179, 66],
    [55, 255, 235, 59],
    [60, 255, 152, 0],
    [65, 244, 67, 54],
    [70, 136, 14, 79],
], dtype=np.float32)


def db_to_rgba(data: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Convert dB float values to RGBA using the color ramp, vectorized."""
    h, w = data.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    valid = mask > 0
    if not np.any(valid):
        return rgba

    clamped = np.clip(data, DB_MIN, DB_MAX)
    db_vals = COLOR_STOPS[:, 0]
    rgb_vals = COLOR_STOPS[:, 1:4]

    # Vectorized interpolation across all color stops
    norm = (clamped[valid] - DB_MIN) / (DB_MAX - DB_MIN) * (len(db_vals) - 1)
    idx = np.clip(norm.astype(int), 0, len(db_vals) - 2)
    frac = norm - idx

    for c in range(3):
        lo = rgb_vals[idx, c]
        hi = rgb_vals[idx + 1, c]
        rgba[valid, c] = (lo + frac * (hi - lo)).astype(np.uint8)
    rgba[valid, 3] = 180

    return rgba


# 256x256 transparent PNG cached once
_EMPTY_TILE: bytes | None = None


def get_empty_tile() -> bytes:
    global _EMPTY_TILE
    if _EMPTY_TILE is None:
        img = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        _EMPTY_TILE = buf.getvalue()
    return _EMPTY_TILE


class ReaderPool:
    """Keeps rasterio Reader objects open for reuse."""

    def __init__(self):
        self._readers: dict[str, Reader] = {}
        self._lock = Lock()

    def get(self, path: str) -> Reader:
        with self._lock:
            if path not in self._readers:
                reader = Reader(path)
                reader.__enter__()
                self._readers[path] = reader
            return self._readers[path]

    def close_all(self):
        with self._lock:
            for reader in self._readers.values():
                try:
                    reader.__exit__(None, None, None)
                except Exception:
                    pass
            self._readers.clear()


class StateIndex:
    """Spatial index of state raster files."""

    def __init__(self, data_dir: str):
        self.entries: list[dict] = []

        for fname in sorted(os.listdir(data_dir)):
            if not fname.endswith(".tif"):
                continue
            state = fname[:2]
            path = os.path.join(data_dir, fname)
            try:
                reader = _reader_pool.get(path)
                native_bounds = reader.dataset.bounds
                native_crs = reader.dataset.crs
                bounds_4326 = transform_bounds(
                    native_crs, CRS.from_epsg(4326),
                    native_bounds.left, native_bounds.bottom,
                    native_bounds.right, native_bounds.top,
                    densify_pts=21,
                )
                self.entries.append({
                    "state": state,
                    "path": path,
                    "bounds": bounds_4326,  # (west, south, east, north)
                })
            except Exception as e:
                print(f"Warning: could not index {fname}: {e}")

        print(f"Indexed {len(self.entries)} state rasters")

    def find_overlapping(self, tile_bounds) -> list[dict]:
        tw, ts, te, tn = tile_bounds
        results = []
        for entry in self.entries:
            ew, es, ee, en = entry["bounds"]
            if tw < ee and te > ew and ts < en and tn > es:
                results.append(entry)
        return results


class TileCache:
    """Simple disk cache for rendered tiles."""

    def __init__(self, cache_dir: str):
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)

    def _path(self, z: int, x: int, y: int) -> str:
        return os.path.join(self.cache_dir, str(z), str(x), f"{y}.png")

    def get(self, z: int, x: int, y: int) -> bytes | None:
        p = self._path(z, x, y)
        if os.path.exists(p):
            with open(p, "rb") as f:
                return f.read()
        return None

    def put(self, z: int, x: int, y: int, data: bytes):
        p = self._path(z, x, y)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)


def render_tile(z: int, x: int, y: int) -> bytes:
    """Render a single tile, mosaicking multiple states if needed."""
    # Check disk cache first
    cached = _tile_cache.get(z, x, y)
    if cached is not None:
        return cached

    tile = mercantile.Tile(x, y, z)
    tb = mercantile.bounds(tile)
    tile_bounds = (tb.west, tb.south, tb.east, tb.north)

    overlapping = _state_index.find_overlapping(tile_bounds)
    if not overlapping:
        return get_empty_tile()

    composited_data = None
    composited_mask = None

    for entry in overlapping:
        try:
            reader = _reader_pool.get(entry["path"])
            img = reader.tile(x, y, z, tilesize=TILE_SIZE)
            data = img.data[0].astype(np.float32)
            mask = np.ones_like(data, dtype=np.uint8) * 255
            if img.mask is not None:
                m = img.mask[0] if len(img.mask.shape) == 3 else img.mask
                mask = m
            mask[np.isnan(data)] = 0
            mask[data < DB_MIN] = 0

            if composited_data is None:
                composited_data = data
                composited_mask = mask
            else:
                fill = (composited_mask == 0) & (mask > 0)
                composited_data[fill] = data[fill]
                composited_mask[fill] = mask[fill]
        except Exception:
            continue

    if composited_data is None or not np.any(composited_mask > 0):
        result = get_empty_tile()
    else:
        rgba = db_to_rgba(composited_data, composited_mask)
        img = Image.fromarray(rgba, "RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        result = buf.getvalue()

    _tile_cache.put(z, x, y, result)
    return result


_reader_pool = ReaderPool()
_state_index: StateIndex = None  # type: ignore
_tile_cache: TileCache = None  # type: ignore

TILE_PATH_RE = re.compile(r"^/tiles/airport-noise/(\d+)/(\d+)/(\d+)\.png$")


class TileHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        match = TILE_PATH_RE.match(self.path)
        if not match:
            self.send_error(404)
            return

        z, x, y = int(match.group(1)), int(match.group(2)), int(match.group(3))

        try:
            png_bytes = render_tile(z, x, y)
        except Exception as e:
            print(f"Tile error {z}/{x}/{y}: {e}")
            png_bytes = get_empty_tile()

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(png_bytes)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(png_bytes)

    def log_message(self, fmt, *args):
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    global _state_index, _tile_cache

    parser = argparse.ArgumentParser(description="Airport Noise tile server")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    args = parser.parse_args()

    # Prefer COG directory if it has all the states; otherwise use originals
    cog_dir = os.path.join(os.path.dirname(args.data_dir), "COG")
    orig_count = len([f for f in os.listdir(args.data_dir) if f.endswith(".tif")])
    cog_count = 0
    if os.path.isdir(cog_dir):
        cog_count = len([f for f in os.listdir(cog_dir) if f.endswith(".tif")])
    if cog_count >= orig_count:
        data_dir = cog_dir
        print(f"Using COG rasters from {cog_dir} ({cog_count} files)")
    else:
        data_dir = args.data_dir
        print(f"Using original rasters from {data_dir} ({orig_count} files)")
        if cog_count > 0:
            print(f"  (COG conversion in progress: {cog_count}/{orig_count})")

    _tile_cache = TileCache(args.cache_dir)
    print(f"Tile cache: {args.cache_dir}")

    print(f"Indexing rasters (keeping readers open)...")
    _state_index = StateIndex(data_dir)

    server = ThreadedHTTPServer(("localhost", args.port), TileHandler)
    print(f"Tile server listening on http://localhost:{args.port}")
    print(f"Tile URL: http://localhost:{args.port}/tiles/airport-noise/{{z}}/{{x}}/{{y}}.png")

    try:
        server.serve_forever()
    finally:
        _reader_pool.close_all()


if __name__ == "__main__":
    main()
