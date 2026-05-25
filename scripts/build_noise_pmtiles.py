#!/usr/bin/env python3
"""
Build airport-noise.pmtiles from CONUS aviation noise state rasters.

Pipeline:
  1. gdal_contour -p per state raster  -> polygon FlatGeobuf of dB bands
  2. ogr2ogr filter + reproject + tag  -> per-state FlatGeobuf in EPSG:4326
  3. ogr2ogr merge                     -> single CONUS FlatGeobuf
  4. tippecanoe                        -> airport-noise.pmtiles

Each output polygon carries:
  db_min  (int)  lower edge of the dB band  (e.g. 45, 50, 55, 60, 65, 70)
  db_max  (int)  upper edge of the dB band
  state   (str)  two-letter state code

The (-inf, 45) "background" band is filtered out so the PMTiles only contains
significant noise contours. Adjust DB_BREAKS below to add/remove bands.

Requires on PATH:
  gdal_contour, ogr2ogr  (GDAL >= 3.6)
  tippecanoe             (>= 2.40)

Run on host (if tools installed) or via the companion Docker image:
  docker build -f scripts/build-noise.Dockerfile -t landrecon-noise-builder scripts
  docker run --rm \
    -v C:/Temp/CONUS_aviation_noise_2020/COG:/src:ro \
    -v ${PWD}/build:/work \
    landrecon-noise-builder \
      --src-dir /src --work-dir /work --out /work/airport-noise.pmtiles
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# dB band breakpoints. Carried forward from the retired raster tile
# server's COLOR_STOPS table so the vector contour bands snap to the same
# dB cutoffs the app's color ramp expects.
DB_BREAKS: list[int] = [45, 50, 55, 60, 65, 70]

# Sentinel passed to gdal_contour above the highest real band so the (70, inf)
# polygon closes at a finite value and `db_max` casts cleanly to int32.
# 200 dB is well above any plausible aviation noise DNL.
DB_UPPER_SENTINEL: int = 200

# Matches both legacy "AL_CNE_*.tif" and current "AL_aviation_noise_2020.tif".
STATE_RE = re.compile(r"^([A-Z]{2})_(?:CNE_|aviation_noise_).*\.tif$", re.IGNORECASE)


def find_state_files(src_dir: Path) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for p in sorted(src_dir.iterdir()):
        m = STATE_RE.match(p.name)
        if m:
            out.append((m.group(1).upper(), p))
    return out


def _run(cmd: list[str], *, capture: bool = False) -> subprocess.CompletedProcess:
    if not capture:
        print("  $ " + " ".join(str(c) for c in cmd))
    return subprocess.run(
        cmd,
        check=True,
        capture_output=capture,
        text=True,
    )


_LAYER_LINE_RE = re.compile(r"^\s*\d+:\s+(\S+)")


def _get_layer_name(path: Path) -> str:
    """Return the first layer name in an OGR dataset by parsing `ogrinfo -ro -q`."""
    res = subprocess.run(
        ["ogrinfo", "-ro", "-q", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    for line in res.stdout.splitlines():
        m = _LAYER_LINE_RE.match(line)
        if m:
            return m.group(1)
    raise RuntimeError(f"no layer found in {path}:\n{res.stdout}")


def contour_one(state: str, src: Path, state_dir: Path) -> tuple[str, bool, str]:
    """Contour one state raster and produce a tagged, reprojected FlatGeobuf."""
    raw = state_dir / f"{state}_raw.fgb"
    final = state_dir / f"{state}.fgb"
    try:
        for p in (raw, final):
            if p.exists():
                p.unlink()

        # 1. gdal_contour: polygon mode, attach db_min/db_max attributes.
        #    The trailing DB_UPPER_SENTINEL closes the top band at a finite
        #    value so db_max remains a clean integer instead of +inf.
        _run(
            [
                "gdal_contour",
                "-p",
                "-amin", "db_min",
                "-amax", "db_max",
                "-fl", *[str(v) for v in DB_BREAKS + [DB_UPPER_SENTINEL]],
                "-f", "FlatGeobuf",
                str(src),
                str(raw),
            ],
            capture=True,
        )

        # Layer name in the FlatGeobuf is set by gdal_contour, not by us;
        # query it instead of guessing.
        layer = _get_layer_name(raw)

        # 2. ogr2ogr: drop the (-inf, 45) background band and any (sentinel, +inf)
        #    band, tag with state code, reproject to EPSG:4326, rename layer.
        sql = (
            f"SELECT CAST(db_min AS integer) AS db_min, "
            f"CAST(db_max AS integer) AS db_max, "
            f"'{state}' AS state "
            f"FROM \"{layer}\" "
            f"WHERE db_min >= {DB_BREAKS[0]} AND db_max <= {DB_UPPER_SENTINEL}"
        )
        _run(
            [
                "ogr2ogr",
                "-f", "FlatGeobuf",
                "-t_srs", "EPSG:4326",
                "-dialect", "OGRSQL",
                "-sql", sql,
                "-nln", "airport_noise",
                str(final),
                str(raw),
            ],
            capture=True,
        )
        return state, True, ""
    except subprocess.CalledProcessError as e:
        msg = (e.stderr or e.stdout or str(e)).strip()
        return state, False, msg
    finally:
        if raw.exists():
            raw.unlink()


def merge(state_outputs: list[Path], merged: Path) -> None:
    if merged.exists():
        merged.unlink()
    first, *rest = state_outputs
    _run(
        [
            "ogr2ogr",
            "-f", "FlatGeobuf",
            "-nln", "airport_noise",
            str(merged),
            str(first),
        ]
    )
    for p in rest:
        _run(
            [
                "ogr2ogr",
                "-f", "FlatGeobuf",
                "-update", "-append",
                "-nln", "airport_noise",
                str(merged),
                str(p),
            ]
        )


def build_pmtiles(merged: Path, out: Path, min_zoom: int, max_zoom: int) -> None:
    if out.exists():
        out.unlink()
    _run(
        [
            "tippecanoe",
            "-o", str(out),
            "-l", "airport_noise",
            f"-Z{min_zoom}",
            f"-z{max_zoom}",
            "--coalesce-densest-as-needed",
            "--extend-zooms-if-still-dropping",
            "--no-tile-size-limit",
            "--attribute-type=db_min:int",
            "--attribute-type=db_max:int",
            "--force",
            str(merged),
        ]
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build airport-noise.pmtiles from CONUS aviation noise rasters.",
    )
    ap.add_argument("--src-dir", required=True, type=Path,
                    help="Directory containing per-state GeoTIFFs (COG recommended).")
    ap.add_argument("--out", default=Path("airport-noise.pmtiles"), type=Path,
                    help="Output PMTiles file. Default: ./airport-noise.pmtiles")
    ap.add_argument("--work-dir", default=Path("build/noise"), type=Path,
                    help="Working directory for intermediate FlatGeobuf files.")
    ap.add_argument("--min-zoom", type=int, default=4)
    ap.add_argument("--max-zoom", type=int, default=12)
    ap.add_argument("--jobs", type=int,
                    default=max(1, (os.cpu_count() or 4) // 2),
                    help="Parallel contouring workers. Default: half of CPUs.")
    ap.add_argument("--skip-contour", action="store_true",
                    help="Reuse existing per-state FlatGeobufs in work-dir.")
    ap.add_argument("--keep-intermediates", action="store_true",
                    help="Keep merged.fgb and per-state files after build.")
    args = ap.parse_args()

    src = args.src_dir.resolve()
    work = args.work_dir.resolve()
    out = args.out.resolve()
    state_dir = work / "states"

    for tool in ("gdal_contour", "ogr2ogr", "tippecanoe"):
        if shutil.which(tool) is None:
            print(f"ERROR: required tool '{tool}' not found on PATH", file=sys.stderr)
            return 1

    if not src.is_dir():
        print(f"ERROR: --src-dir not a directory: {src}", file=sys.stderr)
        return 1

    state_files = find_state_files(src)
    if not state_files:
        print(f"ERROR: no per-state rasters matched in {src}", file=sys.stderr)
        return 1
    print(f"Found {len(state_files)} state raster(s) in {src}")

    state_dir.mkdir(parents=True, exist_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)

    # ---- Step 1: contour each state ----
    state_outputs: list[Path] = []
    if args.skip_contour:
        for state, _ in state_files:
            p = state_dir / f"{state}.fgb"
            if not p.exists():
                print(f"ERROR: --skip-contour set but missing {p}", file=sys.stderr)
                return 1
            state_outputs.append(p)
        print(f"Reusing {len(state_outputs)} existing per-state FlatGeobufs")
    else:
        print(f"Contouring {len(state_files)} states with {args.jobs} parallel job(s) ...")
        t0 = time.time()
        failed: list[tuple[str, str]] = []
        with ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futures = {
                ex.submit(contour_one, state, path, state_dir): state
                for state, path in state_files
            }
            for f in as_completed(futures):
                state = futures[f]
                s, ok, err = f.result()
                outp = state_dir / f"{s}.fgb"
                if ok and outp.exists() and outp.stat().st_size > 0:
                    print(f"  ok {s}  ({outp.stat().st_size / 1024:.0f} KB)")
                    state_outputs.append(outp)
                elif ok:
                    # gdal_contour returned no features for this state (no noise data).
                    print(f"  -- {s}  (no features)")
                else:
                    print(f"  FAIL {s}: {err[:300]}", file=sys.stderr)
                    failed.append((s, err))
        if failed:
            print(f"ERROR: {len(failed)} state(s) failed contouring.", file=sys.stderr)
            return 1
        print(f"Contouring done in {time.time() - t0:.1f}s "
              f"({len(state_outputs)} non-empty / {len(state_files)} total)")

    if not state_outputs:
        print("ERROR: no per-state output to merge.", file=sys.stderr)
        return 1
    state_outputs.sort()

    # ---- Step 2: merge to one CONUS FlatGeobuf ----
    merged = work / "merged.fgb"
    print(f"Merging {len(state_outputs)} layers -> {merged}")
    merge(state_outputs, merged)
    print(f"  merged size: {merged.stat().st_size / (1024 * 1024):.1f} MB")

    # ---- Step 3: tippecanoe -> PMTiles ----
    print(f"Building PMTiles -> {out}  (zoom {args.min_zoom}..{args.max_zoom})")
    build_pmtiles(merged, out, args.min_zoom, args.max_zoom)
    print(f"Output: {out}  ({out.stat().st_size / (1024 * 1024):.1f} MB)")

    if not args.keep_intermediates:
        shutil.rmtree(state_dir, ignore_errors=True)
        if merged.exists():
            merged.unlink()

    return 0


if __name__ == "__main__":
    sys.exit(main())
