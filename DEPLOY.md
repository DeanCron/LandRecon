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
  --build-arg VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX \
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

# Container app — static SPA + sidecars. A volume mount is only needed if
# you want a shared, durable Dev Todos store (see "Dev Todos store
# persistence" below); the SPA itself is stateless.
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

## Security Configuration (required)

These are operational settings that the code can't enforce on its own:

### Restrict the TomTom (and Google) API keys

`VITE_*` keys are compiled into the client JS bundle by design and are
therefore **public** — anyone can read them from the production bundle. Their
only protection is a provider-side referrer/domain restriction:

- **TomTom** → Developer Portal → your key → restrict to the production
  domain(s) (e.g. `https://<your-app>.azurecontainerapps.io/*` and any custom
  domain). Without this, a lifted key burns your quota/billing.
- **Google Maps Platform** → restrict the key to the same HTTP referrers and
  to only the APIs actually used (Map Tiles + Places).

Set per-key quotas + billing alerts as a backstop.

### Dev Todos store token (`DEV_TODOS_TOKEN`)

The Dev Todos endpoint (`/api/dev-todos`) is gated by a bearer token:

- If `DEV_TODOS_TOKEN` is **unset**, the store is disabled (GET/PUT → 503) and
  the UI silently falls back to per-browser localStorage. This is the safe
  default — leave it unset unless you want the shared server store.
- If set, supply the same value in the browser once per device:
  `localStorage.setItem('lr_dev_todos_token', '<token>')`. The token lives only
  in localStorage, never in the bundle.

Configure it as a Container Apps secret/env var:

```bash
az containerapp update \
  --name landrecon --resource-group LandRecon-RG \
  --set-env-vars DEV_TODOS_TOKEN=secretref:dev-todos-token
```

### Dev Todos store persistence (`/var/lib/landrecon`)

The Dev Todos sidecar persists a single JSON document to local disk at
`/var/lib/landrecon/dev-todos.json` (overridable via `DEV_TODOS_DATA_PATH`).
**Local disk on Container Apps is ephemeral and per-replica**, so with the
default `--min-replicas 0 --max-replicas 3` the store is **not durable or
shared**:

- **Multiple replicas** don't share a filesystem — a `PUT` that lands on one
  replica won't be visible to a `GET` routed to another, so edits appear to
  "not save."
- **Scale-to-zero** (`min-replicas 0`) recycles the container when idle, which
  **wipes the file entirely.**

For a shared, durable store, mount an **Azure Files** share at
`/var/lib/landrecon` so every replica reads/writes the same file and it
survives scale-to-zero and restarts. No code change is required — the sidecar
already defaults to that path.

```bash
# 1. Storage account + file share
az storage account create \
  --name landrecondevtodos --resource-group LandRecon-RG \
  --location eastus --sku Standard_LRS --kind StorageV2
KEY=$(az storage account keys list \
  --account-name landrecondevtodos --resource-group LandRecon-RG \
  --query "[0].value" -o tsv)
az storage share-rm create \
  --name dev-todos --storage-account landrecondevtodos --quota 1

# 2. Register the share with the Container Apps environment
az containerapp env storage set \
  --name landrecon-env --resource-group LandRecon-RG \
  --storage-name devtodosstore \
  --azure-file-account-name landrecondevtodos \
  --azure-file-account-key "$KEY" \
  --azure-file-share-name dev-todos \
  --access-mode ReadWrite

# 3. Mount it into the app at /var/lib/landrecon. Container Apps applies
#    volume mounts via a YAML patch, so export the current template, add the
#    volume + volumeMount, and re-apply:
az containerapp show --name landrecon --resource-group LandRecon-RG \
  --output yaml > app.yaml
# Under properties.template, add:
#   volumes:
#     - name: dev-todos-vol
#       storageType: AzureFile
#       storageName: devtodosstore
# and under the container entry add:
#   volumeMounts:
#     - volumeName: dev-todos-vol
#       mountPath: /var/lib/landrecon
az containerapp update --name landrecon --resource-group LandRecon-RG \
  --yaml app.yaml
```

> Note: the `nginx` user inside the container must be able to write the mount.
> `entrypoint.sh` already `chown`s `/var/lib/landrecon` to `nginx:nginx` on
> start, which works with the default Azure Files `0777`/uid mapping.
>
> Alternatively, if you don't need history across restarts and just want
> consistent reads within a session, pin `--min-replicas 1 --max-replicas 1`
> — but the volume mount above is the durable fix.

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
| `GA_MEASUREMENT_ID` | Optional. Google Analytics 4 Measurement ID (`G-XXXXXXXXXX`). Leave blank to disable analytics — the gtag script will not be loaded and no events will be sent. |

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

> ⚠️ These settings make the local-disk **Dev Todos store** non-durable and
> per-replica. If you use the shared server store, mount an Azure Files volume
> at `/var/lib/landrecon` (see "Dev Todos store persistence" above).

---

## Local Development (no Docker)

```bash
npm install
npm run dev
```

Vite serves `public/data/airport-noise.pmtiles` directly with native HTTP
range support — no proxy or backend required.
