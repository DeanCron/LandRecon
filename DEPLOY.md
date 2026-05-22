# Azure Deployment Guide

LandRecon uses two Azure services:
1. **Azure Static Web Apps** — React frontend
2. **Azure App Service (Python)** — Tile server for airport noise rasters

---

## Prerequisites

- Azure CLI installed (`az login`)
- GitHub repo connected to Azure

---

## Step 1: Create Azure Static Web App (Frontend)

```bash
# Via Azure Portal or CLI
az staticwebapp create \
  --name landrecon-frontend \
  --resource-group LandRecon-RG \
  --source https://github.com/DeanCron/LandRecon \
  --branch main \
  --app-location "/" \
  --output-location "dist" \
  --login-with-github
```

After creation, grab the deployment token from the Azure Portal:
- Go to your Static Web App → Manage deployment token
- Add it as a GitHub secret: `AZURE_STATIC_WEB_APPS_API_TOKEN`

---

## Step 2: Create Azure App Service (Tile Server)

```bash
# Create App Service Plan
az appservice plan create \
  --name landrecon-plan \
  --resource-group LandRecon-RG \
  --sku B1 \
  --is-linux

# Create the web app
az webapp create \
  --name landrecon-tiles \
  --resource-group LandRecon-RG \
  --plan landrecon-plan \
  --runtime "PYTHON:3.11"

# Set startup command
az webapp config set \
  --name landrecon-tiles \
  --resource-group LandRecon-RG \
  --startup-file "gunicorn --bind=0.0.0.0:8000 --timeout 120 --workers 2 app:app"

# Configure CORS to allow your static web app
az webapp cors add \
  --name landrecon-tiles \
  --resource-group LandRecon-RG \
  --allowed-origins "https://<your-static-app>.azurestaticapps.net"
```

---

## Step 3: Upload Noise Data

The tile server needs GeoTIFF files. Upload them to the App Service:

```bash
# Using Azure CLI / Kudu ZIP deploy, or mount Azure Blob Storage
az webapp config appsettings set \
  --name landrecon-tiles \
  --resource-group LandRecon-RG \
  --settings TILE_DATA_DIR="/home/site/wwwroot/data"
```

Upload your state raster TIFFs to `/home/site/wwwroot/data/` via Kudu console or FTP.

**Alternative (recommended for large data):** Mount an Azure Blob Storage container:
```bash
az webapp config storage-account add \
  --name landrecon-tiles \
  --resource-group LandRecon-RG \
  --custom-id noise-data \
  --storage-type AzureBlob \
  --account-name <storage-account> \
  --share-name noise-rasters \
  --access-key <key> \
  --mount-path /data
```

Then set `TILE_DATA_DIR=/data`.

---

## Step 4: Configure GitHub Secrets & Variables

In your GitHub repo → Settings → Secrets and variables → Actions:

**Secrets:**
| Name | Value |
|------|-------|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | From Static Web App deployment token |
| `AZURE_TILE_SERVER_PUBLISH_PROFILE` | Download from Azure Portal → App Service → Get publish profile |
| `TOMTOM_API_KEY` | Your TomTom API key |

**Variables:**
| Name | Value |
|------|-------|
| `TILE_SERVER_URL` | `https://landrecon-tiles.azurewebsites.net` |
| `AZURE_TILE_APP_NAME` | `landrecon-tiles` |

---

## Step 5: Deploy

Push to `main` — GitHub Actions will automatically:
1. Build the React app and deploy to Static Web Apps
2. Deploy the tile server to App Service (only when `tile-server/` changes)

---

## Local Development

No changes needed — Vite proxies `/tiles` to `localhost:8001` automatically.
The `VITE_TILE_SERVER_URL` env var is empty in dev (defaults to relative path through proxy).
