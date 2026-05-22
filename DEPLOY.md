# Azure Deployment Guide

LandRecon deploys as a **single Azure App Service** (Python/Linux) that serves both
the React frontend and the tile server API.

---

## Architecture

```
Azure App Service (Python 3.11, B1+)
├── gunicorn → Flask app (app.py)
│   ├── /tiles/airport-noise/* → renders noise raster tiles
│   ├── /health → health check
│   └── /* → serves React SPA (static/index.html)
└── static/ → Vite build output (copied during CI)
```

---

## Step 1: Create Azure App Service

```bash
# Create resource group
az group create --name LandRecon-RG --location eastus

# Create App Service Plan (B1 minimum for Python + rasterio)
az appservice plan create \
  --name landrecon-plan \
  --resource-group LandRecon-RG \
  --sku B1 \
  --is-linux

# Create the web app
az webapp create \
  --name landrecon \
  --resource-group LandRecon-RG \
  --plan landrecon-plan \
  --runtime "PYTHON:3.11"

# Set startup command
az webapp config set \
  --name landrecon \
  --resource-group LandRecon-RG \
  --startup-file "gunicorn --bind=0.0.0.0:8000 --timeout 120 --workers 2 app:app"
```

---

## Step 2: Upload Noise Data

The tile server needs GeoTIFF raster files.

**Option A: Direct upload via Kudu**
Upload state raster TIFFs to `/home/site/wwwroot/data/` via the Kudu console or FTP.

**Option B: Mount Azure Blob Storage (recommended for large data)**
```bash
az webapp config storage-account add \
  --name landrecon \
  --resource-group LandRecon-RG \
  --custom-id noise-data \
  --storage-type AzureBlob \
  --account-name <storage-account> \
  --share-name noise-rasters \
  --access-key <key> \
  --mount-path /data

az webapp config appsettings set \
  --name landrecon \
  --resource-group LandRecon-RG \
  --settings TILE_DATA_DIR="/data"
```

---

## Step 3: Configure GitHub Secrets & Variables

In your GitHub repo → Settings → Secrets and variables → Actions:

**Secrets:**
| Name | Value |
|------|-------|
| `AZURE_PUBLISH_PROFILE` | Download from Azure Portal → App Service → Get publish profile |
| `TOMTOM_API_KEY` | Your TomTom API key |

**Variables:**
| Name | Value |
|------|-------|
| `AZURE_APP_NAME` | `landrecon` (or whatever you named it) |

---

## Step 4: Deploy

Push to `main` — GitHub Actions will automatically:
1. Build the React app (`npm run build`)
2. Copy `dist/` into `tile-server/static/`
3. ZIP and deploy to Azure App Service

---

## Local Development

No changes needed — Vite proxies `/tiles` to `localhost:8001` via `vite.config.ts`.
The production Flask app serves the same `/tiles` routes directly.
