# Land Recon

A web app for exploring U.S. land data and map layers by street address.

## Getting Started

```bash
npm install
npm run dev
```

## Tech Stack

- **React 19** with TypeScript
- **Vite** for dev server and bundling
- **Leaflet** for interactive maps, with **Google Maps Tiles** (street + satellite basemaps) and **PMTiles** for offline-friendly airport-noise contours
- **React Router** for client-side routing
- **TomTom** Search API for geocoding, address autocomplete, and live traffic-flow tiles (US-only — `countrySet=US` is enforced on typeahead, forward geocode, and reverse geocode)
- **Google Places API** for transit stops, hospital/ER, and Costco lookups
- **EPA ArcGIS** services for Superfund site boundaries
- **nginx + Node sidecar (`sharp`)** for per-address Open Graph cards rendered at request time
- **GitHub Actions → Azure Container Apps** for deploy; **Azure Blob Storage** for nightly Overpass snapshot blobs (cameras, crowd, transit) crawled via a 3-endpoint rotation

## Project Structure

```
src/
  App.tsx          # Route definitions
  main.tsx         # App entry point
  index.css        # Global styles / CSS variables
  pages/
    HomePage.tsx   # Address search with autocomplete + "Use my location"
    MapPage.tsx    # Map view with geocoded marker, layers, and Recon Report
server/
  og.mjs                # OG sidecar (127.0.0.1:3002): /og.png + /share with LRU caches
  render-og-image.mjs   # Shared SVG-to-PNG renderer used at build and request time
  dev-todos.mjs         # Dev todo list sidecar
scripts/
  generate-og-image.mjs # Build-time brand-level og-image.png
smoke-test.mjs        # 100-address production smoke test (see below)
smoke-addresses.json  # Curated address fixtures (urban / suburban / rural)
lib/conus-crawl.mjs   # Overpass crawler with 3-endpoint rotation
nginx.conf              # UA-fork: crawlers on /map get sidecar HTML with per-URL OG tags
Dockerfile              # Multi-stage; runtime installs sharp + DejaVu fonts on Alpine
entrypoint.sh           # Launches og.mjs + dev-todos.mjs, execs nginx as PID 1
```

## Share Previews (Open Graph)

Sharing a `/map?address=…&layers=…&base=…` URL on iMessage, Slack, Discord,
Facebook, etc. yields a personalized preview card showing the address, the
active layers, and the basemap.

- nginx detects ~24 crawler user agents and forks `/map` requests to the
  sidecar's `/share` endpoint, which serves `index.html` with the OG/Twitter
  tags rewritten to per-URL values.
- The sidecar's `/og.png` renders the card via an SVG template piped through
  `sharp`. Cards are cached (LRU 200) and the default card is pre-warmed at
  startup. Cold render ≈120 ms, warm cache ≈7 ms.
- iMessage generates the preview on the **sender's device at send-time**, so
  a link shared before the OG pipeline was deployed will preview empty
  forever — append `?v=2` (or any cache-buster) to force a fresh fetch.

## Debugging

Both pages and the OG sidecar are silent by default and can be instrumented
on demand:

- **Browser** — `localStorage.setItem('LR_DEBUG','1'); location.reload()`.
  Logs are tagged: `[LR:geocode]`, `[LR:tiles]`, `[LR:cameras]`, `[LR:er]`,
  `[LR:ems]`, `[LR:costco]`, `[LR:superfund]`, `[LR:crowd]`, `[LR:places-cache]` (cache HIT/MISS), etc.
- **OG sidecar** — set `LR_DEBUG_OG=1` (or `LR_DEBUG=1`) on the container.
  Each request logs `[og] png HIT/MISS addr=… layers=N base=… bytes=… 97ms ua=…`.

## Performance & Cost

The site is tuned for cheap idle and cheap per-visit costs:

- **Azure Container Apps scales to zero** (min 0, max 3, 0.5 vCPU / 1 GiB).
  Idle bill ≈ $1–3/mo. Cold start ≈ 3–5 s, mitigated by the OG sidecar's
  libvips pre-warm.
- **Snapshot blobs are immutable for 24 h**
  (`Cache-Control: public, max-age=86400, immutable`). Repeat visitors hit
  the browser/SW cache; CDN egress only happens once per visitor per day.
- **Google Places responses cached in IndexedDB** (`src/utils/placesCache.ts`).
  Keys are snapped to a ~1.1 km grid with a 7-day TTL, LRU-capped at 500.
  Collapses the ~5–10× duplicate queries fired as a user pans around a
  neighborhood.
- **OG card LRU + pre-warm**: default card seeded at sidecar startup; LRU
  200 entries. Cold render ≈ 120 ms, cache hit ≈ 7 ms.

## Smoke Tests

`scripts/smoke-test.mjs` exercises the live deployment end-to-end with 100
real US addresses curated across urban downtowns, suburban office parks, and
rural towns (`scripts/smoke-addresses.json`). For each address it hits
`/map` (browser UA), `/map` (crawler UA — verifying `og:title`, `og:image`,
`og:image:secure_url`, `og:url` are rewritten and `https://`), and
`/og.png` (verifying image/png with sane byte size). Pre-flight also
probes `/`, `/og-image.png`, and each of the four nightly Azure snapshot
blobs (must be ≤48 h old). With `VITE_TOMTOM_API_KEY` set, it adds a
TomTom forward-geocode check per address.

```bash
npm run smoke                                       # full run against prod
npm run smoke -- --only=rural --limit=5             # quick rural sample
npm run smoke -- --target=http://localhost:8080     # against local container
npm run smoke -- --skip-snapshots --skip-tomtom     # minimal mode
node scripts/smoke-test.mjs --help                  # all flags
```

Exit code is `0` if every check passes, `1` otherwise. A full per-address
report is written to `scripts/smoke-test-results.json`.
