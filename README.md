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
  Logs are tagged: `[LR:geocode]`, `[LR:tiles]`, `[LR:cameras]`, etc.
- **OG sidecar** — set `LR_DEBUG_OG=1` (or `LR_DEBUG=1`) on the container.
  Each request logs `[og] png HIT/MISS addr=… layers=N base=… bytes=… 97ms ua=…`.
