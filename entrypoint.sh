#!/bin/sh
# Runtime entrypoint: start both Node sidecars in the background, then
# hand off to nginx as PID 1 so signals still propagate cleanly. If node
# isn't installed or a sidecar fails to start, nginx still serves the
# SPA — the dev todos UI falls back to localStorage and crawler /share
# requests return the static index.html OG tags instead of per-URL ones.
set -e

mkdir -p /var/lib/landrecon
chown -R nginx:nginx /var/lib/landrecon 2>/dev/null || true

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
