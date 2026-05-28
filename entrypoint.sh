#!/bin/sh
# Runtime entrypoint: start the Dev Todos sidecar in the background, then
# hand off to nginx as PID 1 so signals still propagate cleanly. If node
# isn't installed or the sidecar fails to start, nginx still serves the
# SPA — the dev todos UI just falls back to localStorage on the client.
set -e

mkdir -p /var/lib/landrecon
chown -R nginx:nginx /var/lib/landrecon 2>/dev/null || true

if command -v node >/dev/null 2>&1; then
  node /app/server/dev-todos.mjs &
  echo "[entrypoint] dev-todos sidecar started (pid $!)"
else
  echo "[entrypoint] node not found, skipping dev-todos sidecar"
fi

exec nginx -g 'daemon off;'
