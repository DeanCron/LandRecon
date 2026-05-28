# syntax=docker/dockerfile:1.6

# Build stage - compile React frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src/ src/
COPY public/ public/
ARG VITE_NOISE_PMTILES_URL
ENV VITE_NOISE_PMTILES_URL=$VITE_NOISE_PMTILES_URL
ARG BUILD_GIT_HASH
ENV BUILD_GIT_HASH=$BUILD_GIT_HASH

# Vite needs these as env vars at build time, but we don't want them
# in image layers or `docker history`. BuildKit secrets are mounted
# only for the duration of this single RUN — they never persist into
# the final image. The `|| true` fallbacks let local builds without
# secrets still produce a working image (with empty keys).
RUN --mount=type=secret,id=VITE_TOMTOM_API_KEY \
    --mount=type=secret,id=VITE_GOOGLE_MAPS_KEY \
    VITE_TOMTOM_API_KEY="$(cat /run/secrets/VITE_TOMTOM_API_KEY 2>/dev/null || true)" \
    VITE_GOOGLE_MAPS_KEY="$(cat /run/secrets/VITE_GOOGLE_MAPS_KEY 2>/dev/null || true)" \
    npm run build

# Runtime stage - pure static SPA on nginx, with a tiny Node sidecar for
# the Dev Todos JSON endpoint. The Flask + GDAL tile server was retired
# once airport noise moved to PMTiles served from blob storage.
FROM nginx:1.27-alpine AS runtime
RUN apk add --no-cache nodejs
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
COPY server/ /app/server/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /var/lib/landrecon \
    && chown -R nginx:nginx /var/lib/landrecon

EXPOSE 8000

# Health check hits the SPA root to confirm nginx is up. The sidecar runs
# in the background; if it dies the dev-todos endpoint will 502 but the
# SPA still works (and the dev todos modal falls back to localStorage).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8000/ > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]

