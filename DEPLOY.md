# Azure Deployment Guide

LandRecon deploys as a **Docker container on Azure Container Apps** — a single
container serves both the React frontend and the tile server API.

---

## Architecture

```
Azure Container Apps
└── Docker container (GDAL + Python 3.11)
    └── gunicorn → Flask app (app.py)
        ├── /tiles/airport-noise/* → renders noise raster tiles
        ├── /health → health check
        └── /* → serves React SPA (static/index.html)
```

---

## Local Docker Testing

```bash
# Build
docker build --build-arg VITE_TOMTOM_API_KEY=your-key -t landrecon .

# Run (mount your local raster data)
docker run -p 8000:8000 -v C:\Temp\CONUS_aviation_noise_2020\State_rasters:/data landrecon
```

Visit http://localhost:8000

---

## Step 1: Create Azure Resources

```bash
# Create resource group
az group create --name LandRecon-RG --location eastus

# Create Container Apps environment
az containerapp env create \
  --name landrecon-env \
  --resource-group LandRecon-RG \
  --location eastus

# Create the container app
az containerapp create \
  --name landrecon \
  --resource-group LandRecon-RG \
  --environment landrecon-env \
  --image ghcr.io/deancron/landrecon:latest \
  --target-port 8000 \
  --ingress external \
  --cpu 1 --memory 2Gi \
  --min-replicas 0 \
  --max-replicas 3 \
  --env-vars TILE_DATA_DIR=/data
```

---

## Step 2: Noise Raster Data

Mount an Azure Files share with your GeoTIFF data:

```bash
# Create storage account + file share
az storage account create --name landreconstorage --resource-group LandRecon-RG --sku Standard_LRS
az storage share create --name noise-rasters --account-name landreconstorage

# Upload raster files
az storage file upload-batch --destination noise-rasters --source ./State_rasters --account-name landreconstorage

# Add storage mount to Container Apps environment
az containerapp env storage set \
  --name landrecon-env \
  --resource-group LandRecon-RG \
  --storage-name noisestorage \
  --azure-file-account-name landreconstorage \
  --azure-file-account-key <key> \
  --azure-file-share-name noise-rasters \
  --access-mode ReadOnly

# Mount in the container app
az containerapp update \
  --name landrecon \
  --resource-group LandRecon-RG \
  --set-env-vars TILE_DATA_DIR=/data \
  --container-name landrecon \
  --revision-suffix v2
```

---

## Step 3: Configure GitHub Secrets & Variables

In GitHub repo → Settings → Secrets and variables → Actions:

**Secrets:**
| Name | Value |
|------|-------|
| `AZURE_CREDENTIALS` | Service principal JSON (`az ad sp create-for-rbac --sdk-auth`) |
| `TOMTOM_API_KEY` | Your TomTom API key |

**Variables:**
| Name | Value |
|------|-------|
| `AZURE_CONTAINER_APP_NAME` | `landrecon` |
| `AZURE_RESOURCE_GROUP` | `LandRecon-RG` |

---

## Step 4: Deploy

Push to `main` — GitHub Actions will:
1. Build the Docker image (multi-stage: Node frontend + Python/GDAL runtime)
2. Push to GitHub Container Registry (ghcr.io)
3. Deploy new revision to Azure Container Apps

---

## Scaling

Container Apps auto-scales based on HTTP traffic:
- `min-replicas: 0` — scales to zero when idle (cost savings)
- `max-replicas: 3` — handles traffic spikes
- Adjust CPU/memory for heavier raster workloads

---

## Local Development (no Docker)

Still works the same — Vite proxies `/tiles` to `localhost:8001` via `vite.config.ts`.
Run `python tile_server.py` and `npm run dev` separately.
