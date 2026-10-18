# scripts/ — offline data builders

## `build_noise_pmtiles.py`

Builds `airport-noise.pmtiles` from the CONUS aviation noise rasters published
by the BTS National Transportation Noise Map: either the file geodatabase
(`CONUS_aviation_noise.gdb`, as shipped for 2022) or a folder of per-state
GeoTIFFs (as shipped for 2020 and earlier).

Pipeline:

1. `gdal_contour -p` on each state raster, producing polygon FlatGeobufs with
   `db_min` / `db_max` attributes at the 50/55/60/65/70 dB band edges
   (`NOISE_BAND_BREAKS` in `src/noise/legend.ts`, which the legend, styling and
   point queries all key off).
2. `ogr2ogr` drops the sub-50 background band (the source rasters start at
   45 dB, but the app treats anything under 50 dB as "outside mapped
   contours"), tags each polygon with a two-letter `state` code, and
   reprojects to EPSG:4326.
3. `ogr2ogr` merges the per-state outputs into one CONUS FlatGeobuf.
4. `tippecanoe` writes a single `airport-noise.pmtiles` archive
   (zoom 4–12 by default).

The resulting file is meant to be uploaded to Azure Blob (or any static host
that supports HTTP range requests) and consumed by the frontend via
`pmtiles` + `protomaps-leaflet`.

### Source data

Download "Aviation Noise" for CONUS from
<https://www.bts.gov/geospatial/national-transportation-noise-map> (US
government work, no usage restrictions). The site rejects scripted downloads,
so use a browser. Pass `--src-dir` either the extracted folder or the `.gdb`
inside it:

```
CONUS_aviation_noise_2022/
  CONUS_aviation_noise.gdb        <- 49 rasters: AL_aviation_noise … DC_aviation_noise
  CONUS_aviation_noise.Overviews/
```

GDAL reads the per-state rasters straight out of the geodatabase (this needs
GDAL ≥ 3.7); nothing has to be exported first. If the folder directly contains
per-state GeoTIFFs (`AL_aviation_noise_<year>.tif`), those are used instead.
The values are an A-weighted 24-hour equivalent level (LAeq) in dB at 30 m
resolution, covering the contiguous US only (no Alaska or Hawaii).

### Running it (Windows, recommended)

```powershell
# One step — builds the image if missing, then runs the pipeline.
./scripts/build-noise.ps1

# Custom source dir or output path:
./scripts/build-noise.ps1 -SrcDir "D:\noise\CONUS_aviation_noise_2022" -OutFile "D:\out\noise.pmtiles"

# Rebuild the Docker image (e.g. after editing the Dockerfile):
./scripts/build-noise.ps1 -Rebuild
```

### Running it (Docker, manual)

```bash
docker build -f scripts/build-noise.Dockerfile -t landrecon-noise-builder scripts

docker run --rm \
  -v /c/Temp/CONUS_aviation_noise_2022:/src:ro \
  -v "$PWD/build":/work \
  landrecon-noise-builder \
    --src-dir /src \
    --work-dir /work \
    --out /work/airport-noise.pmtiles
```

### Running it on a host with GDAL + tippecanoe already installed

```bash
python scripts/build_noise_pmtiles.py \
  --src-dir ~/Downloads/CONUS_aviation_noise_2022 \
  --out build/airport-noise.pmtiles
```

Without Docker (for example on macOS), conda-forge ships both tools:

```bash
micromamba create -n noise -c conda-forge gdal tippecanoe
micromamba run -n noise python scripts/build_noise_pmtiles.py \
  --src-dir ~/Downloads/CONUS_aviation_noise_2022 \
  --out build/airport-noise.pmtiles
```

A full 49-state build takes about a minute on a laptop.

### Output

A single `airport-noise.pmtiles` file (about 7–8 MB given the sparse spatial
footprint of aviation noise). Each polygon feature has:

| field    | type   | description                            |
|----------|--------|----------------------------------------|
| `db_min` | int    | lower edge of the dB band (50..70)     |
| `db_max` | int    | upper edge of the dB band (200 = open) |
| `state`  | string | two-letter US state code               |

### Checking a build

Before uploading, replay the app's point query against the new archive. It
accepts a local file or a URL, and checks a handful of major airports plus
two no-noise controls:

```bash
node scripts/smoke-noise.mjs build/airport-noise.pmtiles
```

### When to rerun

BTS publishes a new vintage about every two years (2016, 2018, 2020, 2022).
Rerun this script when a new one is released, then update the
`Aviation Noise <year>` attribution strings in `src/noise/airportNoise.ts` and
`src/map/scoring.ts` and publish the new file (see below).

## `deploy-noise-pmtiles.ps1`

Uploads `build/airport-noise.pmtiles` to Azure Blob Storage so the frontend
can fetch it as static content.

What it does (all idempotent):

1. Creates the blob container if it doesn't exist (`--public-access blob`).
2. Sets a CORS rule on the storage account that allows `GET` / `HEAD` /
   `OPTIONS` with the `Range` request header, and exposes
   `Content-Length`, `Content-Range`, `Accept-Ranges`, and `ETag` to the
   browser. PMTiles relies on HTTP byte ranges to read the directory and
   pull individual tiles.
3. Uploads the file with `Content-Type: application/vnd.pmtiles` and
   `Cache-Control: public, max-age=86400, must-revalidate`.
4. Prints the public URL to wire into `VITE_NOISE_PMTILES_URL`.

```powershell
az login                                    # one-time
./scripts/deploy-noise-pmtiles.ps1 `
    -StorageAccount landreconstorage `
    -Container tiles `
    -AllowedOrigins 'https://<your-prod-host>'
```

Once the URL is known, set `NOISE_PMTILES_URL` as a GitHub Actions repo
variable (see `DEPLOY.md`) and rebuild. Local `npm run dev` ignores the
variable and falls back to `/data/airport-noise.pmtiles`.
