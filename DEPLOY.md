# Azure Deployment Guide

LandRecon deploys as a **single nginx container on Azure Container Apps**
serving the prebuilt React SPA. The airport noise PMTiles archive lives in
Azure Blob Storage and is fetched directly by the browser.

---

## Architecture

```
Azure Blob Storage
└── tiles/
    └── airport-noise.pmtiles      (static, ~7 MB, byte-range reads)

Azure Container Apps
└── Docker container (nginx:alpine)
    └── /usr/share/nginx/html/     (dist/ from `vite build`)
        ├── index.html
        ├── assets/...
        └── data/airport-noise.pmtiles   (bundled fallback copy)
```

The container has no Python, no GDAL, no tile-rendering code — it just
serves static files. All "live" map data is fetched from third-party APIs
(Overpass, EPA, etc.) directly from the browser.

---

## Local Docker Testing

```bash
# Build
docker build \
  --build-arg VITE_TOMTOM_API_KEY=your-tomtom-key \
  --build-arg VITE_GOOGLE_MAPS_KEY=your-google-key \
  -t landrecon .

# Run
docker run --rm -p 8000:8000 landrecon
```

Visit http://localhost:8000

---

## Step 1: Create Azure Resources

```bash
# Resource group
az group create --name LandRecon-RG --location eastus

# Container Apps environment
az containerapp env create \
  --name landrecon-env \
  --resource-group LandRecon-RG \
  --location eastus

# Container app — pure static server, no volume mounts needed
az containerapp create \
  --name landrecon \
  --resource-group LandRecon-RG \
  --environment landrecon-env \
  --image ghcr.io/deancron/landrecon:latest \
  --target-port 8000 \
  --ingress external \
  --cpu 0.5 --memory 1Gi \
  --min-replicas 0 \
  --max-replicas 3
```

> The legacy raster tile server required GDAL + a mounted Azure Files share
> with `State_rasters/`. Those resources can be deleted — the PMTiles
> pipeline is offline and the output ships to blob storage instead.

---

## Step 2: Publish the Noise PMTiles Archive

Build the archive once (see `scripts/README.md`) and upload it:

```powershell
az login
./scripts/deploy-noise-pmtiles.ps1 `
    -StorageAccount landreconstorage `
    -Container tiles
```

The script creates the container (anonymous blob read), sets CORS for
GET / HEAD / OPTIONS with `Range` request and `Content-Range` /
`Accept-Ranges` exposed, and uploads with `Content-Type:
application/vnd.pmtiles` plus a 1-day Cache-Control. It prints the URL.

Rerun whenever the source dataset is refreshed (annual).

---

## Step 3: Configure GitHub Secrets & Variables

In GitHub repo → Settings → Secrets and variables → Actions:

**Secrets:**
| Name | Value |
|------|-------|
| `AZURE_CREDENTIALS` | Service principal JSON (`az ad sp create-for-rbac --sdk-auth`) |
| `TOMTOM_API_KEY` | Your TomTom API key |
| `GOOGLE_MAPS_KEY` | Your Google Maps Platform API key (Map Tiles + Places APIs enabled) |

**Variables:**
| Name | Value |
|------|-------|
| `AZURE_CONTAINER_APP_NAME` | `landrecon` |
| `AZURE_RESOURCE_GROUP` | `LandRecon-RG` |
| `NOISE_PMTILES_URL` | Public URL of the uploaded PMTiles archive, e.g. `https://landreconstorage.blob.core.windows.net/tiles/airport-noise.pmtiles`. Leave blank to fall back to the bundled `/data/airport-noise.pmtiles` copy. |

---

## Step 4: Deploy

Push to `main` — GitHub Actions will:
1. Build the Docker image (Node build stage → nginx runtime stage)
2. Push to GitHub Container Registry (ghcr.io)
3. Deploy new revision to Azure Container Apps

---

## Scaling

Container Apps auto-scales based on HTTP traffic:
- `min-replicas: 0` — scales to zero when idle (static-only workload, fast cold start)
- `max-replicas: 3` — handles traffic spikes
- 0.5 CPU / 1 GiB RAM is plenty for an nginx static server

---

## Local Development (no Docker)

```bash
npm install
npm run dev
```

Vite serves `public/data/airport-noise.pmtiles` directly with native HTTP
range support — no proxy or backend required.
