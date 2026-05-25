# scripts/ — offline data builders

## `build_noise_pmtiles.py`

Builds `airport-noise.pmtiles` from per-state CONUS aviation noise GeoTIFFs.

Pipeline:

1. `gdal_contour -p` on each state raster, producing polygon FlatGeobufs with
   `db_min` / `db_max` attributes at the 45/50/55/60/65/70 dB band edges
   (matching the legend used elsewhere in the app).
2. `ogr2ogr` drops the sub-45 background band, tags each polygon with a
   two-letter `state` code, and reprojects to EPSG:4326.
3. `ogr2ogr` merges the per-state outputs into one CONUS FlatGeobuf.
4. `tippecanoe` writes a single `airport-noise.pmtiles` archive
   (zoom 4–12 by default).

The resulting file is meant to be uploaded to Azure Blob (or any static host
that supports HTTP range requests) and consumed by the frontend via
`pmtiles` + `protomaps-leaflet`.

### Running it (Windows, recommended)

```powershell
# One step — builds the image if missing, then runs the pipeline.
./scripts/build-noise.ps1

# Custom source dir or output path:
./scripts/build-noise.ps1 -SrcDir "D:\noise\COG" -OutFile "D:\out\noise.pmtiles"

# Rebuild the Docker image (e.g. after editing the Dockerfile):
./scripts/build-noise.ps1 -Rebuild
```

### Running it (Docker, manual)

```bash
docker build -f scripts/build-noise.Dockerfile -t landrecon-noise-builder scripts

docker run --rm \
  -v /c/Temp/CONUS_aviation_noise_2020/COG:/src:ro \
  -v "$PWD/build":/work \
  landrecon-noise-builder \
    --src-dir /src \
    --work-dir /work \
    --out /work/airport-noise.pmtiles
```

### Running it on a host with GDAL + tippecanoe already installed

```bash
python scripts/build_noise_pmtiles.py \
  --src-dir /path/to/state_rasters \
  --out airport-noise.pmtiles
```

### Output

A single `airport-noise.pmtiles` file (expected size: tens of MB given the
sparse spatial footprint of aviation noise). Each polygon feature has:

| field    | type   | description                            |
|----------|--------|----------------------------------------|
| `db_min` | int    | lower edge of the dB band (45..70)     |
| `db_max` | int    | upper edge of the dB band              |
| `state`  | string | two-letter US state code               |

### When to rerun

The CONUS aviation noise dataset is published annually. Rerun this script
whenever you drop in a new year's state rasters and want to publish a fresh
PMTiles file.

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
