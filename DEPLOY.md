# Synology NAS Deployment Guide

LandRecon deploys to a **Synology NAS** using Docker (Container Manager) for the
tile server and Web Station for the React frontend.

---

## Architecture

```
Synology NAS
├── Web Station → serves React SPA (static files from /web/landrecon)
└── Container Manager (Docker)
    └── landrecon-tiles container
        ├── /tiles/airport-noise/* → renders noise raster tiles
        └── /health → health check
```

---

## Step 1: Build the Frontend

On your dev machine:

```bash
cd LandRecon
npm ci
npm run build
```

This produces the `dist/` folder with static files.

---

## Step 2: Deploy Frontend to Web Station

1. **Create a shared folder** or use an existing web folder on your NAS
2. **Copy `dist/` contents** to your NAS:
   ```bash
   # Via SMB/CIFS
   cp -r dist/* //NAS_IP/web/landrecon/

   # Or via SCP
   scp -r dist/* admin@NAS_IP:/volume1/web/landrecon/
   ```
3. **Configure Web Station:**
   - Open Web Station in DSM
   - Go to **Web Service Portal** → Create
   - Set portal type: **Name-based** or **Port-based**
   - Document root: `/volume1/web/landrecon`
   - HTTP backend: **Nginx** (recommended) or Apache

4. **Add Nginx rewrite for SPA routing:**

   Create a custom Nginx config (via Web Station → Script Language Settings → Custom):
   ```nginx
   location / {
       try_files $uri $uri/ /index.html;
   }

   location /tiles/ {
       proxy_pass http://localhost:8001/tiles/;
       proxy_set_header Host $host;
   }
   ```

   This routes `/tiles/*` requests to the Docker tile server and serves the SPA for all other routes.

---

## Step 3: Deploy Tile Server via Container Manager

1. **Build the Docker image** on your dev machine:
   ```bash
   docker build --build-arg VITE_TOMTOM_API_KEY=your-key -t landrecon-tiles .
   docker save landrecon-tiles -o landrecon-tiles.tar
   ```

2. **Import to Synology Container Manager:**
   - Open Container Manager → Image → Add → Add from file
   - Upload `landrecon-tiles.tar`

3. **Create the container:**
   - Image: `landrecon-tiles`
   - Container name: `landrecon-tiles`
   - Port: Map host `8001` → container `8000`
   - Volume mounts:
     | Host path | Container path | Mode |
     |-----------|---------------|------|
     | `/volume1/data/noise-rasters` | `/data` | Read-only |
   - Environment variables:
     | Name | Value |
     |------|-------|
     | `TILE_DATA_DIR` | `/data` |
     | `TILE_CACHE_DIR` | `/app/.tile_cache` |
   - Enable auto-restart

4. **Upload raster data:**
   Copy your GeoTIFF state raster files to `/volume1/data/noise-rasters/` on the NAS.

---

## Step 4: Verify

- Frontend: `http://NAS_IP:PORT/` (or your configured domain)
- Tile server health: `http://NAS_IP:8001/health`
- Test tile: `http://NAS_IP:8001/tiles/airport-noise/14/4500/6100.png`

---

## Updating

**Frontend only** (fast):
```bash
npm run build
scp -r dist/* admin@NAS_IP:/volume1/web/landrecon/
```

**Tile server** (rebuild container):
```bash
docker build -t landrecon-tiles .
docker save landrecon-tiles -o landrecon-tiles.tar
# Upload to Container Manager → Image → re-create container
```

---

## Optional: Auto-deploy Script

Create `deploy.sh` for quick updates:
```bash
#!/bin/bash
NAS_HOST="admin@YOUR_NAS_IP"
WEB_PATH="/volume1/web/landrecon"

echo "Building frontend..."
npm run build

echo "Deploying to NAS..."
scp -r dist/* $NAS_HOST:$WEB_PATH/

echo "Done! Visit http://YOUR_NAS_IP:PORT"
```

---

## Local Development

No changes — Vite proxies `/tiles` to `localhost:8001` via `vite.config.ts`.
Run `python tile_server.py` and `npm run dev` separately.
