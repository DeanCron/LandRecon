# Build stage - compile React frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src/ src/
COPY public/ public/
ARG VITE_TOMTOM_API_KEY
ENV VITE_TOMTOM_API_KEY=$VITE_TOMTOM_API_KEY
RUN npm run build

# Runtime stage - Python with GDAL/rasterio + Flask serving everything
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.4 AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY tile-server/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY tile-server/app.py .
COPY --from=frontend-build /app/dist ./static

ENV STATIC_DIR=/app/static
ENV TILE_DATA_DIR=/data
ENV TILE_CACHE_DIR=/app/.tile_cache

EXPOSE 8000

CMD ["gunicorn", "--bind=0.0.0.0:8000", "--timeout=120", "--workers=2", "app:app"]
