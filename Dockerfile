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
ARG VITE_NOISE_PMTILES_URL
ENV VITE_NOISE_PMTILES_URL=$VITE_NOISE_PMTILES_URL
RUN npm run build

# Runtime stage - pure static SPA on nginx. The Flask + GDAL tile server
# was retired once airport noise moved to PMTiles served from blob storage.
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html

EXPOSE 8000

# `nginx -g 'daemon off;'` is the default CMD of the base image; no override
# needed. Health check hits the SPA root to confirm the server is up.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8000/ > /dev/null || exit 1

