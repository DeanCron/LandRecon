#!/bin/sh
# Runtime entrypoint: start both Node sidecars in the background, then
# hand off to nginx as PID 1 so signals still propagate cleanly. If node
# isn't installed or a sidecar fails to start, nginx still serves the
# SPA — the dev todos UI falls back to localStorage and crawler /share
# requests return the static index.html OG tags instead of per-URL ones.
set -e

mkdir -p /var/lib/landrecon /app/server/data
chown -R nginx:nginx /var/lib/landrecon 2>/dev/null || true

# Pull the FCC broadband SQLite index from blob storage if (a) we have a
# URL and (b) the local copy is missing. The file is multi-GB so we do
# NOT bake it into the image; instead the container fetches it on first
# cold start. The download runs in the background so nginx can come up
# immediately — server/broadband.mjs detects the missing file and
# returns degraded (block-only) responses until the download completes
# and the og sidecar is restarted by a future cold start.
if [ -n "$BROADBAND_DB_URL" ] && [ ! -f /app/server/data/broadband.db ]; then
  echo "[entrypoint] downloading broadband.db from $BROADBAND_DB_URL ..."
  (
    # Download to a tmp file then atomically rename so a partial download
    # never gets opened by the sidecar. -L follows blob 30x redirects;
    # --fail makes curl exit non-zero on a 4xx/5xx instead of writing the
    # error body into the .db file.
    if curl -sSL --fail -o /app/server/data/broadband.db.partial "$BROADBAND_DB_URL"; then
      mv /app/server/data/broadband.db.partial /app/server/data/broadband.db
      echo "[entrypoint] broadband.db ready ($(stat -c%s /app/server/data/broadband.db 2>/dev/null || echo '?') bytes)"
      # Touch a sentinel the sidecar polls for; if the og sidecar restarts
      # after this point it'll pick up the index automatically.
      touch /app/server/data/.broadband-ready
    else
      echo "[entrypoint] broadband.db download FAILED (will run in lookup-only mode)"
      rm -f /app/server/data/broadband.db.partial
    fi
  ) &
elif [ -f /app/server/data/broadband.db ]; then
  echo "[entrypoint] broadband.db already present ($(stat -c%s /app/server/data/broadband.db 2>/dev/null || echo '?') bytes)"
fi

# Resolve sharp from the runtime-installed node_modules. Each sidecar
# imports from ./server/*.mjs, so we cd to /app where node_modules lives.
cd /app

if command -v node >/dev/null 2>&1; then
  node /app/server/dev-todos.mjs &
  echo "[entrypoint] dev-todos sidecar started (pid $!)"
  node /app/server/og.mjs &
  echo "[entrypoint] og sidecar started (pid $!)"
else
  echo "[entrypoint] node not found, skipping sidecars"
fi

exec nginx -g 'daemon off;'
