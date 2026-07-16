#!/usr/bin/env bash
# Uploads a single dataset's gzipped snapshot to Azure Blob Storage.
# Used by .github/workflows/snapshot-overpass.yml immediately after each
# snapshot-{name}.mjs script runs, rather than batching every dataset into
# one upload at the very end — that all-or-nothing approach meant a
# job-level timeout (or an Azure Login failure) discarded every dataset
# built earlier in the same run, even ones that finished cleanly.
#
# Usage: upload-snapshot.sh <name>   (e.g. railroad-us, cameras-us)
set -uo pipefail

name="$1"
gz="dist-snapshots/${name}.json.gz"

if [ ! -s "$gz" ]; then
  echo "::warning::${gz} missing or empty — skipping upload (blob keeps prior version, if any)"
  exit 0
fi

blob_name="${name}.json"
echo "→ uploading $gz as snapshots/$blob_name"
az storage blob upload \
  --account-name landreconstorage \
  --container-name snapshots \
  --name "$blob_name" \
  --file "$gz" \
  --content-cache "public, max-age=86400, immutable" \
  --content-encoding "gzip" \
  --content-type "application/json; charset=utf-8" \
  --auth-mode login \
  --overwrite

if [ $? -eq 0 ]; then
  echo "  https://landreconstorage.blob.core.windows.net/snapshots/$blob_name"
else
  echo "::warning::Upload failed for $blob_name — blob keeps prior version, if any"
fi
